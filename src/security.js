'use strict';

const crypto = require('node:crypto');

const PASSWORD_SPECIAL = /[^A-Za-z0-9]/;

function passwordPolicyErrors(password) {
  const value = String(password || '');
  const errors = [];
  if (value.length < 8) errors.push('Password must be at least 8 characters long.');
  if (!/[A-Z]/.test(value)) errors.push('Password must include at least one uppercase letter.');
  if (!/[a-z]/.test(value)) errors.push('Password must include at least one lowercase letter.');
  if (!PASSWORD_SPECIAL.test(value)) errors.push('Password must include at least one special character.');
  return errors;
}

function parseMoneyToCents(value, { minCents = 1, maxCents = 100000000000 } = {}) {
  const text = typeof value === 'number' ? String(value) : String(value || '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw Object.assign(new Error('Enter a valid amount with no more than two decimal places.'), { statusCode: 400 });
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents < minCents || cents > maxCents) throw Object.assign(new Error('Amount is outside the allowed range.'), { statusCode: 400 });
  return cents;
}

function publicId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function safeText(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function escapeTelegram(value) {
  return safeText(value, 1000).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ ok: false, error: 'Authentication required.' });
  return next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function clientUser(user) {
  return user.toPublicJSON ? user.toPublicJSON() : user;
}

module.exports = {
  passwordPolicyErrors, parseMoneyToCents, publicId, normalizeIdentifier,
  safeText, escapeTelegram, requireAuth, asyncRoute, clientUser
};
