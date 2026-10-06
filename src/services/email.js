'use strict';

const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { config } = require('../config');
const { EmailDelivery, User } = require('../models');
const { safeText } = require('../security');

let activeWorker = null;

function smtpConfigured() {
  const { host, user, pass, from } = config.email;
  return Boolean(host && user && pass && from);
}

function smtpTransport() {
  if (!smtpConfigured()) throw new Error('Customer email requires SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM.');
  return nodemailer.createTransport({
    host: config.email.host, port: config.email.port, secure: config.email.secure,
    requireTLS: !config.email.secure,
    auth: { user: config.email.user, pass: config.email.pass },
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000
  });
}

async function verifySmtp() {
  const transport = smtpTransport();
  try { await transport.verify(); }
  finally { transport.close(); }
}

async function queueEmail({ user, eventKey, subject, text, dbSession = null }) {
  if (!user || !user.email) return;
  const unique = `${user._id}:${eventKey}`;
  await EmailDelivery.updateOne({ eventKey: unique }, { $setOnInsert: {
    user: user._id, eventKey: unique, to: user.email,
    subject, text, status: 'pending', nextAttemptAt: new Date()
  } }, { upsert: true, ...(dbSession ? { session: dbSession } : {}) });
  if (!dbSession) wakeEmailWorker();
}

function wakeEmailWorker() { if (activeWorker) activeWorker.wake(); }

function createEmailWorker({ sender, enabled = smtpConfigured(), intervalMs = 15000 } = {}) {
  const transport = enabled && !sender ? smtpTransport() : null;
  const send = sender || ((mail) => transport.sendMail(mail));
  let timer = null;
  let running = null;

  async function drain() {
    if (!enabled) return 0;
    let processed = 0;
    for (let index = 0; index < 10; index += 1) {
      const now = new Date();
      const job = await EmailDelivery.findOneAndUpdate({ $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'sending', lockedUntil: { $lte: now } }
      ] }, { $set: { status: 'sending', lockedUntil: new Date(now.getTime() + 60000) }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, new: true });
      if (!job) break;
      processed += 1;
      try {
        const user = await User.findOne({ _id: job.user, status: 'active', deletedAt: null });
        if (!user) { await EmailDelivery.deleteOne({ _id: job._id }); continue; }
        const domain = /@([A-Za-z0-9.-]+)/.exec(config.email.from);
        const digest = crypto.createHash('sha256').update(job.eventKey).digest('hex');
        await send({ from: config.email.from, to: job.to, subject: job.subject, text: job.text,
          messageId: `<${digest}@${domain ? domain[1] : 'notifications.xytrion.local'}>` });
        await EmailDelivery.updateOne({ _id: job._id, status: 'sending' }, { $set: { status: 'sent', sentAt: new Date(), lockedUntil: null, lastError: '' } });
      } catch (error) {
        const exhausted = job.attempts >= 8;
        const delayMs = Math.min(24 * 60 * 60 * 1000, 30000 * 2 ** Math.min(job.attempts - 1, 11));
        await EmailDelivery.updateOne({ _id: job._id, status: 'sending' }, { $set: {
          status: exhausted ? 'failed' : 'pending', lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + delayMs), lastError: safeText(error.message, 180)
        } });
        if (config.nodeEnv !== 'test') console.error('Customer email delivery failed; queued for retry:', safeText(error.message, 100));
      }
    }
    return processed;
  }

  function processPending() {
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  }
  function wake() { setImmediate(() => { processPending().catch((error) => console.error('Email worker error:', error.message)); }); }
  function start() {
    if (!enabled || timer) return false;
    activeWorker = { wake };
    timer = setInterval(wake, intervalMs);
    wake();
    return true;
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (activeWorker && activeWorker.wake === wake) activeWorker = null;
    if (transport) transport.close();
  }
  return { start, stop, processPending, wake };
}

module.exports = { smtpConfigured, smtpTransport, verifySmtp, queueEmail, wakeEmailWorker, createEmailWorker };
