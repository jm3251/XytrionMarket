(function (global) {
  'use strict';
  function loginUrl() { return global.location.pathname.indexOf('/dashboard/') !== -1 ? '../login.html' : 'login.html'; }
  function clearClientCache() {
    ['xytrion_current_user', 'xytrion_users', 'xytrion_session_id', 'user_balance', 'kyc_status', 'sessionId', 'tg_offset', 'tg_processed_updates', 'xytrion_email_log'].forEach(function (key) { localStorage.removeItem(key); });
  }
  async function forceLogout() {
    try { await global.XytrionApi.request('/api/auth/logout', { method: 'POST' }); } catch (_error) {}
    clearClientCache(); global.location.replace(loginUrl());
  }
  function handleLogout(event) {
    if (event && event.preventDefault) event.preventDefault();
    var run = function () { forceLogout(); };
    if (global.Swal) {
      global.Swal.fire({ title: 'Sign Out', text: 'Are you sure you want to sign out?', icon: 'question', showCancelButton: true, confirmButtonText: 'Yes, sign out', confirmButtonColor: '#dc2626' }).then(function (result) { if (result.isConfirmed) run(); });
    } else if (global.confirm('Are you sure you want to sign out?')) run();
    return false;
  }
  async function guard() {
    try {
      await global.refreshCurrentUser({ redirect: false });
      var existing = document.getElementById('xytrion-connection-warning');
      if (existing) existing.remove();
    } catch (error) {
      if (error.status === 401) {
        clearClientCache(); global.location.replace(loginUrl());
        return;
      }
      if (!document.getElementById('xytrion-connection-warning')) {
        var warning = document.createElement('div');
        warning.id = 'xytrion-connection-warning';
        warning.setAttribute('role', 'alert');
        warning.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#7f1d1d;color:white;text-align:center;padding:10px';
        warning.textContent = 'Could not verify your account connection. Please check the server and refresh this page.';
        document.body.appendChild(warning);
      }
    }
  }
  global.handleLogout = handleLogout; global.logout = handleLogout; global.forceLogout = forceLogout;
  guard();
  global.addEventListener('pageshow', guard);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') guard(); });
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('button, a').forEach(function (el) {
      var label = (el.textContent || '').trim().toLowerCase();
      if (label === 'sign out' || label === 'logout' || label === 'log out') { el.setAttribute('type', 'button'); el.onclick = handleLogout; var form = el.closest('form'); if (form) form.onsubmit = function (event) { event.preventDefault(); }; }
    });
  });
})(window);
