(function (global) {
  'use strict';
  var CACHE_KEY = 'xytrion_current_user';

  function loginUrl() { return global.location.pathname.indexOf('/dashboard/') !== -1 ? '../login.html' : 'login.html'; }
  function getCurrentUser() { try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || null; } catch (_error) { return null; } }
  function cacheUser(user) {
    if (user) localStorage.setItem(CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHE_KEY);
  }
  function isLoggedIn() { return Boolean(getCurrentUser()); }
  function clearLegacyState() {
    ['xytrion_users', 'xytrion_session_id', 'user_balance', 'kyc_status', 'sessionId', 'tg_offset', 'tg_processed_updates', 'xytrion_email_log'].forEach(function (key) { localStorage.removeItem(key); });
  }
  function formatMoney(value) { return global.XytrionFormat ? global.XytrionFormat.money(value) : '$' + Number(value || 0).toFixed(2); }

  function refreshKYCBadges(status) {
    var normalized = status || 'unverified';
    var label = normalized === 'verified' ? 'Verified' : (normalized === 'under_review' ? 'Under Review' : 'Unverified');
    var color = normalized === 'verified' ? 'green' : (normalized === 'under_review' ? 'amber' : 'red');
    var html = '<span class="px-3 py-1 bg-' + color + '-500/20 text-' + color + '-400 border border-' + color + '-500/30 rounded-full text-xs font-medium">' + label + '</span>';
    var main = document.getElementById('kyc-status-display'); if (main) main.innerHTML = html;
    document.querySelectorAll('[data-kyc-badge]').forEach(function (el) { el.textContent = label; });
  }

  function hydrateUserProfile(user) {
    var current = user || getCurrentUser(); if (!current) return;
    var fullName = current.name || current.username || 'User'; var initial = fullName.charAt(0).toUpperCase();
    document.querySelectorAll('[data-user-welcome]').forEach(function (el) { el.textContent = 'Welcome back, ' + fullName + '!'; });
    document.querySelectorAll('[data-user-name], .user-name-text').forEach(function (el) { el.textContent = fullName; });
    document.querySelectorAll('[data-user-initial], [data-user-initials], .user-initial-text').forEach(function (el) { el.textContent = initial; });
    document.querySelectorAll('[data-user-email], .user-email-text').forEach(function (el) { el.textContent = current.email || ''; });
    document.querySelectorAll('.user-balance-text, [data-user-balance]').forEach(function (el) { el.textContent = formatMoney(current.balance); });
    document.querySelectorAll('[data-total-bonus], .user-bonus-text').forEach(function (el) { el.textContent = formatMoney(5); });
    var fields = { fullNameInput: fullName, emailAddress: current.email || '', phone: current.phone || '', username: current.username || '' };
    Object.keys(fields).forEach(function (id) { var el = document.getElementById(id); if (el) el.value = fields[id]; });
    var country = document.querySelector('select[name="country"]'); if (country && current.country) country.value = current.country;
    refreshKYCBadges(current.kyc_status);
  }

  async function refreshCurrentUser(options) {
    try {
      var data = await global.XytrionApi.request('/api/auth/me');
      clearLegacyState(); cacheUser(data.user); hydrateUserProfile(data.user);
      global.dispatchEvent(new CustomEvent('xytrion:user', { detail: data.user })); return data.user;
    } catch (error) {
      if (error.status === 401) {
        cacheUser(null);
        if (!options || options.redirect !== false) global.location.replace(loginUrl());
      }
      throw error;
    }
  }

  function requireLogin() {
    refreshCurrentUser().catch(function () {});
    return true;
  }
  async function logout() {
    try { await global.XytrionApi.request('/api/auth/logout', { method: 'POST' }); } catch (_error) {}
    clearLegacyState(); cacheUser(null); global.location.replace(loginUrl());
  }
  function getBalance() { var user = getCurrentUser(); return user && Number.isFinite(Number(user.balance)) ? Number(user.balance) : 0; }
  function refreshBalanceUI() { var value = formatMoney(getBalance()); document.querySelectorAll('.user-balance-text, [data-user-balance]').forEach(function (el) { el.textContent = value; }); }
  function updateUserBalance() { throw new Error('Balance changes are server-authoritative.'); }

  global.getCurrentUser = getCurrentUser; global.isLoggedIn = isLoggedIn; global.requireLogin = requireLogin;
  global.logout = logout; global.hydrateUserProfile = hydrateUserProfile; global.refreshCurrentUser = refreshCurrentUser;
  global.refreshKYCBadges = refreshKYCBadges; global.getBalance = getBalance; global.refreshBalanceUI = refreshBalanceUI;
  global.updateUserBalance = updateUserBalance;

  document.addEventListener('DOMContentLoaded', function () { hydrateUserProfile(); refreshCurrentUser().catch(function () {}); });
})(window);
