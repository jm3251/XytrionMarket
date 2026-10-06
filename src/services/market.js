'use strict';

const { config } = require('../config');
const assets = require('./market-assets.json');

const tracked = new Set(assets.map((asset) => asset.symbol));
const COINGECKO_INTERVAL_MS = 120000;
let krakenQuotes = null;
let krakenTime = 0;
let krakenPairs = null;
let coinGeckoQuotes = null;
let coinGeckoTime = 0;
let coinGeckoAttempt = 0;
let inFlight = null;

function validPositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function quoteFromTicker(ticker, symbol) {
  const price = validPositive(ticker && ticker.c && ticker.c[0]);
  if (!price || (ticker.t && Number(ticker.t[1]) === 0)) throw new Error(`Invalid ${symbol} ticker.`);
  const open = validPositive(ticker && ticker.o);
  const volume = validPositive(ticker && ticker.v && ticker.v[1]);
  return {
    symbol, price, change24h: open ? ((price - open) / open) * 100 : null,
    change: open ? price - open : null,
    volumeUsd: volume ? volume * price : null,
    changePeriod: 'since UTC open', source: 'Kraken'
  };
}

function normalize(data) {
  if (!data || !Array.isArray(data.error) || data.error.length || !data.result || typeof data.result !== 'object') {
    throw new Error('Market provider returned an invalid response.');
  }
  const quotes = {};
  for (const [key, ticker] of Object.entries(data.result)) {
    // assetVersion=1 returns display pairs. Legacy internal pair keys are kept
    // for compatibility with existing integrations and test fixtures.
    const display = /^([A-Z0-9_-]+)\/USD$/i.exec(key);
    const symbol = display ? (display[1].toUpperCase() === 'XBT' ? 'BTC' : display[1].toUpperCase())
      : /^XXBTZUSD$/i.test(key) ? 'BTC' : /^XETHZUSD$/i.test(key) ? 'ETH' : null;
    if (!symbol || !tracked.has(symbol)) continue;
    try { quotes[symbol] = quoteFromTicker(ticker, symbol); } catch { /* Ignore a non-trading market, not the whole batch. */ }
  }
  if (!quotes.BTC || !quotes.ETH) throw new Error('Market provider did not return both BTC and ETH.');
  return quotes;
}

function imageId(url) {
  const match = /\/coins\/images\/(\d+)\//.exec(String(url || ''));
  return match ? match[1] : null;
}

function normalizeCoinGecko(markets, now = Date.now()) {
  if (!Array.isArray(markets)) throw new Error('CoinGecko returned an invalid response.');
  const byImage = new Map();
  const bySymbol = new Map();
  for (const market of markets) {
    if (!market || typeof market !== 'object') continue;
    const id = imageId(market.image);
    if (id) byImage.set(id, market);
    const symbol = String(market.symbol || '').toUpperCase();
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
    bySymbol.get(symbol).push(market);
  }
  const quotes = {};
  for (const asset of assets) {
    let market = asset.imageId ? byImage.get(asset.imageId) : null;
    // Without a known coin-image identity, accept only an unambiguous symbol.
    if (!asset.imageId) {
      const matches = bySymbol.get(asset.symbol) || [];
      if (matches.length === 1) market = matches[0];
    }
    if (!market) continue;
    const price = validPositive(market.current_price);
    const updatedAt = Date.parse(market.last_updated);
    if (!price || !Number.isFinite(updatedAt) || now - updatedAt > config.market.staleMs || updatedAt > now + 120000) continue;
    const change24h = market.price_change_percentage_24h == null ? null : Number(market.price_change_percentage_24h);
    const change = Number.isFinite(change24h) && change24h > -100 ? price - price / (1 + change24h / 100) : null;
    quotes[asset.symbol] = {
      symbol: asset.symbol, price,
      change24h: Number.isFinite(change24h) ? change24h : null,
      change, volumeUsd: validPositive(market.total_volume),
      changePeriod: '24h', source: 'CoinGecko', lastUpdatedAt: new Date(updatedAt).toISOString()
    };
  }
  return quotes;
}

async function requestJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'xytrion-market/2.0' }, signal: controller.signal });
    if (!response.ok) throw new Error(`Market provider HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshKraken(force, now) {
  if (!force && krakenQuotes && now - krakenTime < config.market.cacheMs) return;
  let url = `${config.market.baseUrl}/Ticker?assetVersion=1`;
  if (krakenPairs && krakenPairs.length) url += `&pair=${encodeURIComponent(krakenPairs.join(','))}`;
  try {
    const data = await requestJson(url);
    const quotes = normalize(data);
    krakenPairs = Object.keys(data.result).filter((key) => {
      const match = /^([A-Z0-9_-]+)\/USD$/i.exec(key);
      return match && tracked.has(match[1].toUpperCase());
    });
    krakenQuotes = quotes;
    krakenTime = Date.now();
  } catch (error) {
    // If a market was delisted, rediscover available pairs on the next refresh.
    krakenPairs = null;
    throw error;
  }
}

async function refreshCoinGecko(force, now) {
  if (!force && now - coinGeckoAttempt < COINGECKO_INTERVAL_MS) return;
  coinGeckoAttempt = now;
  const url = `${config.market.coinGeckoUrl}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false`;
  const supplementalIds = assets.map((asset) => asset.coinGeckoId).filter(Boolean);
  const supplementalUrl = `${config.market.coinGeckoUrl}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(supplementalIds.join(','))}&per_page=250&page=1&sparkline=false`;
  const results = await Promise.allSettled([requestJson(url), requestJson(supplementalUrl)]);
  const markets = results.filter((result) => result.status === 'fulfilled' && Array.isArray(result.value)).flatMap((result) => result.value);
  const quotes = normalizeCoinGecko(markets);
  if (!Object.keys(quotes).length) throw new Error('CoinGecko returned no current listed prices.');
  coinGeckoQuotes = quotes;
  coinGeckoTime = Date.now();
}

async function fetchProviders(force) {
  const now = Date.now();
  await Promise.allSettled([refreshKraken(force, now), refreshCoinGecko(force, now)]);
  const current = Date.now();
  const quotes = {};
  const sources = new Set();
  const useGecko = coinGeckoQuotes && current - coinGeckoTime <= config.market.staleMs;
  const useKraken = krakenQuotes && current - krakenTime <= config.market.staleMs;
  if (useGecko) {
    for (const [symbol, quote] of Object.entries(coinGeckoQuotes)) {
      const quoteTime = Date.parse(quote.lastUpdatedAt);
      if (current - quoteTime <= config.market.staleMs) {
        quotes[symbol] = { ...quote, stale: current - quoteTime > Math.max(config.market.cacheMs * 4, 120000) };
        sources.add('CoinGecko');
      }
    }
  }
  if (useKraken) {
    for (const [symbol, quote] of Object.entries(krakenQuotes)) {
      quotes[symbol] = { ...quote, stale: current - krakenTime > Math.max(config.market.cacheMs * 4, 120000), lastUpdatedAt: new Date(krakenTime).toISOString() };
      sources.add('Kraken');
    }
  }
  if (!quotes.BTC || !quotes.ETH) {
    return { quotes: null, source: null, fetchedAt: null, stale: false, available: false, error: 'Market prices are temporarily unavailable. Check the server market-provider connection.' };
  }
  const mainTime = Math.min(Date.parse(quotes.BTC.lastUpdatedAt), Date.parse(quotes.ETH.lastUpdatedAt));
  return {
    quotes, source: Array.from(sources).join(' + '), fetchedAt: new Date(mainTime).toISOString(),
    stale: quotes.BTC.stale || quotes.ETH.stale, available: true,
    ...(quotes.BTC.stale || quotes.ETH.stale ? { warning: 'Showing the most recently verified quotes while refreshing the market feed.' } : {})
  };
}

async function getMarketPrices({ force = false } = {}) {
  if (!inFlight) inFlight = fetchProviders(force).finally(() => { inFlight = null; });
  return inFlight;
}

function resetMarketCache() {
  krakenQuotes = null; krakenTime = 0; krakenPairs = null;
  coinGeckoQuotes = null; coinGeckoTime = 0; coinGeckoAttempt = 0; inFlight = null;
}

module.exports = { getMarketPrices, resetMarketCache, normalize, normalizeCoinGecko };
