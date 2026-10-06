'use strict';

const { mongoose } = require('./db');
const { Schema } = mongoose;

const userSchema = new Schema({
  username: { type: String, required: true, trim: true },
  usernameNormalized: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true, trim: true },
  emailNormalized: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true, select: false },
  name: { type: String, required: true, trim: true },
  phone: { type: String, default: '', trim: true },
  country: { type: String, default: '', trim: true },
  balanceCents: { type: Number, required: true, default: 500, min: 0 },
  kycStatus: { type: String, enum: ['unverified', 'under_review', 'verified'], default: 'unverified' },
  status: { type: String, enum: ['active', 'deleted'], default: 'active', index: true },
  deletedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: 'version' });

userSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: String(this._id), username: this.username, email: this.email, name: this.name,
    phone: this.phone, country: this.country, balance: this.balanceCents / 100,
    balanceCents: this.balanceCents, kyc_status: this.kycStatus,
    createdAt: this.createdAt, updatedAt: this.updatedAt
  };
};

const ledgerEntrySchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amountCents: { type: Number, required: true },
  balanceBeforeCents: { type: Number, required: true },
  balanceAfterCents: { type: Number, required: true },
  type: { type: String, required: true, index: true },
  actorType: { type: String, enum: ['user', 'telegram_admin', 'system'], required: true },
  actorId: { type: String, required: true },
  referenceType: { type: String, default: '' },
  referenceId: { type: String, default: '', index: true },
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

const depositSchema = new Schema({
  publicId: { type: String, required: true, unique: true, index: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amountCents: { type: Number, required: true, min: 1 },
  asset: { type: String, enum: ['USDT', 'BTC'], required: true },
  network: { type: String, required: true },
  address: { type: String, required: true },
  status: { type: String, enum: ['processing', 'pending', 'received', 'failed'], default: 'processing', index: true },
  sessionId: { type: String, required: true, index: true },
  proof: {
    originalName: String,
    mimeType: String,
    size: Number,
    sha256: String
  },
  notificationDelivered: { type: Boolean, default: false },
  notificationError: { type: String, default: '' },
  creditedAt: { type: Date, default: null }
}, { timestamps: true });

const withdrawalSchema = new Schema({
  publicId: { type: String, required: true, unique: true, index: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amountCents: { type: Number, required: true, min: 1 },
  feeCents: { type: Number, required: true, default: 500, min: 0 },
  asset: { type: String, enum: ['USDT', 'BTC', 'ETH'], required: true },
  destination: { type: String, required: true },
  status: { type: String, enum: ['processing', 'pending', 'completed', 'failed'], default: 'processing', index: true },
  sessionId: { type: String, required: true, index: true },
  notificationDelivered: { type: Boolean, default: false },
  notificationError: { type: String, default: '' },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

const adminFundActionSchema = new Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  targetUser: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amountCents: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['applied', 'reversed'], default: 'applied', index: true },
  actorTelegramId: { type: String, required: true },
  source: { type: String, enum: ['button', 'command'], required: true },
  sourceReference: { type: String, default: '' },
  balanceBeforeCents: { type: Number, required: true },
  balanceAfterCents: { type: Number, required: true },
  appliedLedger: { type: Schema.Types.ObjectId, ref: 'LedgerEntry', required: true },
  reversalLedger: { type: Schema.Types.ObjectId, ref: 'LedgerEntry', default: null },
  reversedAt: { type: Date, default: null }
}, { timestamps: true });

const botConversationSchema = new Schema({
  publicId: { type: String, required: true, unique: true, index: true },
  telegramUserId: { type: String, required: true, index: true },
  chatId: { type: String, required: true, index: true },
  state: { type: String, enum: ['await_identifier', 'await_amount', 'await_confirmation'], required: true },
  targetUser: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  amountCents: { type: Number, default: null },
  source: { type: String, enum: ['button', 'command'], required: true },
  sourceReference: { type: String, default: '' },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
}, { timestamps: true });

const chatMessageSchema = new Schema({
  sessionId: { type: String, required: true, index: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sender: { type: String, enum: ['user', 'support', 'system'], required: true },
  text: { type: String, required: true, maxlength: 2000 },
  externalUpdateId: { type: Number, sparse: true, unique: true }
}, { timestamps: true });

const telegramStateSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Schema.Types.Mixed, required: true }
}, { timestamps: true });

const investmentSchema = new Schema({
  publicId: { type: String, required: true, unique: true, index: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  planId: { type: String, required: true },
  botName: { type: String, required: true },
  amountCents: { type: Number, required: true, min: 1 },
  durationDays: { type: Number, required: true, min: 3 },
  minDailyPct: { type: Number, required: true },
  maxDailyPct: { type: Number, required: true },
  startTime: { type: Date, required: true },
  status: { type: String, enum: ['active', 'completed'], default: 'active' },
  dailyProfits: [{ day: Number, ratePct: Number, profitCents: Number, date: Date }],
  totalProfitCents: { type: Number, default: 0 },
  lastProcessedDay: { type: Number, default: 0 },
  completedAt: { type: Date, default: null },
  payoutCredited: { type: Boolean, default: false }
}, { timestamps: true });
investmentSchema.index({ user: 1, planId: 1, status: 1 });

const notificationSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  eventKey: { type: String, required: true, maxlength: 140 },
  type: { type: String, enum: ['registration', 'login', 'deposit', 'withdrawal', 'invest', 'deposit_status', 'withdrawal_status'], required: true },
  title: { type: String, required: true, maxlength: 120 },
  message: { type: String, required: true, maxlength: 500 },
  actionUrl: { type: String, required: true, maxlength: 200 },
  readAt: { type: Date, default: null }
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });
notificationSchema.index({ user: 1, eventKey: 1 }, { unique: true });
notificationSchema.index({ user: 1, createdAt: -1 });

const emailDeliverySchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  eventKey: { type: String, required: true, unique: true },
  to: { type: String, required: true },
  subject: { type: String, required: true },
  text: { type: String, required: true },
  status: { type: String, enum: ['pending', 'sending', 'sent', 'failed'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedUntil: { type: Date, default: null },
  lastError: { type: String, default: '' },
  sentAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });
emailDeliverySchema.index({ status: 1, nextAttemptAt: 1 });

function model(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

module.exports = {
  User: model('User', userSchema),
  LedgerEntry: model('LedgerEntry', ledgerEntrySchema),
  Deposit: model('Deposit', depositSchema),
  Withdrawal: model('Withdrawal', withdrawalSchema),
  AdminFundAction: model('AdminFundAction', adminFundActionSchema),
  BotConversation: model('BotConversation', botConversationSchema),
  ChatMessage: model('ChatMessage', chatMessageSchema),
  TelegramState: model('TelegramState', telegramStateSchema),
  Investment: model('Investment', investmentSchema),
  Notification: model('Notification', notificationSchema),
  EmailDelivery: model('EmailDelivery', emailDeliverySchema)
};
