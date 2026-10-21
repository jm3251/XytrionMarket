(function (global) {
  'use strict';
  var previousFocus = null;
  var previousSidebar = false;
  var previousTheme = null;
  var queued = false;
  var values = {};
  function visible(element) { return Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'); }
  function setVariable(name, value) {
    if (values[name] === value) return;
    values[name] = value;
    document.documentElement.style.setProperty(name, value);
  }
  function data(element) {
    if (!global.Alpine || !element) return null;
    try { return global.Alpine.$data(element); } catch (_error) { return null; }
  }
  function syncTheme(theme) {
    var dark = (theme || localStorage.getItem('theme') || 'dark') === 'dark';
    if (previousTheme === dark) return;
    previousTheme = dark;
    document.querySelectorAll('[x-data]').forEach(function (element) {
      var state = data(element);
      if (state && typeof state.darkMode === 'boolean') state.darkMode = dark;
    });
    document.documentElement.classList.toggle('dark', dark);
    document.body.classList.toggle('dark', dark);
    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) { button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme'); });
  }
  function setSidebar(open) {
    var state = data(document.body);
    if (state) state.sidebarOpen = Boolean(open);
    syncLayout();
  }
  function closeModalState() {
    document.querySelectorAll('[data-responsive-modal]').forEach(function (element) {
      var state = data(element);
      if (state && typeof state.fabOpen === 'boolean') state.fabOpen = false;
      if (state && typeof state.showConfirmModal === 'boolean') state.showConfirmModal = false;
    });
  }
  function syncLayout() {
    queued = false;
    var desktop = global.matchMedia('(min-width: 1024px)').matches;
    var header = document.querySelector('[data-responsive-navbar]') || document.querySelector('header');
    var headerHeight = visible(header) ? Math.round(header.getBoundingClientRect().height) : 0;
    var bottomHeight = 0;
    document.querySelectorAll('[data-responsive-bottom-bar]').forEach(function (bar) { if (visible(bar)) bottomHeight = Math.max(bottomHeight, Math.round(bar.getBoundingClientRect().height)); });
    var vv = global.visualViewport;
    var height = vv ? vv.height : global.innerHeight;
    var keyboard = vv ? Math.max(0, global.innerHeight - vv.height - vv.offsetTop) : 0;
    var chatClearance = bottomHeight;
    var floatingActions = document.querySelector('[data-responsive-floating-actions]');
    if (visible(floatingActions)) chatClearance = Math.max(chatClearance, global.innerHeight - floatingActions.getBoundingClientRect().top);
    setVariable('--xyt-header-height', headerHeight + 'px');
    setVariable('--xyt-bottom-height', bottomHeight + 'px');
    setVariable('--xyt-viewport-height', Math.round(height) + 'px');
    setVariable('--xyt-keyboard-offset', Math.round(keyboard) + 'px');
    setVariable('--xyt-chat-clearance', (keyboard > 100 ? 0 : Math.round(chatClearance)) + 'px');
    var state = data(document.body);
    if (desktop && state && state.sidebarOpen) state.sidebarOpen = false;
    var open = Boolean(!desktop && state && state.sidebarOpen);
    var backdrop = document.querySelector('[data-responsive-sidebar-backdrop]');
    if (backdrop) backdrop.hidden = !open;
    var sidebar = document.querySelector('[data-responsive-sidebar]');
    document.querySelectorAll('[data-sidebar-toggle]').forEach(function (button) { button.setAttribute('aria-expanded', String(open)); button.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu'); });
    if (sidebar) {
      sidebar.setAttribute('aria-hidden', String(!desktop && !open));
      sidebar.inert = !desktop && !open;
    }
    if (open && !previousSidebar) {
      previousFocus = document.activeElement;
      var close = document.querySelector('[data-sidebar-close]');
      if (close) close.focus({ preventScroll: true });
    } else if (!open && previousSidebar && previousFocus && document.contains(previousFocus)) previousFocus.focus({ preventScroll: true });
    previousSidebar = open;
    var modal = [...document.querySelectorAll('[data-responsive-modal]')].some(visible) || document.body.classList.contains('swal2-shown');
    document.documentElement.classList.toggle('xyt-scroll-locked', open || modal);
    document.documentElement.classList.toggle('xyt-modal-open', modal);
    document.querySelectorAll('[data-responsive-public-toggle]').forEach(function (button) {
      var state = data(button);
      var expanded = Boolean(state && state.mobileMenuOpen);
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('aria-label', expanded ? 'Close main menu' : 'Open main menu');
    });
  }
  function schedule() { if (!queued) { queued = true; global.requestAnimationFrame(syncLayout); } }
  async function copyText(text) {
    if (!text) throw new Error('There is no address or link to copy yet.');
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(String(text));
      return;
    } catch (_error) {
      var input = document.createElement('textarea');
      input.value = String(text);
      input.setAttribute('readonly', '');
      input.style.cssText = 'position:fixed;left:0;top:0;opacity:0;font-size:16px;';
      document.body.appendChild(input);
      input.select(); input.setSelectionRange(0, input.value.length);
      var copied = false;
      try { copied = document.execCommand('copy'); } catch (_copyError) { /* Show an actionable error below. */ }
      input.remove();
      if (!copied) throw new Error('Copy was blocked by your browser. Select the address or link and copy it manually.');
    }
  }
  function notice(title, message, icon) {
    if (global.Swal) return global.Swal.fire({ title: title, text: message, icon: icon || 'info' });
    global.alert(title + ': ' + message);
    return Promise.resolve();
  }
  global.XytrionUI = { copyText: copyText, notice: notice, syncLayout: schedule };
  function setup() {
    if (document.querySelector('[data-responsive-sidebar]') && !document.querySelector('[data-responsive-sidebar-backdrop]')) {
      var backdrop = document.createElement('div');
      backdrop.dataset.responsiveSidebarBackdrop = '';
      backdrop.hidden = true;
      backdrop.setAttribute('aria-hidden', 'true');
      document.body.appendChild(backdrop);
    }
    syncTheme(); syncLayout();
    document.addEventListener('click', function (event) {
      var toggle = event.target.closest('[data-sidebar-toggle]');
      if (toggle) { event.preventDefault(); var state = data(document.body); setSidebar(!(state && state.sidebarOpen)); return; }
      if (event.target.closest('[data-sidebar-close], [data-responsive-sidebar-backdrop]')) { event.preventDefault(); setSidebar(false); return; }
      var themeButton = event.target.closest('[data-theme-toggle]');
      if (themeButton) { event.preventDefault(); var theme = previousTheme ? 'light' : 'dark'; localStorage.setItem('theme', theme); syncTheme(theme); return; }
      if (event.target.closest('[data-responsive-sidebar] a[href]')) setSidebar(false);
      var copy = event.target.closest('[data-copy-referral]');
      if (copy) {
        event.preventDefault();
        var input = document.querySelector('[data-referral-link]');
        copyText(input && input.value).then(function () {
          var state = data(copy); if (state) state.showCopied = true;
          setTimeout(function () { if (state) state.showCopied = false; }, 2000);
        }).catch(function (error) { notice('Copy unavailable', error.message, 'error'); });
      }
      if (event.target.closest('[data-unsupported-login], [data-login-recovery]')) {
        event.preventDefault();
        notice('Sign-in help', 'This project uses email/username and password sign-in. Biometric, QR and automated password recovery are not configured. Contact support if you cannot access your account.', 'info');
      }
      schedule();
    });
    document.addEventListener('submit', function (event) {
      if (event.target.matches('[data-unsupported-trade]')) {
        event.preventDefault();
        notice('Manual trading unavailable', 'This project does not have a manual order-execution service. No order was placed and your balance has not changed. Use Live Markets to view quotes or AI Trading Bots for the existing simulated investment workflow.', 'info');
      }
    }, true);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { setSidebar(false); closeModalState(); schedule(); }
      if (event.key === 'Tab' && previousSidebar) {
        var sidebar = document.querySelector('[data-responsive-sidebar]');
        var focusable = [...sidebar.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(visible);
        var first = focusable[0]; var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    global.addEventListener('resize', function () {
      if (global.matchMedia('(min-width:1024px)').matches) {
        document.querySelectorAll('[data-responsive-public-toggle]').forEach(function (button) { var state = data(button); if (state && state.mobileMenuOpen) state.mobileMenuOpen = false; });
      }
      schedule();
    });
    global.addEventListener('storage', function (event) { if (event.key === 'theme') syncTheme(event.newValue); });
    if (global.visualViewport) { global.visualViewport.addEventListener('resize', schedule); global.visualViewport.addEventListener('scroll', schedule); }
    var observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('[data-responsive-modal], [data-responsive-sidebar], [data-responsive-public-menu]').forEach(function (element) { observer.observe(element, { attributes: true, attributeFilter: ['class', 'style'] }); });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    if (global.ResizeObserver) {
      var resizeObserver = new ResizeObserver(schedule);
      document.querySelectorAll('[data-responsive-navbar], header, [data-responsive-bottom-bar]').forEach(function (element) { resizeObserver.observe(element); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})(window);
