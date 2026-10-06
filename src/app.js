'use strict';

const path = require('node:path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { config } = require('./config');
const { mongoose } = require('./db');
const { createApiRouter } = require('./routes');

function createSessionStore() {
  if (config.nodeEnv === 'test') return new session.MemoryStore();
  return MongoStore.create({ mongoUrl: config.mongoUri, collectionName: 'sessions', ttl: 60 * 60 * 24 * 7 });
}

function createApp({ sessionStore = createSessionStore(), telegramService } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  }));
  app.use(express.json({ limit: '250kb' }));
  app.use(express.urlencoded({ extended: false, limit: '250kb' }));
  app.use(session({
    name: 'xytrion.sid', secret: config.sessionSecret, store: sessionStore,
    resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, sameSite: 'strict', secure: config.nodeEnv === 'production' ? 'auto' : false, maxAge: 7 * 24 * 60 * 60 * 1000 }
  }));

  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin && origin !== config.appOrigin) return res.status(403).json({ ok: false, error: 'Cross-origin request rejected.' });
    return next();
  });

  // A protected page may check /auth/me several times (load, pageshow, tab focus).
  // Only credential-mutating requests need throttling; limiting /me to 80 requests
  // made regular sidebar navigation look like an expired session (HTTP 429).
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.nodeEnv === 'test' ? 1000 : 80, standardHeaders: true, legacyHeaders: false });
  app.use(['/api/auth/login', '/api/auth/register', '/api/auth/change-password'], authLimiter);
  const health = (_req, res) => {
    const database = mongoose.connection.readyState === 1 ? 'connected' : 'unavailable';
    return res.status(database === 'connected' ? 200 : 503).json({ ok: database === 'connected', api: 'online', database });
  };
  app.get('/health', health);
  app.get('/api/health', health);
  app.use('/api', createApiRouter({ telegramService }));

  const protectedPaths = new Set(['/dashboard.html', '/kyc-form.html', '/verify-account.html']);
  app.use((req, res, next) => {
    const isProtected = protectedPaths.has(req.path) || /^\/dashboard\/.*\.html$/.test(req.path);
    if (isProtected && (!req.session || !req.session.userId)) return res.redirect(302, '/login.html');
    return next();
  });

  app.use((req, res, next) => {
    if (/^\/(?:src|test|scripts|uploads)(?:\/|$)/.test(req.path) || /^\/(?:package(?:-lock)?\.json|\.env)/.test(req.path)) return res.sendStatus(404);
    return next();
  });

  app.use(express.static(path.resolve(__dirname, '..'), { index: 'index.html', dotfiles: 'deny', etag: true }));
  app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
  app.use((error, _req, res, _next) => {
    const status = Number(error.statusCode || error.status || 500);
    if (config.nodeEnv !== 'test' && status >= 500) console.error('Request failed:', error.message);
    res.status(status).json({ ok: false, error: status >= 500 ? 'An internal error occurred.' : error.message });
  });
  return app;
}

module.exports = { createApp };
