'use strict';

const { Notification } = require('../models');
const { queueEmail, wakeEmailWorker } = require('./email');

const listeners = new Map();

function subscribe(userId, callback) {
  const key = String(userId);
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(callback);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(callback);
    if (!current.size) listeners.delete(key);
  };
}

function changed(userId) {
  const subscribers = listeners.get(String(userId));
  if (!subscribers) return;
  for (const subscriber of subscribers) Promise.resolve().then(subscriber).catch(() => {});
}

function committed(userId) { changed(userId); wakeEmailWorker(); }

function toClient(item) {
  return {
    id: String(item._id), type: item.type, title: item.title, message: item.message,
    actionUrl: item.actionUrl, readAt: item.readAt, createdAt: item.createdAt
  };
}

async function snapshot(userId) {
  const [items, unreadCount] = await Promise.all([
    Notification.find({ user: userId }).sort({ createdAt: -1, _id: -1 }).limit(50).lean(),
    Notification.countDocuments({ user: userId, readAt: null })
  ]);
  return { items: items.map(toClient), unreadCount };
}

async function notifyUser({ user, eventKey, type, title, message, actionUrl = '/dashboard.html', email = null, dbSession = null }) {
  if (!user || !user._id) throw new Error('A valid user is required to create an account notification.');
  const filter = { user: user._id, eventKey };
  let record;
  try {
    record = await Notification.findOneAndUpdate(filter, { $setOnInsert: {
      user: user._id, eventKey, type, title, message, actionUrl, readAt: null
    } }, { upsert: true, new: true, setDefaultsOnInsert: true, ...(dbSession ? { session: dbSession } : {}) });
  } catch (error) {
    if (error.code !== 11000) throw error;
    record = await Notification.findOne(filter).session(dbSession);
  }
  if (email) await queueEmail({ user, eventKey, subject: email.subject, text: email.text, dbSession });
  if (!dbSession) changed(user._id);
  return record;
}

async function markRead(userId, notificationId) {
  const result = await Notification.updateOne({ _id: notificationId, user: userId, readAt: null }, { $set: { readAt: new Date() } });
  if (result.modifiedCount) changed(userId);
  return Boolean(await Notification.exists({ _id: notificationId, user: userId }));
}

async function markAllRead(userId) {
  const result = await Notification.updateMany({ user: userId, readAt: null }, { $set: { readAt: new Date() } });
  if (result.modifiedCount) changed(userId);
  return result.modifiedCount;
}

module.exports = { subscribe, changed, committed, snapshot, notifyUser, markRead, markAllRead };
