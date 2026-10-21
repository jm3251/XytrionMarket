'use strict';

const { mongoose } = require('../db');
const { User, LedgerEntry, AdminFundAction } = require('../models');

async function withTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

async function applyBalanceDelta({ userId, deltaCents, type, actorType, actorId, referenceType = '', referenceId = '', idempotencyKey, metadata = {} }, externalSession = null) {
  const run = async (session) => {
    const existing = await LedgerEntry.findOne({ idempotencyKey }).session(session);
    if (existing) return { replayed: true, ledger: existing, balanceCents: existing.balanceAfterCents };

    const user = await User.findOne({ _id: userId, status: 'active', deletedAt: null }).session(session);
    if (!user) throw Object.assign(new Error('Target user does not exist or is inactive.'), { statusCode: 404 });
    const before = user.balanceCents;
    const after = before + deltaCents;
    if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error('Insufficient balance or invalid balance result.'), { statusCode: 409 });

    user.balanceCents = after;
    await user.save({ session });
    const [ledger] = await LedgerEntry.create([{
      user: user._id, amountCents: deltaCents, balanceBeforeCents: before, balanceAfterCents: after,
      type, actorType, actorId: String(actorId), referenceType, referenceId, idempotencyKey, metadata
    }], { session });
    return { replayed: false, ledger, balanceCents: after, user };
  };
  return externalSession ? run(externalSession) : withTransaction(run);
}

async function createAdminFund({ userId, amountCents, actorTelegramId, source, sourceReference = '', sessionId }) {
  return withTransaction(async (session) => {
    const existing = await AdminFundAction.findOne({ sessionId }).session(session);
    if (existing) return { replayed: true, action: existing };
    const result = await applyBalanceDelta({
      userId, deltaCents: amountCents, type: 'admin_fund', actorType: 'telegram_admin', actorId: actorTelegramId,
      referenceType: 'admin_fund', referenceId: sessionId, idempotencyKey: `admin-fund:${sessionId}`,
      metadata: { source, sourceReference }
    }, session);
    const [action] = await AdminFundAction.create([{
      sessionId, targetUser: userId, amountCents, status: 'applied', actorTelegramId: String(actorTelegramId),
      source, sourceReference, balanceBeforeCents: result.ledger.balanceBeforeCents,
      balanceAfterCents: result.ledger.balanceAfterCents, appliedLedger: result.ledger._id
    }], { session });
    return { replayed: false, action, balanceCents: result.balanceCents };
  });
}

async function reverseAdminFund({ action, actorTelegramId }) {
  return withTransaction(async (session) => {
    const fresh = await AdminFundAction.findById(action._id).session(session);
    if (!fresh) throw Object.assign(new Error('Funding action was not found.'), { statusCode: 404 });
    if (fresh.status === 'reversed') return { replayed: true, action: fresh, balanceCents: fresh.balanceBeforeCents };

    const laterLedger = await LedgerEntry.exists({ user: fresh.targetUser, createdAt: { $gt: fresh.createdAt } }).session(session);
    if (laterLedger) throw Object.assign(new Error('RESET cannot be applied safely because later balance activity exists. Review the ledger manually.'), { statusCode: 409 });

    const result = await applyBalanceDelta({
      userId: fresh.targetUser, deltaCents: -fresh.amountCents, type: 'admin_fund_reversal',
      actorType: 'telegram_admin', actorId: actorTelegramId, referenceType: 'admin_fund',
      referenceId: fresh.sessionId, idempotencyKey: `admin-fund-reset:${fresh.sessionId}`,
      metadata: { reversesLedger: String(fresh.appliedLedger) }
    }, session);
    fresh.status = 'reversed';
    fresh.reversalLedger = result.ledger._id;
    fresh.reversedAt = new Date();
    await fresh.save({ session });
    return { replayed: false, action: fresh, balanceCents: result.balanceCents };
  });
}

module.exports = { withTransaction, applyBalanceDelta, createAdminFund, reverseAdminFund };
