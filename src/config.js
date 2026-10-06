'use strict';

const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function origin(value) {
  try { return new URL(String(value || 'http://localhost:3000')).origin; }
  catch { return 'http://localhost:3000'; }
}

const adminChatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '').trim();
const explicitAdminIds = csv(process.env.TELEGRAM_ADMIN_USER_IDS);

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  appOrigin: origin(process.env.APP_ORIGIN),
  sessionSecret: process.env.SESSION_SECRET || (process.env.NODE_ENV === 'test' ? 'test-session-secret-at-least-32-characters' : ''),
  mongoUri: process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL || '',
  market: {
    baseUrl: (process.env.MARKET_API_BASE || 'https://api.kraken.com/0/public').replace(/\/$/, ''),
    coinGeckoUrl: (process.env.COINGECKO_API_BASE || 'https://api.coingecko.com/api/v3').replace(/\/$/, ''),
    cacheMs: positiveInt(process.env.MARKET_CACHE_SECONDS, 30) * 1000,
    staleMs: Math.max(30, Number(process.env.MARKET_STALE_SECONDS || 300)) * 1000
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '',
    adminChatId,
    adminUserIds: new Set(explicitAdminIds.length ? explicitAdminIds : (adminChatId ? [adminChatId] : [])),
    pollingEnabled: String(process.env.TELEGRAM_POLLING_ENABLED || '').toLowerCase() === 'true',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || ''
  },
  email: {
    host: String(process.env.SMTP_HOST || '').trim(),
    port: positiveInt(process.env.SMTP_PORT, 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    user: String(process.env.SMTP_USER || '').trim(),
    pass: process.env.SMTP_PASS || '',
    from: String(process.env.SMTP_FROM || '').trim()
  },
  uploads: {
    maxBytes: Math.max(1024, Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024))
  },
  wallets: {
    USDT: {
      asset: 'USDT',
      network: 'TRC20',
      address: process.env.USDT_TRC20_ADDRESS || 'TQiZD8zedxCLZYZXXtx4v6M7biQuzypGFp'
    },
    BTC: {
      asset: 'BTC',
      network: 'Bitcoin',
      address: process.env.BTC_BITCOIN_ADDRESS || 'bc1qvyumeqtwp0xl4mg8lq0z0wsvmgp76f80ensuxw'
    }
  }
};

function assertProductionConfig() {
  const missing = [];
  if (!config.mongoUri) missing.push('MONGODB_URI');
  if (!config.sessionSecret || config.sessionSecret.length < 32) missing.push('SESSION_SECRET (minimum 32 characters)');
  if (config.telegram.pollingEnabled && !config.telegram.token) missing.push('TELEGRAM_BOT_TOKEN (required when polling is enabled)');
  if (config.telegram.pollingEnabled && !config.telegram.adminChatId) missing.push('TELEGRAM_ADMIN_CHAT_ID (required when polling is enabled)');
  const emailValues = [config.email.host, config.email.user, config.email.pass, config.email.from];
  if (emailValues.some(Boolean) && !emailValues.every(Boolean)) missing.push('SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM (all required for email delivery)');
  if (config.email.host && config.email.port === 465 && !config.email.secure) missing.push('SMTP_SECURE=true (required for port 465)');
  if (missing.length) throw new Error(`Missing required environment configuration: ${missing.join(', ')}`);
}

module.exports = { config, assertProductionConfig };
