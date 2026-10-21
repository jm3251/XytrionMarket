'use strict';

const { notifyUser } = require('./notifications');
const { publicId } = require('../security');

function money(cents) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100); }

function registered(user, dbSession = null) {
  return notifyUser({
    user, dbSession, eventKey: `registration:${user._id}`, type: 'registration',
    title: 'Account created', message: `Welcome, ${user.name}. Your Xytrion Markets account is ready.`,
    actionUrl: '/dashboard.html',
    email: {
      subject: 'Your Xytrion Markets account was created',
      text: `Hello ${user.name},\n\nYour Xytrion Markets account was created successfully.\nUsername: ${user.username}\n\nIf you did not create this account, contact support through the website.\n\nXytrion Markets`
    }
  });
}

function loggedIn(user) {
  return notifyUser({
    user, eventKey: `login:${publicId('LOG')}`, type: 'login',
    title: 'New login', message: 'Your account was signed in successfully. If this was not you, change your password and contact support.',
    actionUrl: '/dashboard/account-settings.html'
  });
}

function deposited(user, deposit, dbSession = null) {
  const amount = money(deposit.amountCents);
  return notifyUser({
    user, dbSession, eventKey: `deposit:${deposit.publicId}`, type: 'deposit',
    title: 'Deposit request submitted', message: `${amount} ${deposit.asset} (${deposit.network}) proof received. Reference ${deposit.publicId}. Awaiting review; funds have not been credited yet.`,
    actionUrl: '/dashboard/accounthistory.html',
    email: {
      subject: `Deposit request received — ${deposit.publicId}`,
      text: `Hello ${user.name},\n\nWe received your deposit proof.\nReference: ${deposit.publicId}\nAmount: ${amount}\nAsset: ${deposit.asset}\nNetwork: ${deposit.network}\nStatus: Processing — your account has not been credited yet.\n\nYou can check the status in your account statement. If you did not submit this request, contact support through the website.\n\nXytrion Markets`
    }
  });
}

function withdrawn(user, withdrawal, dbSession = null) {
  const amount = money(withdrawal.amountCents);
  return notifyUser({
    user, dbSession, eventKey: `withdrawal:${withdrawal.publicId}`, type: 'withdrawal',
    title: 'Withdrawal request submitted', message: `${amount} ${withdrawal.asset} withdrawal requested. Reference ${withdrawal.publicId}. Processing; funds have not been sent yet.`,
    actionUrl: '/dashboard/withdrawals.html',
    email: {
      subject: `Withdrawal request received — ${withdrawal.publicId}`,
      text: `Hello ${user.name},\n\nWe received your withdrawal request.\nReference: ${withdrawal.publicId}\nAmount: ${amount}\nAsset: ${withdrawal.asset}\nStatus: Processing — this withdrawal has not been completed or sent yet.\n\nYou can check the status in your account statement. If you did not submit this request, change your password and contact support through the website.\n\nXytrion Markets`
    }
  });
}

function invested(user, investment, dbSession = null) {
  return notifyUser({
    user, dbSession, eventKey: `investment:${investment.publicId}`, type: 'invest',
    title: 'AI bot investment started', message: `${money(investment.amountCents)} allocated to ${investment.botName}. Reference ${investment.publicId}. Simulated returns are not guaranteed.`,
    actionUrl: '/dashboard/bot-trading.html'
  });
}

function depositStatus(user, deposit, dbSession = null) {
  const content = {
    processing: ['Deposit processing', `Deposit ${deposit.publicId} is processing.`],
    pending: ['Deposit pending', `Deposit ${deposit.publicId} is pending review.`],
    received: ['Deposit credited', `${money(deposit.amountCents)} deposit ${deposit.publicId} has been credited to your account.`],
    failed: ['Deposit not approved', `Deposit ${deposit.publicId} was not approved. Contact support for details.`]
  }[deposit.status];
  if (!content) throw new Error('Unknown deposit status.');
  return notifyUser({ user, dbSession, eventKey: `deposit_status:${deposit.publicId}:${deposit.status}`,
    type: 'deposit_status', title: content[0], message: content[1], actionUrl: '/dashboard/accounthistory.html' });
}

function withdrawalStatus(user, withdrawal, dbSession = null) {
  const content = {
    processing: ['Withdrawal processing', `Withdrawal ${withdrawal.publicId} is processing.`],
    pending: ['Withdrawal pending', `Withdrawal ${withdrawal.publicId} is pending review.`],
    completed: ['Withdrawal completed', `${money(withdrawal.amountCents)} withdrawal ${withdrawal.publicId} was marked completed.`],
    failed: ['Withdrawal not approved', `Withdrawal ${withdrawal.publicId} was not approved. Contact support for details.`]
  }[withdrawal.status];
  if (!content) throw new Error('Unknown withdrawal status.');
  return notifyUser({ user, dbSession, eventKey: `withdrawal_status:${withdrawal.publicId}:${withdrawal.status}`,
    type: 'withdrawal_status', title: content[0], message: content[1], actionUrl: '/dashboard/withdrawals.html' });
}

module.exports = { registered, loggedIn, deposited, withdrawn, invested, depositStatus, withdrawalStatus };
