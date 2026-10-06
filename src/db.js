'use strict';

const mongoose = require('mongoose');
const { config } = require('./config');

async function connectDatabase(uri = config.mongoUri) {
  if (!uri) throw new Error('MONGODB_URI is required');
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    autoIndex: config.nodeEnv !== 'production',
    serverSelectionTimeoutMS: 10000
  });
  const { User, Notification, EmailDelivery } = require('./models');
  await Promise.all([User.createIndexes(), Notification.createIndexes(), EmailDelivery.createIndexes()]);
  return mongoose.connection;
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

module.exports = { connectDatabase, disconnectDatabase, mongoose };
