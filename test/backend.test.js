'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters';
process.env.TELEGRAM_BOT_TOKEN = 'test-token-not-a-real-secret';
process.env.TELEGRAM_ADMIN_CHAT_ID = '9001';
process.env.TELEGRAM_ADMIN_USER_IDS = '42';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { connectDatabase, disconnectDatabase, mongoose } = require('../src/db');
const { createApp } = require('../src/app');
const { User, LedgerEntry, Deposit, Withdrawal, BotConversation, AdminFundAction, Investment, Notification, EmailDelivery } = require('../src/models');
const { createAdminFund, reverseAdminFund } = require('../src/services/balance');
const { createTelegramService } = require('../src/services/telegram');
const { normalize, normalizeCoinGecko, getMarketPrices, resetMarketCache } = require('../src/services/market');
const { createEmailWorker } = require('../src/services/email');

let repl;
let app;
const telegramStub = {
  notify: async () => ({ delivered: true }), notifyDeposit: async () => ({ delivered: true }),
  notifyWithdrawal: async () => ({ delivered: true }), notifyKyc: async () => ({ delivered: true }),
  notifyChat: async () => ({ delivered: true }), processUpdate: async () => {}
};

async function register(agent, suffix = '') {
  return agent.post('/api/auth/register').send({
    username: `trader${suffix}`, name: 'Test Trader', email: `trader${suffix}@example.com`,
    phone: '+1 555 0100', country: 'United States of America', password: 'Strong!Pass'
  });
}

test.before(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await connectDatabase(repl.getUri());
  app = createApp({ sessionStore: new session.MemoryStore(), telegramService: telegramStub });
});

test.after(async () => { await disconnectDatabase(); await repl.stop(); });
test.beforeEach(async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

test('API health confirms both the Node API and MongoDB are online', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, api: 'online', database: 'connected' });
});

test('Account Statement navigation does not revoke a valid server session', async () => {
  const agent = request.agent(app);
  assert.equal((await request(app).get('/dashboard/accounthistory.html')).status, 302);
  assert.equal((await register(agent, 'statement')).status, 201);
  const statement = await agent.get('/dashboard/accounthistory.html');
  assert.equal(statement.status, 200);
  assert.match(statement.text, /window\.addEventListener\('xytrion:user'/);
  assert.doesNotMatch(statement.text, /window\.location\.replace\('\.\.\/login\.html'\)/);
  assert.equal((await agent.get('/api/auth/me')).status, 200);
  assert.equal((await agent.get('/api/transactions')).status, 200);
});

test('every sidebar destination remains accessible without consuming the login rate limit', async () => {
  const agent = request.agent(app);
  assert.equal((await register(agent, 'sidebar')).status, 201);
  const root = path.resolve(__dirname, '..');
  const pages = ['dashboard.html', 'kyc-form.html', 'verify-account.html',
    ...fs.readdirSync(path.join(root, 'dashboard')).filter((name) => name.endsWith('.html')).map((name) => `dashboard/${name}`)];
  for (const page of pages) {
    const response = await agent.get(`/${page}`);
    assert.equal(response.status, 200, `${page} must keep the login session`);
    const links = Array.from(response.text.matchAll(/<a\b[^>]*\bhref=["']([^"']+\.html)(?:\?[^"']*)?["']/gi), (match) => match[1]);
    for (const href of links) {
      if (/^(?:https?:|\/\/)/i.test(href)) continue;
      const target = href.startsWith('/') ? path.join(root, href) : path.resolve(root, path.dirname(page), href);
      assert.equal(fs.existsSync(target), true, `${page} links to missing page ${href}`);
    }
    const destinations = {
      Dashboard: '/dashboard.html', 'Account Statement': '/dashboard/accounthistory.html',
      'Performance History': '/dashboard/tradinghistory.html', 'AI Trading Bots': '/dashboard/bot-trading.html',
      'Premium Signals': '/dashboard/signal.html', 'Deposit Funds': '/dashboard/deposits.html',
      'Withdraw Funds': '/dashboard/withdrawals.html', 'Profile Settings': '/dashboard/account-settings.html',
      'Support Center': '/dashboard/support.html', 'Verify Now': '/kyc-form.html'
    };
    for (const match of response.text.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const label = match[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      for (const [prefix, destination] of Object.entries(destinations)) {
        if (label === prefix || (label.startsWith(`${prefix} `) && ['AI Trading Bots', 'Premium Signals', 'Support Center'].includes(prefix))) {
          assert.equal(match[1], destination, `${page}: ${prefix} must point to ${destination}`);
          break;
        }
      }
    }
    assert.equal((await agent.get('/api/auth/me')).status, 200, `${page} must not log the user out`);
  }
  for (let i = 0; i < 90; i += 1) {
    const response = await agent.get('/api/auth/me');
    assert.equal(response.status, 200, `authenticated refresh ${i} must succeed`);
    assert.equal(response.headers['ratelimit-limit'], undefined);
  }
});

test('original AI bot plans create, accrue, and mature one server-backed investment', async () => {
  const agent = request.agent(app);
  const registered = await register(agent, 'bot');
  assert.equal(registered.status, 201);
  const userId = registered.body.user.id;
  await createAdminFund({ userId, amountCents: 60000, actorTelegramId: '42', source: 'command', sessionId: 'ACT-TEST-BOT' });
  const initial = await agent.get('/api/investments');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.plans.map((plan) => plan.id), ['starter-3d', 'momentum-5d', 'volatility-7d', 'bond-7d', 'equities-10d']);
  assert.equal(initial.body.plans[0].durationDays, 3);
  assert.equal(initial.body.plans[0].minDailyPct, 18);
  assert.equal(initial.body.plans[0].maxDailyPct, 30);
  assert.equal((await agent.post('/api/investments').send({ planId: 'starter-3d', amount: 10 })).status, 400);
  const started = await agent.post('/api/investments').send({ planId: 'starter-3d', amount: 100 });
  assert.equal(started.status, 201);
  assert.equal(started.body.investment.status, 'active');
  assert.equal((await agent.get('/api/auth/me')).body.user.balance, 505);
  assert.equal((await agent.post('/api/investments').send({ planId: 'starter-3d', amount: 100 })).status, 409);
  const record = await Investment.findOne({ user: userId });
  record.startTime = new Date(Date.now() - 86400000 - 10000);
  await record.save();
  const dayOne = await agent.get('/api/investments');
  assert.equal(dayOne.body.investments[0].dailyProfits.length, 1);
  assert.equal(dayOne.body.investments[0].status, 'active');
  assert.equal(dayOne.body.investments[0].totalProfit > 0, true);
  record.startTime = new Date(Date.now() - 3 * 86400000 - 10000);
  await record.save();
  const matured = await agent.get('/api/investments');
  assert.equal(matured.body.investments[0].dailyProfits.length, 3);
  assert.equal(matured.body.investments[0].status, 'completed');
  assert.equal(matured.body.investments[0].payoutCredited, true);
  const balance = (await agent.get('/api/auth/me')).body.user.balance;
  assert.equal(Math.round(balance * 100), 60500 + Math.round(matured.body.investments[0].totalProfit * 100));
  assert.equal((await agent.get('/api/investments')).body.investments[0].totalProfit, matured.body.investments[0].totalProfit);
  assert.equal((await agent.get('/api/auth/me')).body.user.balance, balance);
  assert.equal(await LedgerEntry.countDocuments({ user: userId, type: 'investment_payout' }), 1);
});

test('password policy reports the exact missing requirement and auth is server-session based', async () => {
  const agent = request.agent(app);
  const invalid = [
    ['Short!', /8 characters/i],
    ['lowercase!', /uppercase/i],
    ['UPPERCASE!', /lowercase/i],
    ['NoSpecial1', /special/i]
  ];
  for (let index = 0; index < invalid.length; index += 1) {
    const [password, expected] = invalid[index];
    const weak = await agent.post('/api/auth/register').send({ username: `weakuser${index}`, name: 'Weak User', email: `weak${index}@example.com`, country: 'US', password });
    assert.equal(weak.status, 400);
    assert.match(weak.body.error, expected);
  }

  const created = await register(agent, 'auth');
  assert.equal(created.status, 201);
  assert.equal(created.body.user.balance, 5);
  assert.equal('password' in created.body.user, false);
  const stored = await User.findOne({ emailNormalized: 'traderauth@example.com' }).select('+passwordHash');
  assert.notEqual(stored.passwordHash, 'Strong!Pass');
  assert.equal(await bcrypt.compare('Strong!Pass', stored.passwordHash), true);

  const me = await agent.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'traderauth@example.com');
  assert.equal((await request(app).get('/dashboard.html')).status, 302);
  assert.equal((await agent.get('/dashboard.html')).status, 200);

  assert.equal((await agent.post('/api/auth/logout')).status, 200);
  assert.equal((await agent.get('/api/auth/me')).status, 401);
  const invalidLogin = await request(app).post('/api/auth/login').send({ identifier: 'traderauth@example.com', password: 'Wrong!Pass' });
  assert.equal(invalidLogin.status, 401);
});

test('duplicate identifiers are rejected and account deletion revokes access and redacts identity', async () => {
  const first = request.agent(app); const second = request.agent(app);
  assert.equal((await register(first, 'dup')).status, 201);
  const duplicate = await second.post('/api/auth/register').send({ username: 'otheruser', name: 'Other', email: 'TRADERDUP@example.com', country: 'US', password: 'Strong!Pass' });
  assert.equal(duplicate.status, 409);

  const deleted = await first.delete('/api/account').send({ password: 'Strong!Pass', confirmation: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal((await first.get('/api/auth/me')).status, 401);
  const user = await User.findOne({ status: 'deleted' }).select('+passwordHash');
  assert.match(user.email, /^deleted-/);
  assert.equal(user.name, 'Deleted User');
  assert.equal((await request(app).post('/api/auth/login').send({ identifier: 'traderdup@example.com', password: 'Strong!Pass' })).status, 401);
});

test('account deletion ignores supplied user IDs and can only delete the authenticated account', async () => {
  const first = request.agent(app); const second = request.agent(app);
  const firstResult = await register(first, 'owner'); const secondResult = await register(second, 'attacker');
  const attempt = await second.delete('/api/account').send({ userId: firstResult.body.user.id, password: 'Strong!Pass', confirmation: 'DELETE' });
  assert.equal(attempt.status, 200);
  assert.equal((await User.findById(firstResult.body.user.id)).status, 'active');
  assert.equal((await User.findById(secondResult.body.user.id)).status, 'deleted');
});

test('wallet endpoint exposes configured TRC20 and Bitcoin destinations and valid proof creates a persistent deposit', async () => {
  const agent = request.agent(app); await register(agent, 'wallet');
  const wallets = await agent.get('/api/config/deposit-wallets');
  assert.equal(wallets.status, 200);
  assert.equal(wallets.body.wallets.USDT.network, 'TRC20');
  assert.equal(wallets.body.wallets.USDT.address, 'TQiZD8zedxCLZYZXXtx4v6M7biQuzypGFp');
  assert.equal(wallets.body.wallets.BTC.network, 'Bitcoin');
  assert.equal(wallets.body.wallets.BTC.address, 'bc1qvyumeqtwp0xl4mg8lq0z0wsvmgp76f80ensuxw');

  const selection = await agent.get('/dashboard/deposits.html');
  const payment = await agent.get('/dashboard/payment.html?amount=100&method=Bitcoin');
  assert.equal(selection.status, 200);
  assert.match(selection.text, /<option value="USDT">USDT \(TRC20\)<\/option>/);
  assert.match(selection.text, /<option value="Bitcoin">BTC \(Bitcoin\)<\/option>/);
  assert.equal(payment.status, 200);
  assert.match(payment.text, /data-deposit-network>TRC20<\/span>/);
  assert.match(payment.text, /asset === 'BTC' \? 'Bitcoin' : 'TRC20'/);

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const deposit = await agent.post('/api/deposits').field('amount', '125.25').field('method', 'USDT').attach('proof', png, { filename: 'proof.png', contentType: 'image/png' });
  assert.equal(deposit.status, 201);
  assert.equal(deposit.body.transaction.amount, 125.25);
  assert.equal(await Deposit.countDocuments(), 1);
});

test('atomic admin funding is idempotent and RESET creates a compensating ledger entry', async () => {
  const user = await User.create({ username: 'ledger', usernameNormalized: 'ledger', email: 'ledger@example.com', emailNormalized: 'ledger@example.com', passwordHash: 'not-used', name: 'Ledger User' });
  const first = await createAdminFund({ userId: user._id, amountCents: 2500, actorTelegramId: '42', source: 'command', sessionId: 'ACT-TEST-1' });
  const replay = await createAdminFund({ userId: user._id, amountCents: 2500, actorTelegramId: '42', source: 'command', sessionId: 'ACT-TEST-1' });
  assert.equal(first.balanceCents, 3000); assert.equal(replay.replayed, true);
  assert.equal((await User.findById(user._id)).balanceCents, 3000);
  assert.equal(await LedgerEntry.countDocuments({ user: user._id }), 1);

  const reversed = await reverseAdminFund({ action: first.action, actorTelegramId: '42' });
  assert.equal(reversed.balanceCents, 500);
  assert.equal(await LedgerEntry.countDocuments({ user: user._id }), 2);
  const replayReset = await reverseAdminFund({ action: first.action, actorTelegramId: '42' });
  assert.equal(replayReset.replayed, true);
});

test('Telegram actions accept only the configured admin user and chat', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; };
  const service = createTelegramService({ fetchImpl: fakeFetch });
  assert.equal(service.isAdmin({ message: { from: { id: 42 }, chat: { id: 9001 } } }), true);
  assert.equal(service.isAdmin({ message: { from: { id: 7 }, chat: { id: 9001 } } }), false);
  assert.equal(service.isAdmin({ message: { from: { id: 42 }, chat: { id: 7777 } } }), false);

  const user = await User.create({ username: 'tguser', usernameNormalized: 'tguser', email: 'tg@example.com', emailNormalized: 'tg@example.com', passwordHash: 'unused', name: 'TG User' });
  const dep = await Deposit.create({ publicId: 'DEP-AUTH-1', user: user._id, amountCents: 1000, asset: 'USDT', network: 'TRC20', address: 'TQiZD8zedxCLZYZXXtx4v6M7biQuzypGFp', sessionId: 'SES-AUTH-1' });
  await service.processUpdate({ update_id: 1, callback_query: { id: 'bad', from: { id: 7 }, message: { chat: { id: 9001 } }, data: 'dep:pending:DEP-AUTH-1' } });
  assert.equal((await Deposit.findById(dep._id)).status, 'processing');
  await service.processUpdate({ update_id: 2, callback_query: { id: 'good', from: { id: 42 }, message: { chat: { id: 9001 } }, data: 'dep:pending:DEP-AUTH-1' } });
  assert.equal((await Deposit.findById(dep._id)).status, 'pending');
  assert.ok(calls.length >= 3);
});

test('Telegram status, ADD FUND, RESET, withdrawal, KYC, and invalid-input flows persist safe results', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; };
  const service = createTelegramService({ fetchImpl: fakeFetch });
  const user = await User.create({ username: 'flowuser', usernameNormalized: 'flowuser', email: 'flow@example.com', emailNormalized: 'flow@example.com', passwordHash: 'unused', name: 'Flow User' });
  const dep = await Deposit.create({ publicId: 'DEP-FLOW-1', user: user._id, amountCents: 1000, asset: 'USDT', network: 'TRC20', address: 'TQiZD8zedxCLZYZXXtx4v6M7biQuzypGFp', sessionId: 'SES-FLOW-1' });
  const callback = (id, data) => ({ update_id: id, callback_query: { id: `cb-${id}`, from: { id: 42 }, message: { chat: { id: 9001 } }, data } });
  const message = (id, text) => ({ update_id: id, message: { message_id: id, from: { id: 42 }, chat: { id: 9001 }, text } });

  await service.processUpdate(callback(10, 'dep:received:DEP-FLOW-1'));
  assert.equal((await Deposit.findById(dep._id)).status, 'received');
  assert.equal((await User.findById(user._id)).balanceCents, 1500);
  await service.processUpdate(callback(11, 'dep:received:DEP-FLOW-1'));
  assert.equal(await LedgerEntry.countDocuments({ type: 'deposit_credit' }), 1);
  assert.equal(await Notification.countDocuments({ user: user._id, type: 'deposit_status' }), 1, 'replayed deposit status cannot duplicate its bell event');

  await service.processUpdate(message(12, '/addfund'));
  await service.processUpdate(message(13, 'missing@example.com'));
  assert.equal((await BotConversation.findOne({ telegramUserId: '42' })).state, 'await_identifier');
  await service.processUpdate(message(14, 'flow@example.com'));
  await service.processUpdate(message(15, '-5'));
  assert.equal((await BotConversation.findOne({ telegramUserId: '42' })).state, 'await_amount');
  await service.processUpdate(message(16, '25.50'));
  const fundConversation = await BotConversation.findOne({ telegramUserId: '42', state: 'await_confirmation' });
  await service.processUpdate(callback(17, `fund:confirm:${fundConversation.publicId}`));
  assert.equal((await User.findById(user._id)).balanceCents, 4050);
  const action = await AdminFundAction.findOne({ targetUser: user._id });
  assert.equal(action.amountCents, 2550);
  assert.equal(await LedgerEntry.countDocuments({ type: 'admin_fund' }), 1);

  await service.processUpdate(callback(18, 'fund:reset:DEP-FLOW-1'));
  const resetConversation = await BotConversation.findOne({ telegramUserId: '42', state: 'await_confirmation' });
  await service.processUpdate(callback(19, `reset:confirm:${resetConversation.publicId}`));
  assert.equal((await User.findById(user._id)).balanceCents, 1500);
  assert.equal((await AdminFundAction.findById(action._id)).status, 'reversed');
  assert.equal(await LedgerEntry.countDocuments({ type: 'admin_fund_reversal' }), 1);

  const withdrawal = await Withdrawal.create({ publicId: 'WDR-FLOW-1', user: user._id, amountCents: 500, feeCents: 500, asset: 'USDT', destination: 'TQiZD8zedxCLZYZXXtx4v6M7biQuzypGFp', sessionId: 'SES-WDR-1' });
  await service.processUpdate(callback(20, 'wd:pending:WDR-FLOW-1'));
  assert.equal((await Withdrawal.findById(withdrawal._id)).status, 'pending');
  await service.processUpdate(callback(21, 'wd:completed:WDR-FLOW-1'));
  assert.equal((await Withdrawal.findById(withdrawal._id)).status, 'completed');
  assert.equal((await User.findById(user._id)).balanceCents, 500);
  assert.equal(await Notification.countDocuments({ user: user._id, type: 'withdrawal_status' }), 2);

  await service.processUpdate(callback(22, `kyc:review:${user._id}`));
  assert.equal((await User.findById(user._id)).kycStatus, 'under_review');
  await service.processUpdate(callback(23, `kyc:verified:${user._id}`));
  assert.equal((await User.findById(user._id)).kycStatus, 'verified');
  assert.ok(calls.some((call) => String(call.options && call.options.body).includes('Successfully Received &amp; Applied')));
});

test('market provider normalization requires genuine BTC and ETH values', () => {
  const result = normalize({ error: [], result: {
    XXBTZUSD: { c: ['64000.00'], o: '63000.00' }, XETHZUSD: { c: ['3200.00'], o: '3210.00' }
  } });
  assert.equal(result.BTC.price, 64000); assert.ok(result.ETH.change24h < 0);
  assert.throws(() => normalize({ error: [], result: { XXBTZUSD: { c: ['1'], o: '1' } } }), /both BTC and ETH/i);
});

test('Kraken assetVersion display names provide the same BTC/ETH prices to navbar and market list', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => String(url).includes('kraken')
    ? { ok: true, json: async () => ({ error: [], result: {
      'BTC/USD': { c: ['64000'], o: '62000', v: ['3', '5'] },
      'ETH/USD': { c: ['3200'], o: '3000', v: ['1', '4'] },
      'SOL/USD': { c: ['150'], o: '145', v: ['2', '9'] }
    } }) }
    : { ok: false, status: 503, json: async () => ({}) };
  resetMarketCache();
  try {
    const response = await request(app).get('/api/market/prices');
    assert.equal(response.status, 200);
    assert.equal(response.body.available, true);
    assert.equal(response.body.quotes.BTC.price, 64000);
    assert.equal(response.body.quotes.ETH.price, 3200);
    assert.equal(response.body.quotes.SOL.price, 150);
    assert.equal(response.body.quotes.BTC.volumeUsd, 320000);
    assert.equal(response.body.quotes.BTC.source, 'Kraken');
  } finally { global.fetch = originalFetch; resetMarketCache(); }
});

test('CoinGecko provides verified BTC/ETH/SOL fallback when Kraken cannot connect', async () => {
  const originalFetch = global.fetch;
  const fresh = new Date().toISOString();
  global.fetch = async (url) => String(url).includes('kraken')
    ? { ok: false, status: 503, json: async () => ({}) }
    : String(url).includes('ids=')
      ? { ok: true, json: async () => ([
        { id: 'binance-bridged-usdt-bnb-smart-chain', symbol: 'bsc-usd', image: '/coins/images/35021/large/usdt.png', current_price: 0.999, price_change_percentage_24h: 0, last_updated: fresh },
        { id: 'coinbase-wrapped-btc', symbol: 'cbbtc', image: '/coins/images/40143/large/cbbtc.webp', current_price: 65001, price_change_percentage_24h: 1, last_updated: fresh },
        { id: 'tokenize-xchange', symbol: 'tkx', image: '/coins/images/4984/large/tkx.png', current_price: 0.17, price_change_percentage_24h: 1, last_updated: '2020-01-01T00:00:00Z' }
      ]) }
    : { ok: true, json: async () => ([
      { id: 'bitcoin', symbol: 'btc', image: '/coins/images/1/large/bitcoin.png', current_price: 65000, price_change_percentage_24h: 1.5, total_volume: 100000, last_updated: fresh },
      { id: 'ethereum', symbol: 'eth', image: '/coins/images/279/large/ethereum.png', current_price: 3300, price_change_percentage_24h: -0.5, total_volume: 20000, last_updated: fresh },
      { id: 'solana', symbol: 'sol', image: '/coins/images/4128/large/solana.png', current_price: 155, price_change_percentage_24h: 2, total_volume: 30000, last_updated: fresh }
    ]) };
  resetMarketCache();
  try {
    const result = await getMarketPrices({ force: true });
    assert.equal(result.available, true);
    assert.equal(result.source, 'CoinGecko');
    assert.equal(result.quotes.BTC.price, 65000);
    assert.equal(result.quotes.ETH.price, 3300);
    assert.equal(result.quotes.SOL.price, 155);
    assert.equal(result.quotes['BSC-USD'].price, 0.999);
    assert.equal(result.quotes.CBBTC.price, 65001);
    assert.equal(result.quotes.TKX, undefined, 'old provider timestamps must not be shown as live');
    assert.equal(result.quotes.BTC.changePeriod, '24h');
    assert.deepEqual(Object.keys(normalizeCoinGecko([{ symbol: 'btc', image: '/coins/images/999/large/other.png', current_price: 7777, last_updated: fresh }])), []);
  } finally { global.fetch = originalFetch; resetMarketCache(); }
});

test('Live Markets cryptocurrency rows contain no hardcoded price or percentage snapshots', () => {
  const page = fs.readFileSync(require.resolve('../dashboard/trade.html'), 'utf8');
  const start = page.indexOf('instruments: [{');
  const end = page.indexOf('selectedType:', start);
  const entries = JSON.parse(page.slice(start, end).split('instruments: ')[1].trim().replace(/,$/, ''));
  const cryptocurrencies = entries.filter((entry) => entry.type === 'crypto');
  assert.equal(cryptocurrencies.length, 76);
  for (const entry of cryptocurrencies) {
    for (const field of ['price', 'open', 'high', 'low', 'close', 'percent_change_24h', 'change', 'volume']) {
      assert.equal(entry[field], null, `${entry.symbol}: ${field} must come from the live API`);
    }
  }
  assert.match(page, /XytrionApp\.marketPrices\(\)/);
});

test('market service returns unavailable instead of fabricated quotes when its provider fails', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  resetMarketCache();
  try {
    const result = await getMarketPrices({ force: true });
    assert.equal(result.available, false);
    assert.equal(result.quotes, null);
    assert.match(result.error, /unavailable/i);
  } finally {
    global.fetch = originalFetch;
    resetMarketCache();
  }
});

test('outages expose verified quotes only within the stale limit and never invent replacements', async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  global.fetch = async (url) => String(url).includes('kraken')
    ? { ok: true, json: async () => ({ error: [], result: {
      'BTC/USD': { c: ['64000'], o: '63000' }, 'ETH/USD': { c: ['3200'], o: '3100' }
    } }) }
    : { ok: false, status: 503, json: async () => ({}) };
  resetMarketCache();
  try {
    assert.equal((await getMarketPrices({ force: true })).stale, false);
    global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    clock += 180000;
    const stale = await getMarketPrices({ force: true });
    assert.equal(stale.available, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.quotes.BTC.price, 64000);
    clock += 180000;
    const unavailable = await getMarketPrices({ force: true });
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.quotes, null);
  } finally { global.fetch = originalFetch; Date.now = originalNow; resetMarketCache(); }
});

test('shared money formatter uses grouping and exactly two decimals', () => {
  const context = { window: {}, Intl, Number, Error, FormData: class {}, fetch: async () => ({ ok: false, json: async () => ({}) }), setTimeout: () => 1, clearTimeout: () => {} };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/app.js'), 'utf8'), context);
  const money = context.window.XytrionFormat.money;
  assert.equal(money(2000), '$2,000.00');
  assert.equal(money(2500000), '$2,500,000.00');
  assert.equal(money(0), '$0.00');
  assert.equal(money(1234.5), '$1,234.50');
});

test('navbar and cryptocurrency list share the exact same short-lived browser quote snapshot', async () => {
  let requests = 0;
  const payload = { available: true, fetchedAt: new Date().toISOString(), quotes: { BTC: { price: 64000 }, ETH: { price: 3200 } } };
  const context = {
    window: {}, Intl, Number, Error, Promise, FormData: class {}, clearTimeout: () => {}, setTimeout: () => 1,
    fetch: async () => {
      requests += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    }
  };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/app.js'), 'utf8'), context);
  const [nav, table] = await Promise.all([context.window.XytrionApp.marketPrices(), context.window.XytrionApp.marketPrices()]);
  assert.equal(requests, 1);
  assert.equal(nav, table);
  assert.equal((await context.window.XytrionApp.marketPrices()).quotes.BTC.price, 64000);
  assert.equal(requests, 1);
});

test('investment refresh populates original dashboard bot summary fields', async () => {
  const elements = new Map();
  const investment = { id: 'INV-TEST', botId: 'starter-3d', amount: 100, totalProfit: 25,
    status: 'active', startTime: Date.now(), durationDays: 3,
    dailyProfits: [{ day: 1, date: new Date().toISOString(), profit: 25 }] };
  const context = {
    window: {
      XytrionFormat: { money: (n) => `$${Number(n).toFixed(2)}` },
      XytrionApi: { request: async () => ({ plans: [{ id: 'starter-3d' }], investments: [investment] }) },
      refreshCurrentUser: async () => ({ id: 'USER-TEST' }),
      dispatchEvent: () => {}
    },
    document: {
      addEventListener: () => {},
      querySelectorAll: (selector) => {
        if (!elements.has(selector)) elements.set(selector, [{ textContent: '' }]);
        return elements.get(selector);
      }
    },
    CustomEvent: class { constructor(name) { this.type = name; } }, Date, Number, Math, setInterval: () => 1
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../dashboard/investments.js'), 'utf8'), context);
  await context.window.XytrionInvestments.refreshInvestmentStats();
  await context.window.XytrionInvestments.processInvestments();
  assert.equal(elements.get('[data-invest-active-balance]')[0].textContent, '$100.00');
  assert.equal(elements.get('[data-invest-total-profit]')[0].textContent, '$25.00');
  assert.equal(elements.get('[data-invest-active-count]')[0].textContent, '1');
});

test('session hydration redirects only when the server explicitly reports an expired session', async () => {
  const cache = new Map([['xytrion_current_user', JSON.stringify({ username: 'saved' })]]);
  const storage = { getItem: (key) => cache.get(key) || null, setItem: (key, value) => cache.set(key, value), removeItem: (key) => cache.delete(key) };
  const redirects = [];
  let status = 503;
  const context = {
    window: {
      location: { pathname: '/dashboard/bot-trading.html', replace: (target) => redirects.push(target) },
      addEventListener: () => {},
      XytrionApi: { request: async () => { throw Object.assign(new Error('Connection failed.'), { status }); } }
    },
    localStorage: storage, document: { addEventListener: () => {}, querySelectorAll: () => [] }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../dashboard/user-session.js'), 'utf8'), context);
  await assert.rejects(context.window.refreshCurrentUser(), /Connection failed/);
  assert.equal(context.window.getCurrentUser().username, 'saved');
  assert.deepEqual(redirects, []);
  status = 401;
  await assert.rejects(context.window.refreshCurrentUser(), /Connection failed/);
  assert.equal(context.window.getCurrentUser(), null);
  assert.deepEqual(redirects, ['../login.html']);
});

test('browser API client explains when a static server returns HTML instead of API JSON', async () => {
  const context = {
    window: {}, Intl, Number, Error, FormData: class {}, setTimeout: () => 1, clearTimeout: () => {},
    fetch: async () => ({ status: 404, ok: false, headers: { get: () => 'text/html' }, text: async () => '<!doctype html><title>Not Found</title>' })
  };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/app.js'), 'utf8'), context);
  await assert.rejects(context.window.XytrionApi.request('/api/auth/register', { method: 'POST', body: {} }), /npm start.*static file server/i);
});

test('browser API client explains HTTP 405 as a Node hosting or API routing problem', async () => {
  const context = {
    window: {}, Intl, Number, Error, FormData: class {}, setTimeout: () => 1, clearTimeout: () => {},
    fetch: async () => ({ status: 405, ok: false, headers: { get: () => 'application/json' }, text: async () => '{}' })
  };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/js/app.js'), 'utf8'), context);
  await assert.rejects(context.window.XytrionApi.request('/api/auth/register', { method: 'POST', body: {} }), /HTTP 405.*npm start.*\/api\/health/i);
});

test('registration credential fields start empty and opt out of login autofill', () => {
  const html = fs.readFileSync(require.resolve('../register.html'), 'utf8');
  assert.match(html, /<form[^>]+id="register"[^>]+autocomplete="off"/i);
  for (const id of ['username', 'password', 'password_confirmation']) {
    const input = html.match(new RegExp(`<input[^>]+id="${id}"[^>]*>`, 'i'));
    assert.ok(input, `missing ${id} field`);
    assert.match(input[0], /value=""/i);
    assert.match(input[0], /readonly/i);
    assert.match(input[0], /data-lpignore="true"/i);
  }
  assert.match(html.match(/<input[^>]+id="password"[^>]*>/i)[0], /autocomplete="new-password"/i);
  assert.match(html.match(/<input[^>]+id="password_confirmation"[^>]*>/i)[0], /autocomplete="new-password"/i);
});

// Customer-facing notifications are intentionally separate from Telegram admin messages.
test('registration and login create only real per-user notifications; read and delete actions stay owner-scoped', async () => {
  const first = request.agent(app); const second = request.agent(app);
  const one = await register(first, 'notice1'); const two = await register(second, 'notice2');
  assert.equal(one.status, 201); assert.equal(two.status, 201);
  assert.equal((await request(app).get('/api/notifications')).status, 401);
  assert.equal((await request(app).get('/api/notifications/stream')).status, 401);
  let own = await first.get('/api/notifications');
  assert.equal(own.body.unreadCount, 1);
  assert.deepEqual(own.body.items.map((item) => item.type), ['registration']);
  assert.equal(await EmailDelivery.countDocuments({ user: one.body.user.id }), 1);
  const foreign = (await second.get('/api/notifications')).body.items[0].id;
  assert.equal((await first.patch(`/api/notifications/${foreign}/read`)).status, 404);
  assert.equal((await first.patch('/api/notifications/not-an-id/read')).status, 404);
  assert.equal((await first.get('/api/notifications')).body.unreadCount, 1);
  assert.equal((await first.post('/api/auth/login').send({ identifier: 'tradernotice1@example.com', password: 'Wrong!Pass' })).status, 401);
  assert.equal((await first.get('/api/notifications')).body.items.length, 1, 'invalid login cannot create a notification');
  assert.equal((await first.post('/api/auth/login').send({ identifier: 'tradernotice1@example.com', password: 'Strong!Pass' })).status, 200);
  own = await first.get('/api/notifications');
  assert.deepEqual(own.body.items.map((item) => item.type), ['login', 'registration']);
  assert.equal(own.body.unreadCount, 2);
  assert.equal(await EmailDelivery.countDocuments({ user: one.body.user.id }), 1, 'login is not emailed');
  const mark = await first.patch(`/api/notifications/${own.body.items[0].id}/read`);
  assert.equal(mark.status, 200);
  assert.equal((await first.get('/api/notifications')).body.unreadCount, 1);
  assert.equal((await first.post('/api/notifications/read-all')).body.updated, 1);
  assert.equal((await first.get('/api/notifications')).body.unreadCount, 0);
  assert.equal((await second.get('/api/notifications')).body.unreadCount, 1);
  assert.equal((await first.delete('/api/account').send({ password: 'Strong!Pass', confirmation: 'DELETE' })).status, 200);
  assert.equal(await Notification.countDocuments({ user: one.body.user.id }), 0);
  assert.equal(await EmailDelivery.countDocuments({ user: one.body.user.id }), 0);
});

test('deposit, withdrawal and bot investment create truthful notifications and only requested emails', async () => {
  const agent = request.agent(app); const registered = await register(agent, 'receipts');
  const userId = registered.body.user.id;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const submitted = await agent.post('/api/deposits').field('amount', '125.25').field('method', 'USDT').attach('proof', png, { filename: 'proof.png', contentType: 'image/png' });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.body.transaction.status, 'processing');
  await createAdminFund({ userId, amountCents: 40000, actorTelegramId: '42', source: 'command', sessionId: 'ACT-EMAIL-TEST' });
  const withdrawal = await agent.post('/api/withdrawals').send({ amount: '50.00', asset: 'BTC', destination: 'bc1q-test-wallet-address-1234567' });
  assert.equal(withdrawal.status, 201);
  const investment = await agent.post('/api/investments').send({ planId: 'starter-3d', amount: 100 });
  assert.equal(investment.status, 201);
  const notice = await agent.get('/api/notifications');
  assert.deepEqual(notice.body.items.map((item) => item.type), ['invest', 'withdrawal', 'deposit', 'registration']);
  assert.equal(notice.body.unreadCount, 4);
  assert.match(notice.body.items[2].message, /funds have not been credited yet/i);
  assert.match(notice.body.items[1].message, /funds have not been sent yet/i);
  assert.equal(await EmailDelivery.countDocuments({ user: userId }), 3);
  const messages = await EmailDelivery.find({ user: userId }).sort({ createdAt: 1 });
  assert.deepEqual(messages.map((item) => item.to), Array(3).fill('traderreceipts@example.com'));
  assert.match(messages[1].text, /\$125\.25/);
  assert.match(messages[1].text, /Status: Processing/i);
  assert.match(messages[2].text, /\$50\.00/);
  assert.match(messages[2].text, /has not been completed/i);

  const sent = []; let failOnce = true;
  const worker = createEmailWorker({ enabled: true, sender: async (mail) => {
    if (mail.subject.includes('Deposit') && failOnce) { failOnce = false; throw new Error('SMTP temporarily unavailable'); }
    sent.push(mail);
  } });
  assert.equal(await worker.processPending(), 3);
  assert.equal(await EmailDelivery.countDocuments({ status: 'sent' }), 2);
  const retry = await EmailDelivery.findOne({ status: 'pending' });
  assert.equal(retry.attempts, 1);
  assert.match(retry.lastError, /SMTP temporarily unavailable/);
  retry.nextAttemptAt = new Date(Date.now() - 1000); await retry.save();
  assert.equal(await worker.processPending(), 1);
  assert.equal(await EmailDelivery.countDocuments({ status: 'sent' }), 3);
  assert.equal(sent.length, 3);
  assert.ok(sent.every((mail) => mail.to === 'traderreceipts@example.com' && mail.messageId));
  worker.stop();
});

test('notification stream pushes account activity immediately and cannot be opened without a session', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
  const controller = new AbortController();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const registered = await request(app).post('/api/auth/register').send({
      username: 'streamowner', name: 'Stream Owner', email: 'streamowner@example.com', country: 'US', password: 'Strong!Pass'
    });
    assert.equal(registered.status, 201);
    const cookie = registered.headers['set-cookie'].map((part) => part.split(';')[0]).join('; ');
    const stream = await fetch(`${base}/api/notifications/stream`, { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    async function nextSnapshot() {
      const timeout = setTimeout(() => controller.abort(), 6000);
      try {
        while (!buffer.includes('\n\n')) {
          const result = await reader.read();
          assert.equal(result.done, false, 'event stream closed unexpectedly');
          buffer += decoder.decode(result.value, { stream: true });
        }
        const marker = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, marker); buffer = buffer.slice(marker + 2);
        return JSON.parse(frame.split('\n').find((line) => line.startsWith('data: ')).slice(6));
      } finally { clearTimeout(timeout); }
    }
    const initial = await nextSnapshot();
    assert.deepEqual(initial.items.map((item) => item.type), ['registration']);
    const deposit = await request(app).post('/api/deposits').set('Cookie', cookie).field('amount', '25.00').field('method', 'BTC')
      .attach('proof', Buffer.from('89504e470d0a1a0a', 'hex'), { filename: 'receipt.png', contentType: 'image/png' });
    assert.equal(deposit.status, 201);
    const pushed = await nextSnapshot();
    assert.deepEqual(pushed.items.map((item) => item.type), ['deposit', 'registration']);
    assert.equal(pushed.unreadCount, 2);
  } finally {
    controller.abort();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('all protected navbar bells contain only the shared live component, never the old fabricated entries', () => {
  const root = path.resolve(__dirname, '..');
  const pages = ['dashboard.html', 'kyc-form.html', 'verify-account.html',
    ...fs.readdirSync(path.join(root, 'dashboard')).filter((name) => name.endsWith('.html')).map((name) => `dashboard/${name}`)];
  for (const name of pages) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    assert.equal((source.match(/data-notifications-root/g) || []).length, 1, `${name}: exactly one live bell`);
    assert.equal((source.match(/src="\/assets\/js\/notifications\.js"/g) || []).length, 1, `${name}: shared notification script`);
    assert.doesNotMatch(source, /New login detected from IP:|Welcome to Algo Trading|href="#\/83\d"/, `${name}: fabricated notification`);
  }
});

test('notification and email-outbox failures roll back registration, deposit, withdrawal and investment writes', async () => {
  const originalEmailUpdate = EmailDelivery.updateOne;
  EmailDelivery.updateOne = async () => { throw new Error('Injected email outbox failure'); };
  try {
    const rejected = await register(request.agent(app), 'rolledback');
    assert.equal(rejected.status, 500);
    assert.equal(await User.countDocuments({ emailNormalized: 'traderrolledback@example.com' }), 0);
    assert.equal(await Notification.countDocuments(), 0);
  } finally { EmailDelivery.updateOne = originalEmailUpdate; }

  const agent = request.agent(app); const registered = await register(agent, 'atomic');
  assert.equal(registered.status, 201);
  await createAdminFund({ userId: registered.body.user.id, amountCents: 50000, actorTelegramId: '42', source: 'command', sessionId: 'ACT-ATOMIC-TEST' });
  const balance = (await agent.get('/api/auth/me')).body.user.balance;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  EmailDelivery.updateOne = async () => { throw new Error('Injected email outbox failure'); };
  try {
    const rejectedDeposit = await agent.post('/api/deposits').field('amount', '75.00').field('method', 'USDT').attach('proof', png, { filename: 'proof.png', contentType: 'image/png' });
    assert.equal(rejectedDeposit.status, 500);
    assert.equal(await Deposit.countDocuments(), 0);
    const rejectedWithdrawal = await agent.post('/api/withdrawals').send({ amount: 50, asset: 'BTC', destination: 'bc1q-test-wallet-address-1234567' });
    assert.equal(rejectedWithdrawal.status, 500);
    assert.equal(await Withdrawal.countDocuments(), 0);
    assert.equal(await Notification.countDocuments({ user: registered.body.user.id }), 1, 'welcome event remains, failed transactions do not');
  } finally { EmailDelivery.updateOne = originalEmailUpdate; }

  const originalNoticeUpdate = Notification.findOneAndUpdate;
  Notification.findOneAndUpdate = async () => { throw new Error('Injected bell persistence failure'); };
  try {
    const rejectedInvestment = await agent.post('/api/investments').send({ planId: 'starter-3d', amount: 100 });
    assert.equal(rejectedInvestment.status, 500);
    assert.equal(await Investment.countDocuments(), 0);
    assert.equal(await LedgerEntry.countDocuments({ type: 'investment_debit' }), 0);
    assert.equal((await agent.get('/api/auth/me')).body.user.balance, balance);
  } finally { Notification.findOneAndUpdate = originalNoticeUpdate; }
});

test('failed financial records cannot be resurrected by old Telegram buttons or generate a false status notice', async () => {
  const telegram = createTelegramService({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }) });
  const user = await User.create({ username: 'terminal', usernameNormalized: 'terminal', email: 'terminal@example.com', emailNormalized: 'terminal@example.com', passwordHash: 'unused', name: 'Terminal User' });
  await createAdminFund({ userId: user._id, amountCents: 10000, actorTelegramId: '42', source: 'command', sessionId: 'ACT-TERMINAL-TEST' });
  const deposit = await Deposit.create({ publicId: 'DEP-FAILED-TEST', user: user._id, amountCents: 1000, asset: 'USDT', network: 'TRC20', address: 'TQiZD8zedxCLZYZXXtx4v6M7biQuzypGFp', sessionId: 'SES-FAILED-DEP', status: 'failed' });
  const withdrawal = await Withdrawal.create({ publicId: 'WDR-FAILED-TEST', user: user._id, amountCents: 1000, feeCents: 500, asset: 'BTC', destination: 'bc1q-test-wallet-address-1234567', sessionId: 'SES-FAILED-WDR', status: 'failed' });
  const callback = (id, data) => ({ update_id: id, callback_query: { id: `cb-${id}`, from: { id: 42 }, message: { chat: { id: 9001 } }, data } });
  await telegram.processUpdate(callback(100, 'dep:received:DEP-FAILED-TEST'));
  await telegram.processUpdate(callback(101, 'dep:pending:DEP-FAILED-TEST'));
  await telegram.processUpdate(callback(102, 'wd:completed:WDR-FAILED-TEST'));
  await telegram.processUpdate(callback(103, 'wd:pending:WDR-FAILED-TEST'));
  assert.equal((await Deposit.findById(deposit._id)).status, 'failed');
  assert.equal((await Withdrawal.findById(withdrawal._id)).status, 'failed');
  assert.equal(await LedgerEntry.countDocuments({ type: { $in: ['deposit_credit', 'withdrawal_debit'] } }), 0);
  assert.equal(await Notification.countDocuments({ user: user._id }), 0);
});

test('admin callbacks roll back balance/status changes when the customer event cannot be stored', async () => {
  const sent = [];
  const telegram = createTelegramService({ fetchImpl: async (url, options) => {
    sent.push({ url, body: String(options.body || '') });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  } });
  const user = await User.create({ username: 'statusrollback', usernameNormalized: 'statusrollback', email: 'statusrollback@example.com', emailNormalized: 'statusrollback@example.com', passwordHash: 'unused', name: 'Status Rollback' });
  await createAdminFund({ userId: user._id, amountCents: 10000, actorTelegramId: '42', source: 'command', sessionId: 'ACT-STATUS-TEST' });
  const dep = await Deposit.create({ publicId: 'DEP-ROLLBACK-1', user: user._id, amountCents: 2000, asset: 'USDT', network: 'TRC20', address: 'TQiZD8zedxCLZYZXXtx4v6M7biQuzypGFp', sessionId: 'SES-STATUS-DEP' });
  const withdrawal = await Withdrawal.create({ publicId: 'WDR-ROLLBACK-1', user: user._id, amountCents: 1500, feeCents: 500, asset: 'BTC', destination: 'bc1q-test-wallet-address-1234567', sessionId: 'SES-STATUS-WDR' });
  const callback = (id, data) => ({ update_id: id, callback_query: { id: `cb-${id}`, from: { id: 42 }, message: { chat: { id: 9001 } }, data } });
  const original = Notification.findOneAndUpdate;
  Notification.findOneAndUpdate = async () => { throw new Error('Injected customer-event failure'); };
  try {
    await telegram.processUpdate(callback(105, 'dep:received:DEP-ROLLBACK-1'));
    await telegram.processUpdate(callback(106, 'wd:completed:WDR-ROLLBACK-1'));
    assert.equal((await Deposit.findById(dep._id)).status, 'processing');
    assert.equal((await Withdrawal.findById(withdrawal._id)).status, 'processing');
    assert.equal((await User.findById(user._id)).balanceCents, 10500);
    assert.equal(await LedgerEntry.countDocuments({ type: { $in: ['deposit_credit', 'withdrawal_debit'] } }), 0);
    assert.equal(await Notification.countDocuments({ user: user._id }), 0);
    assert.ok(sent.some((entry) => entry.body.includes('Failed')));
  } finally { Notification.findOneAndUpdate = original; }
});

test('one account cannot open unlimited notification event streams', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
  const controllers = [];
  try {
    const registration = await request(app).post('/api/auth/register').send({
      username: 'streamlimit', name: 'Stream Limit', email: 'streamlimit@example.com', country: 'US', password: 'Strong!Pass'
    });
    assert.equal(registration.status, 201);
    const cookie = registration.headers['set-cookie'].map((part) => part.split(';')[0]).join('; ');
    const url = `http://127.0.0.1:${server.address().port}/api/notifications/stream`;
    for (let index = 0; index < 5; index += 1) {
      const controller = new AbortController(); controllers.push(controller);
      const connection = await fetch(url, { headers: { Cookie: cookie }, signal: controller.signal });
      assert.equal(connection.status, 200);
    }
    assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 429);
  } finally {
    controllers.forEach((controller) => controller.abort());
    await new Promise((resolve) => server.close(resolve));
  }
});
