(function (global) {
  'use strict';
  var deposits = []; var withdrawals = [];
  function api(path, options) { return global.XytrionApi.request(path, options); }
  function escapeHtml(value) { var div = document.createElement('div'); div.textContent = String(value == null ? '' : value); return div.innerHTML; }
  function money(value) { return global.XytrionFormat.money(value); }
  function showDate(value) { var parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(); }
  function badge(status) {
    var done = status === 'received' || status === 'completed'; var waiting = status === 'pending';
    var color = done ? 'green' : (waiting ? 'amber' : 'blue'); var label = done ? (status === 'completed' ? 'Completed' : 'Received') : (waiting ? 'Pending' : 'Processing');
    return '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-' + color + '-500/20 text-' + color + '-400 border border-' + color + '-500/30">' + label + '</span>';
  }
  function cards(list, type) {
    return list.map(function (tx) {
      return '<div class="bg-gray-800 rounded-xl p-4 border border-gray-700"><div class="flex justify-between"><div><div class="text-white font-medium">' + (type === 'deposit' ? 'Deposit' : 'Withdrawal') + '</div><div class="text-slate-400 text-sm">' + escapeHtml(tx.method || tx.coin || '') + '</div></div><div class="text-right"><div class="text-white font-medium">' + money(tx.amount) + '</div>' + badge(tx.status) + '</div></div><div class="mt-2 text-xs text-slate-400 break-all">' + escapeHtml(tx.network || '') + (tx.network ? ' · ' : '') + escapeHtml(tx.walletAddress || '') + '</div><div class="mt-2 text-xs text-slate-500">' + escapeHtml(showDate(tx.date)) + '</div></div>';
    }).join('');
  }
  function rows(list, type) {
    return list.map(function (tx) {
      return '<tr class="hover:bg-gray-800/50"><td class="px-6 py-4 text-white">' + (type === 'deposit' ? 'Deposit' : 'Withdrawal') + '</td><td class="px-6 py-4 text-white">' + money(tx.amount) + '</td><td class="px-6 py-4 text-slate-300">' + escapeHtml(tx.method || tx.coin || '') + '</td><td class="px-6 py-4 text-slate-300 font-mono text-xs break-all">' + escapeHtml(tx.walletAddress || '') + '</td><td class="px-6 py-4">' + badge(tx.status) + '</td><td class="px-6 py-4 text-slate-300">' + escapeHtml(showDate(tx.date)) + '</td></tr>';
    }).join('');
  }
  function render(list, type, mobile, desktop, legacy) {
    if (!list.length) {
      var empty = '<div class="text-center py-12 text-slate-400">No ' + type + 's yet</div>';
      if (mobile) mobile.innerHTML = empty; if (desktop) desktop.innerHTML = empty;
      if (legacy) legacy.innerHTML = '<tr><td colspan="6" class="px-6 py-12 text-center text-gray-400">No ' + type + 's yet</td></tr>'; return;
    }
    if (mobile) mobile.innerHTML = cards(list, type);
    var tableRows = rows(list, type);
    if (desktop) desktop.innerHTML = '<table class="w-full"><thead class="bg-gray-800"><tr><th class="px-6 py-4 text-left">Type</th><th class="px-6 py-4 text-left">Amount</th><th class="px-6 py-4 text-left">Asset</th><th class="px-6 py-4 text-left">Address</th><th class="px-6 py-4 text-left">Status</th><th class="px-6 py-4 text-left">Date</th></tr></thead><tbody class="divide-y divide-gray-700">' + tableRows + '</tbody></table>';
    if (legacy) legacy.innerHTML = tableRows;
  }
  function renderDepositHistory() { render(deposits, 'deposit', document.getElementById('deposit-history-mobile'), document.getElementById('deposit-history-desktop')); }
  function renderWithdrawalHistory() { render(withdrawals, 'withdrawal', document.getElementById('withdrawal-history-mobile'), document.getElementById('withdrawal-history-desktop'), document.getElementById('withdrawal-history-tbody')); }
  async function loadTransactions() {
    try {
      var data = await api('/api/transactions'); deposits = data.deposits || []; withdrawals = data.withdrawals || [];
      renderDepositHistory(); renderWithdrawalHistory();
      if (global.refreshCurrentUser) await global.refreshCurrentUser({ redirect: false });
    } catch (_error) { /* session guard handles expiry */ }
  }
  async function notifyDeposit(amount, method, proofFile) {
    var form = new FormData(); form.append('amount', amount); form.append('method', method); form.append('proof', proofFile);
    var data = await api('/api/deposits', { method: 'POST', body: form }); await loadTransactions(); return data.transaction.id;
  }
  async function notifyWithdrawal(amount, walletAddress, coin) {
    var data = await api('/api/withdrawals', { method: 'POST', body: { amount: amount, destination: walletAddress, asset: coin } }); await loadTransactions(); return data.transaction.id;
  }
  async function notifyKYC(data, frontFile, backFile) {
    var form = new FormData(); Object.keys(data || {}).forEach(function (key) { form.append(key, data[key]); });
    form.append('frontimg', frontFile); if (backFile && backFile.size) form.append('backimg', backFile);
    var result = await api('/api/kyc', { method: 'POST', body: form }); if (global.refreshCurrentUser) await global.refreshCurrentUser({ redirect: false }); return result;
  }
  function getKYCStatus() { var user = global.getCurrentUser && global.getCurrentUser(); return user ? user.kyc_status : 'unverified'; }
  function setKYCStatus(status) { if (global.refreshKYCBadges) global.refreshKYCBadges(status); }
  function showNotification(title, text, icon) { if (global.Swal) global.Swal.fire({ title: title, text: text, icon: icon || 'info', toast: true, position: 'top-end', showConfirmButton: false, timer: 5000 }); }
  function rejectClientBalanceMutation() { throw new Error('Balance changes are server-authoritative.'); }

  Object.assign(global, {
    notifyDeposit: notifyDeposit, notifyWithdrawal: notifyWithdrawal, notifyKYC: notifyKYC,
    notifyRegistration: function () { return Promise.resolve({ ok: true }); }, notifyLogin: function () { return Promise.resolve({ ok: true }); },
    getDepositTransactions: function () { return deposits.slice(); }, getWithdrawalTransactions: function () { return withdrawals.slice(); },
    renderDepositHistory: renderDepositHistory, renderWithdrawalHistory: renderWithdrawalHistory,
    getKYCStatus: getKYCStatus, setKYCStatus: setKYCStatus, showNotification: showNotification,
    updateBalance: rejectClientBalanceMutation, deductBalance: rejectClientBalanceMutation, startDecisionPolling: loadTransactions
  });
  document.addEventListener('DOMContentLoaded', function () { loadTransactions(); setInterval(loadTransactions, 15000); });
})(window);
