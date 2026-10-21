(function (global) {
  'use strict';

  function setup() {
    if (!document.querySelector('[data-notifications-root]') || !global.XytrionApi) return;
    var stream = null;
    var fallbackTimer = null;
    var request = null;
    var items = [];

    function elements() {
      var root = document.querySelector('[data-notifications-root]');
      if (!root) return null;
      return {
        root: root,
        toggle: root.querySelector('[data-notifications-toggle]'),
        panel: root.querySelector('[data-notification-panel]'),
        badge: root.querySelector('[data-notification-count]'),
        unreadLabel: root.querySelector('[data-notifications-unread]'),
        list: root.querySelector('[data-notification-list]'),
        readAll: root.querySelector('[data-notifications-read-all]')
      };
    }
    function status(text) {
      var current = elements();
      if (!current || !current.list) return;
      current.list.replaceChildren();
      var empty = document.createElement('p');
      empty.className = 'px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400';
      empty.textContent = text;
      current.list.appendChild(empty);
    }
    function dateLabel(value) {
      var date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    }
    function itemButton(item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.dataset.notificationId = item.id;
      button.className = 'block w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors' + (item.readAt ? '' : ' bg-blue-50 dark:bg-blue-900/10');
      button.setAttribute('aria-label', item.title + (item.readAt ? '' : ', unread'));
      var title = document.createElement('span');
      title.className = 'block text-sm font-semibold text-gray-900 dark:text-white';
      title.textContent = item.title;
      var message = document.createElement('span');
      message.className = 'block mt-1 text-xs text-gray-600 dark:text-gray-300';
      message.textContent = item.message;
      var time = document.createElement('time');
      time.className = 'block mt-1 text-xs text-gray-500 dark:text-gray-400';
      time.dateTime = item.createdAt;
      time.textContent = dateLabel(item.createdAt);
      button.append(title, message, time);
      return button;
    }
    function render(data) {
      var current = elements();
      if (!current) return;
      items = Array.isArray(data.items) ? data.items : [];
      var unreadCount = Number(data.unreadCount) || 0;
      current.badge.hidden = unreadCount === 0;
      current.badge.style.display = unreadCount ? 'inline-flex' : 'none';
      current.badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      current.unreadLabel.textContent = unreadCount ? unreadCount + ' unread' : 'All caught up';
      current.readAll.disabled = !unreadCount;
      current.list.replaceChildren();
      if (!items.length) status('No notifications yet. Account activity will appear here.');
      else items.forEach(function (item) { current.list.appendChild(itemButton(item)); });
    }
    function refresh() {
      if (request) return request;
      request = global.XytrionApi.request('/api/notifications').then(render).catch(function (error) {
        if (error && error.status === 401) {
          if (stream) { stream.close(); stream = null; }
          status('Sign in to view notifications.');
        } else if (!items.length) status('Notifications are temporarily unavailable. Please try again.');
      }).finally(function () { request = null; });
      return request;
    }
    function startFallback() {
      if (fallbackTimer) return;
      fallbackTimer = global.setInterval(function () { if (!document.hidden) refresh(); }, 15000);
    }
    function stopFallback() { if (fallbackTimer) global.clearInterval(fallbackTimer); fallbackTimer = null; }
    function connect() {
      if (!global.EventSource) { startFallback(); return; }
      stream = new global.EventSource('/api/notifications/stream');
      stream.addEventListener('notifications', function (event) {
        try { render(JSON.parse(event.data)); } catch (_error) { refresh(); }
      });
      stream.addEventListener('refresh-error', startFallback);
      stream.onopen = stopFallback;
      stream.onerror = startFallback;
    }

    // Some dashboard libraries replace navbar nodes during hydration. Keep the
    // handlers on document and always resolve the currently visible bell.
    document.addEventListener('click', async function (event) {
      var current = elements();
      if (!current) return;
      var button = event.target.closest('button');
      if (button && current.root.contains(button)) {
        if (button.matches('[data-notifications-toggle]')) {
          current.panel.hidden = !current.panel.hidden;
          current.toggle.setAttribute('aria-expanded', String(!current.panel.hidden));
          if (!current.panel.hidden) refresh();
          return;
        }
        if (button.matches('[data-notifications-read-all]')) {
          current.readAll.disabled = true;
          try { await global.XytrionApi.request('/api/notifications/read-all', { method: 'POST' }); await refresh(); }
          catch (_error) { current.readAll.disabled = false; }
          return;
        }
        if (button.matches('[data-notification-id]')) {
          var item = items.find(function (entry) { return entry.id === button.dataset.notificationId; });
          if (!item) return;
          button.disabled = true;
          try {
            if (!item.readAt) await global.XytrionApi.request('/api/notifications/' + encodeURIComponent(item.id) + '/read', { method: 'PATCH' });
            await refresh();
          } catch (_error) { /* The destination remains available if the API is temporarily unreachable. */ }
          if (/^\/(?:dashboard(?:\.html|\/[-a-z]+\.html)|kyc-form\.html|verify-account\.html)$/.test(item.actionUrl || '')) {
            global.location.assign(item.actionUrl);
          } else button.disabled = false;
          return;
        }
      }
      if (!current.root.contains(event.target)) { current.panel.hidden = true; current.toggle.setAttribute('aria-expanded', 'false'); }
    });
    document.addEventListener('keydown', function (event) {
      var current = elements();
      if (current && event.key === 'Escape') { current.panel.hidden = true; current.toggle.setAttribute('aria-expanded', 'false'); }
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    global.addEventListener('pagehide', function () { if (stream) { stream.close(); stream = null; } stopFallback(); });
    global.addEventListener('pageshow', function (event) { if (event.persisted) { refresh(); connect(); } });
    status('Loading notifications…');
    refresh();
    connect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})(window);
