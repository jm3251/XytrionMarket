'use strict';

const { config } = require('../config');
const { User, Deposit, Withdrawal, BotConversation, AdminFundAction, ChatMessage, TelegramState } = require('../models');
const { normalizeIdentifier, parseMoneyToCents, publicId, safeText } = require('../security');
const { withTransaction, applyBalanceDelta, createAdminFund, reverseAdminFund } = require('./balance');
const accountEvents = require('./account-events');
const { committed } = require('./notifications');

function html(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function money(cents) { return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function createTelegramService({ fetchImpl = fetch } = {}) {
  const base = config.telegram.token ? `https://api.telegram.org/bot${config.telegram.token}` : '';
  let stopped = false;
  let pollPromise = null;

  function configured() { return Boolean(base && config.telegram.adminChatId); }
  function isAdmin(update) {
    const from = update.callback_query ? update.callback_query.from : update.message && update.message.from;
    const chat = update.callback_query ? update.callback_query.message && update.callback_query.message.chat : update.message && update.message.chat;
    return Boolean(from && chat && String(chat.id) === config.telegram.adminChatId && config.telegram.adminUserIds.has(String(from.id)));
  }

  async function api(method, body, { form = false } = {}) {
    if (!configured()) return { ok: false, skipped: true, description: 'Telegram is not configured.' };
    const options = { method: 'POST' };
    if (form) options.body = body;
    else { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(body); }
    const response = await fetchImpl(`${base}/${method}`, options);
    let payload;
    try { payload = await response.json(); } catch { payload = { ok: false, description: `Telegram HTTP ${response.status}` }; }
    if (!response.ok || !payload.ok) throw new Error(safeText(payload.description || `Telegram HTTP ${response.status}`, 200));
    return payload;
  }

  async function sendMessage(text, replyMarkup = null, chatId = config.telegram.adminChatId) {
    const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const result = await api('sendMessage', body);
    return { delivered: Boolean(result.ok), result };
  }

  async function sendPhoto(caption, file, replyMarkup = null) {
    if (!file || !file.buffer) return sendMessage(caption, replyMarkup);
    const form = new FormData();
    form.append('chat_id', config.telegram.adminChatId);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('photo', new Blob([file.buffer], { type: file.mimetype }), safeText(file.originalname, 150));
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    const result = await api('sendPhoto', form, { form: true });
    return { delivered: Boolean(result.ok), result };
  }

  async function answerCallback(callbackId, text, alert = false) {
    if (!callbackId) return;
    await api('answerCallbackQuery', { callback_query_id: callbackId, text: safeText(text, 180), show_alert: alert }).catch(() => {});
  }

  async function feedback({ sessionId, button, status, error = '' }) {
    const suffix = error ? `\n└ Error: ${html(safeText(error, 220))}` : '';
    return sendMessage(`🔄 <b>Action Triggered</b>\n├ Session: <code>${html(sessionId)}</code>\n├ Button: <b>${html(button)}</b>\n└ Status: ${html(status)}${suffix}`);
  }

  async function notify(type, { user }) {
    const labels = { registration: 'New account registered', login: 'Account login' };
    return sendMessage(`ℹ️ <b>${html(labels[type] || 'Account event')}</b>\n├ User: ${html(user.name)}\n├ Username: <code>${html(user.username)}</code>\n└ Email: <code>${html(user.email)}</code>`);
  }

  async function notifyDeposit({ deposit, user, proof }) {
    const keyboard = { inline_keyboard: [
      [{ text: '⏳ PENDING', callback_data: `dep:pending:${deposit.publicId}` }, { text: '✅ RECEIVED', callback_data: `dep:received:${deposit.publicId}` }],
      [{ text: '➕ ADD FUND', callback_data: `fund:start:${deposit.publicId}` }, { text: '↩ RESET', callback_data: `fund:reset:${deposit.publicId}` }]
    ] };
    const caption = `💰 <b>Deposit Proof Submitted</b>\n├ User: ${html(user.name)} (${html(user.email)})\n├ Session: <code>${html(deposit.sessionId)}</code>\n├ Deposit: <code>${html(deposit.publicId)}</code>\n├ Amount: <b>$${money(deposit.amountCents)}</b>\n├ Asset: ${html(deposit.asset)}\n├ Network: ${html(deposit.network)}\n└ Address: <code>${html(deposit.address)}</code>`;
    return sendPhoto(caption, proof, keyboard);
  }

  async function notifyWithdrawal({ withdrawal, user }) {
    const keyboard = { inline_keyboard: [[
      { text: '⏳ PENDING', callback_data: `wd:pending:${withdrawal.publicId}` },
      { text: '✅ COMPLETED', callback_data: `wd:completed:${withdrawal.publicId}` }
    ]] };
    return sendMessage(`💸 <b>Withdrawal Request Submitted</b>\n├ User: ${html(user.name)} (${html(user.email)})\n├ Session: <code>${html(withdrawal.sessionId)}</code>\n├ Withdrawal: <code>${html(withdrawal.publicId)}</code>\n├ Amount: <b>$${money(withdrawal.amountCents)}</b>\n├ Fee: <b>$${money(withdrawal.feeCents)}</b>\n├ Asset: ${html(withdrawal.asset)}\n└ Destination: <code>${html(withdrawal.destination)}</code>`, keyboard);
  }

  async function notifyKyc({ user, data, front }) {
    const sessionId = publicId('KYC');
    const keyboard = { inline_keyboard: [[
      { text: '⏳ UNDER REVIEW', callback_data: `kyc:review:${user._id}` },
      { text: '✅ VERIFIED', callback_data: `kyc:verified:${user._id}` }
    ]] };
    const caption = `🪪 <b>KYC Application Received</b>\n├ Session: <code>${html(sessionId)}</code>\n├ User: ${html(user.name)} (${html(user.email)})\n├ Document: ${html(data.document_type || 'N/A')}\n└ Country: ${html(data.country || user.country || 'N/A')}`;
    return sendPhoto(caption, front, keyboard);
  }

  async function notifyChat({ sessionId, message, user }) {
    return sendMessage(`📨 <b>New Message — Xytrion Markets</b>\n├ Session: <code>${html(sessionId)}</code>\n├ User: ${html(user.name)} &lt;${html(user.email)}&gt;\n└ Message: ${html(message)}\n\nReply with: <code>/reply_${html(sessionId)} your message</code>`);
  }

  async function depositPending(dep, actorId) {
    const result = await withTransaction(async (session) => {
      const current = await Deposit.findById(dep._id).session(session);
      if (!current || !['processing', 'pending'].includes(current.status)) throw Object.assign(new Error('Only a processing or pending deposit can be marked pending.'), { statusCode: 409 });
      current.status = 'pending'; await current.save({ session });
      const user = await User.findOne({ _id: current.user, status: 'active' }).session(session);
      if (user) await accountEvents.depositStatus(user, current, session);
      return { sessionId: current.sessionId, actorId };
    });
    committed(dep.user);
    return result;
  }

  async function depositReceived(dep, actorId) {
    const result = await withTransaction(async (session) => {
      const current = await Deposit.findById(dep._id).session(session);
      if (current.status === 'received') return { replayed: true, sessionId: current.sessionId };
      if (!['processing', 'pending'].includes(current.status)) throw Object.assign(new Error('Only a processing or pending deposit can be received.'), { statusCode: 409 });
      const balance = await applyBalanceDelta({ userId: current.user, deltaCents: current.amountCents, type: 'deposit_credit', actorType: 'telegram_admin', actorId, referenceType: 'deposit', referenceId: current.publicId, idempotencyKey: `deposit-credit:${current.publicId}` }, session);
      current.status = 'received'; current.creditedAt = new Date(); await current.save({ session });
      const user = await User.findOne({ _id: current.user, status: 'active' }).session(session);
      if (user) await accountEvents.depositStatus(user, current, session);
      return { replayed: balance.replayed, sessionId: current.sessionId, balanceCents: balance.balanceCents };
    });
    committed(dep.user);
    return result;
  }

  async function withdrawalPending(withdrawal) {
    const result = await withTransaction(async (session) => {
      const current = await Withdrawal.findById(withdrawal._id).session(session);
      if (!current || !['processing', 'pending'].includes(current.status)) throw Object.assign(new Error('Only a processing or pending withdrawal can be marked pending.'), { statusCode: 409 });
      current.status = 'pending'; await current.save({ session });
      const user = await User.findOne({ _id: current.user, status: 'active' }).session(session);
      if (user) await accountEvents.withdrawalStatus(user, current, session);
      return { sessionId: current.sessionId };
    });
    committed(withdrawal.user);
    return result;
  }

  async function withdrawalCompleted(withdrawal, actorId) {
    const result = await withTransaction(async (session) => {
      const current = await Withdrawal.findById(withdrawal._id).session(session);
      if (current.status === 'completed') return { replayed: true, sessionId: current.sessionId };
      if (!['processing', 'pending'].includes(current.status)) throw Object.assign(new Error('Only a processing or pending withdrawal can be completed.'), { statusCode: 409 });
      const balance = await applyBalanceDelta({ userId: current.user, deltaCents: -(current.amountCents + current.feeCents), type: 'withdrawal_debit', actorType: 'telegram_admin', actorId, referenceType: 'withdrawal', referenceId: current.publicId, idempotencyKey: `withdrawal-debit:${current.publicId}` }, session);
      current.status = 'completed'; current.completedAt = new Date(); await current.save({ session });
      const user = await User.findOne({ _id: current.user, status: 'active' }).session(session);
      if (user) await accountEvents.withdrawalStatus(user, current, session);
      return { replayed: balance.replayed, sessionId: current.sessionId, balanceCents: balance.balanceCents };
    });
    committed(withdrawal.user);
    return result;
  }

  async function beginAddFund({ telegramUserId, chatId, source, sourceReference = '' }) {
    await BotConversation.deleteMany({ telegramUserId, chatId });
    const conversation = await BotConversation.create({ publicId: publicId('ACT'), telegramUserId, chatId, state: 'await_identifier', source, sourceReference, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
    await sendMessage(`➕ <b>ADD FUND</b>\nSession: <code>${conversation.publicId}</code>\nEnter user email or username:`, null, chatId);
    return conversation;
  }

  async function beginReset({ deposit, telegramUserId, chatId }) {
    const actions = await AdminFundAction.find({ targetUser: deposit.user, status: 'applied' }).sort({ createdAt: -1 }).limit(2);
    if (actions.length !== 1) throw new Error(actions.length ? 'RESET cannot safely choose between multiple unreversed funding actions. Use /reset ACTION_SESSION.' : 'No reversible administrative funding was found for this user.');
    const action = actions[0];
    await BotConversation.deleteMany({ telegramUserId, chatId });
    const conversation = await BotConversation.create({ publicId: publicId('RST'), telegramUserId, chatId, state: 'await_confirmation', targetUser: action.targetUser, amountCents: action.amountCents, source: 'button', sourceReference: action.sessionId, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
    await sendMessage(`↩ <b>Confirm RESET</b>\n├ Action: <code>${html(action.sessionId)}</code>\n├ Amount to reverse: <b>$${money(action.amountCents)}</b>\n└ This is allowed only when no later balance activity exists.`, { inline_keyboard: [[{ text: '✅ CONFIRM RESET', callback_data: `reset:confirm:${conversation.publicId}` }, { text: '✖ CANCEL', callback_data: `flow:cancel:${conversation.publicId}` }]] }, chatId);
    return conversation;
  }

  async function processConversation(message) {
    const telegramUserId = String(message.from.id); const chatId = String(message.chat.id);
    const text = safeText(message.text, 300);
    const conversation = await BotConversation.findOne({ telegramUserId, chatId, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    if (!conversation) return false;
    if (conversation.state === 'await_identifier') {
      const identifier = normalizeIdentifier(text);
      const user = await User.findOne({ $or: [{ emailNormalized: identifier }, { usernameNormalized: identifier }], status: 'active' });
      if (!user) { await sendMessage('❌ User not found. Enter a valid email or username, or /cancel.', null, chatId); return true; }
      conversation.targetUser = user._id; conversation.state = 'await_amount'; conversation.expiresAt = new Date(Date.now() + 15 * 60 * 1000); await conversation.save();
      await sendMessage(`User found: <b>${html(user.name)}</b> (${html(user.email)})\nEnter amount to add:`, null, chatId); return true;
    }
    if (conversation.state === 'await_amount') {
      let amountCents;
      try { amountCents = parseMoneyToCents(text, { minCents: 1, maxCents: 100000000000 }); }
      catch (error) { await sendMessage(`❌ ${html(error.message)} Try again or /cancel.`, null, chatId); return true; }
      conversation.amountCents = amountCents; conversation.state = 'await_confirmation'; conversation.expiresAt = new Date(Date.now() + 10 * 60 * 1000); await conversation.save();
      const user = await User.findById(conversation.targetUser);
      await sendMessage(`➕ <b>Confirm ADD FUND</b>\n├ Session: <code>${conversation.publicId}</code>\n├ User: ${html(user.email)}\n└ Amount: <b>$${money(amountCents)}</b>`, { inline_keyboard: [[{ text: '✅ CONFIRM ADD FUND', callback_data: `fund:confirm:${conversation.publicId}` }, { text: '✖ CANCEL', callback_data: `flow:cancel:${conversation.publicId}` }]] }, chatId);
      return true;
    }
    return true;
  }

  async function handleCallback(update) {
    const cb = update.callback_query; const data = safeText(cb.data, 100); const actorId = String(cb.from.id); const chatId = String(cb.message.chat.id);
    let sessionId = data.split(':').slice(-1)[0] || 'unknown'; let button = data;
    try {
      if (data.startsWith('dep:')) {
        const [, action, publicIdValue] = data.split(':'); const dep = await Deposit.findOne({ publicId: publicIdValue });
        if (!dep) throw new Error('Deposit not found.'); sessionId = dep.sessionId; button = action === 'pending' ? 'PENDING' : 'RECEIVED';
        if (action === 'pending') await depositPending(dep, actorId); else if (action === 'received') await depositReceived(dep, actorId); else throw new Error('Unknown deposit action.');
        await answerCallback(cb.id, `${button} applied`); await feedback({ sessionId, button, status: 'Successfully Received & Applied' }); return;
      }
      if (data.startsWith('wd:')) {
        const [, action, publicIdValue] = data.split(':'); const withdrawal = await Withdrawal.findOne({ publicId: publicIdValue });
        if (!withdrawal) throw new Error('Withdrawal not found.'); sessionId = withdrawal.sessionId; button = action === 'pending' ? 'PENDING' : 'COMPLETED';
        if (action === 'pending') await withdrawalPending(withdrawal);
        else if (action === 'completed') await withdrawalCompleted(withdrawal, actorId); else throw new Error('Unknown withdrawal action.');
        await answerCallback(cb.id, `${button} applied`); await feedback({ sessionId, button, status: 'Successfully Received & Applied' }); return;
      }
      if (data.startsWith('kyc:')) {
        const [, action, userId] = data.split(':'); button = action === 'verified' ? 'VERIFIED' : 'UNDER REVIEW'; sessionId = String(userId);
        const status = action === 'verified' ? 'verified' : 'under_review'; const user = await User.findOneAndUpdate({ _id: userId, status: 'active' }, { $set: { kycStatus: status } });
        if (!user) throw new Error('User not found.'); await answerCallback(cb.id, `${button} applied`); await feedback({ sessionId, button, status: 'Successfully Received & Applied' }); return;
      }
      if (data.startsWith('fund:start:')) {
        const depId = data.split(':')[2]; const dep = await Deposit.findOne({ publicId: depId }); if (!dep) throw new Error('Deposit not found.');
        const conv = await beginAddFund({ telegramUserId: actorId, chatId, source: 'button', sourceReference: depId });
        sessionId = conv.publicId; button = 'ADD FUND'; await answerCallback(cb.id, 'ADD FUND started'); await feedback({ sessionId, button, status: 'Successfully Received — Awaiting User Identifier' }); return;
      }
      if (data.startsWith('fund:confirm:')) {
        const id = data.split(':')[2]; const conv = await BotConversation.findOne({ publicId: id, telegramUserId: actorId, chatId, state: 'await_confirmation' });
        if (!conv || !conv.targetUser || !conv.amountCents) throw new Error('ADD FUND session is invalid or expired.'); sessionId = conv.publicId; button = 'ADD FUND';
        const result = await createAdminFund({ userId: conv.targetUser, amountCents: conv.amountCents, actorTelegramId: actorId, source: conv.source, sourceReference: conv.sourceReference, sessionId: conv.publicId });
        const user = await User.findById(conv.targetUser); await BotConversation.deleteOne({ _id: conv._id });
        await sendMessage(`✅ Added <b>$${money(conv.amountCents)}</b> to ${html(user.email)}.\nResulting balance: <b>$${money(result.balanceCents || result.action.balanceAfterCents)}</b>\nAction: <code>${conv.publicId}</code>`, null, chatId);
        await answerCallback(cb.id, 'Funds added'); await feedback({ sessionId, button, status: 'Successfully Received & Applied' }); return;
      }
      if (data.startsWith('fund:reset:')) {
        const depId = data.split(':')[2]; const dep = await Deposit.findOne({ publicId: depId }); if (!dep) throw new Error('Deposit not found.');
        const conv = await beginReset({ deposit: dep, telegramUserId: actorId, chatId }); sessionId = conv.publicId; button = 'RESET';
        await answerCallback(cb.id, 'RESET confirmation requested'); await feedback({ sessionId, button, status: 'Successfully Received — Awaiting Confirmation' }); return;
      }
      if (data.startsWith('reset:confirm:')) {
        const id = data.split(':')[2]; const conv = await BotConversation.findOne({ publicId: id, telegramUserId: actorId, chatId, state: 'await_confirmation' });
        if (!conv || !conv.sourceReference) throw new Error('RESET session is invalid or expired.'); sessionId = conv.publicId; button = 'RESET';
        const action = await AdminFundAction.findOne({ sessionId: conv.sourceReference }); if (!action) throw new Error('Funding action not found.');
        const result = await reverseAdminFund({ action, actorTelegramId: actorId }); await BotConversation.deleteOne({ _id: conv._id });
        await sendMessage(`↩ Reversed <b>$${money(action.amountCents)}</b>.\nRestored balance: <b>$${money(result.balanceCents)}</b>\nAction: <code>${html(action.sessionId)}</code>`, null, chatId);
        await answerCallback(cb.id, 'Funding reversed'); await feedback({ sessionId, button, status: 'Successfully Received & Applied' }); return;
      }
      if (data.startsWith('flow:cancel:')) {
        await BotConversation.deleteOne({ publicId: data.split(':')[2], telegramUserId: actorId, chatId }); await answerCallback(cb.id, 'Cancelled');
        await feedback({ sessionId, button: 'CANCEL', status: 'Successfully Received & Applied' }); return;
      }
      throw new Error('Unknown action.');
    } catch (error) {
      await answerCallback(cb.id, safeText(error.message, 180), true);
      await feedback({ sessionId, button, status: 'Failed', error: error.message }).catch(() => {});
    }
  }

  async function handleMessage(update) {
    const message = update.message; const text = safeText(message.text, 2200); const actorId = String(message.from.id); const chatId = String(message.chat.id);
    if (/^\/cancel\b/i.test(text)) { await BotConversation.deleteMany({ telegramUserId: actorId, chatId }); await sendMessage('Current administrative action cancelled.', null, chatId); return; }
    if (/^\/addfund\b/i.test(text) || /^\/add\s+fund\b/i.test(text)) { const conv = await beginAddFund({ telegramUserId: actorId, chatId, source: 'command' }); await feedback({ sessionId: conv.publicId, button: '/addfund', status: 'Successfully Received — Awaiting User Identifier' }); return; }
    const resetMatch = text.match(/^\/reset\s+([A-Za-z0-9-]+)$/i);
    if (resetMatch) {
      const action = await AdminFundAction.findOne({ sessionId: resetMatch[1], status: 'applied' }); if (!action) { await feedback({ sessionId: resetMatch[1], button: '/reset', status: 'Failed', error: 'Reversible funding action not found.' }); return; }
      const result = await reverseAdminFund({ action, actorTelegramId: actorId }); await sendMessage(`↩ Reversed <b>$${money(action.amountCents)}</b>. Restored balance: <b>$${money(result.balanceCents)}</b>.`, null, chatId); await feedback({ sessionId: action.sessionId, button: '/reset', status: 'Successfully Received & Applied' }); return;
    }
    const replyMatch = text.match(/^\/reply_([A-Za-z0-9-]{6,80})\s+([\s\S]+)$/i);
    if (replyMatch) {
      const last = await ChatMessage.findOne({ sessionId: replyMatch[1], sender: 'user' }).sort({ createdAt: -1 });
      if (!last) { await sendMessage('❌ Chat session not found.', null, chatId); return; }
      await ChatMessage.create({ sessionId: replyMatch[1], user: last.user, sender: 'support', text: safeText(replyMatch[2], 2000), externalUpdateId: update.update_id });
      await feedback({ sessionId: replyMatch[1], button: 'CHAT REPLY', status: 'Successfully Received & Applied' }); return;
    }
    await processConversation(message);
  }

  async function processUpdate(update) {
    if (!update || (!update.callback_query && !update.message)) return;
    if (!isAdmin(update)) {
      if (update.callback_query) { await answerCallback(update.callback_query.id, 'Not authorized.', true); await feedback({ sessionId: 'unauthorized', button: safeText(update.callback_query.data, 80), status: 'Failed', error: 'Unauthorized Telegram user or chat.' }).catch(() => {}); }
      return;
    }
    if (update.callback_query) return handleCallback(update);
    return handleMessage(update);
  }

  async function pollLoop() {
    let state = await TelegramState.findOne({ key: 'update-offset' }); let offset = Number(state && state.value || 0);
    while (!stopped) {
      try {
        const response = await fetchImpl(`${base}/getUpdates?offset=${offset}&timeout=25&allowed_updates=${encodeURIComponent(JSON.stringify(['message','callback_query']))}`);
        const payload = await response.json();
        if (!payload.ok) throw new Error(safeText(payload.description, 120));
        for (const update of payload.result || []) {
          await processUpdate(update);
          offset = Math.max(offset, Number(update.update_id) + 1);
          await TelegramState.findOneAndUpdate({ key: 'update-offset' }, { $set: { value: offset } }, { upsert: true });
        }
      } catch (error) {
        if (!stopped) { console.error('Telegram polling error:', safeText(error.message, 160)); await new Promise((resolve) => setTimeout(resolve, 5000)); }
      }
    }
  }

  function startPolling() {
    if (!configured() || !config.telegram.pollingEnabled || pollPromise) return false;
    stopped = false; pollPromise = pollLoop().finally(() => { pollPromise = null; }); return true;
  }
  function stopPolling() { stopped = true; }

  return { configured, isAdmin, sendMessage, feedback, notify, notifyDeposit, notifyWithdrawal, notifyKyc, notifyChat, processUpdate, startPolling, stopPolling };
}

module.exports = { createTelegramService, html, money };
