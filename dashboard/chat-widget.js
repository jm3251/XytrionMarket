(function () {
  'use strict';
  if (window.xytChat || window.__xytChatBooting) return;
  window.__xytChatBooting = true;

  var CONFIG = {
    pollInterval: 4000,
    sessionIdKey: 'xyt_chat_sid',
    welcomeText: 'Welcome to Xytrion Markets! How can we help you today?'
  };

  function escapeHtml(value) {
    var div = document.createElement('div');
    div.textContent = String(value || '');
    return div.innerHTML;
  }

  function sid() {
    var value = localStorage.getItem(CONFIG.sessionIdKey);
    if (!value) {
      value = 'XYT-' + (window.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase() : String(Date.now()));
      localStorage.setItem(CONFIG.sessionIdKey, value);
    }
    return value;
  }

  function inject() {
    if (document.getElementById('chat-widget')) return;
    var widget = document.createElement('section');
    widget.id = 'chat-widget';
    widget.className = 'chat-widget';
    widget.setAttribute('aria-label', 'Live chat');
    widget.innerHTML = '<div class="chat-header"><h3 class="chat-header-title">Live Chat</h3><div class="chat-header-actions"><button id="chat-end" class="chat-end" type="button">End Chat</button><button id="chat-close" class="chat-close" type="button" aria-label="Close chat">✕</button></div></div><div class="chat-messages" id="chat-messages" aria-live="polite"></div><div class="chat-input-area"><input type="text" id="chat-input" class="chat-input" placeholder="Type your message..." maxlength="2000" autocomplete="off"><button id="chat-send" class="chat-send" type="button" aria-label="Send message">➤</button></div>';
    var toggle = document.createElement('button');
    toggle.id = 'chat-toggle';
    toggle.className = 'chat-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Open live chat');
    toggle.innerHTML = '<span class="chat-icon">💬</span><span class="chat-label">Live</span><span class="chat-label">Chat</span>';
    document.body.appendChild(widget);
    document.body.appendChild(toggle);
  }

  function bindShell(controller) {
    controller.widget = document.getElementById('chat-widget');
    controller.container = document.getElementById('chat-messages');
    controller.input = document.getElementById('chat-input');
    document.getElementById('chat-toggle').onclick = function () { controller.toggle(!controller.open); };
    document.getElementById('chat-close').onclick = function () { controller.toggle(false); };
  }

  function NoticeChat(message, canSignIn) {
    this.open = false;
    bindShell(this);
    var end = document.getElementById('chat-end');
    var send = document.getElementById('chat-send');
    end.hidden = true;
    send.disabled = true;
    this.input.disabled = true;
    this.input.placeholder = canSignIn ? 'Sign in to start a conversation' : 'Support connection unavailable';
    this.container.innerHTML = '<div class="chat-message chat-message-operator"><div class="message-content"><p>' + escapeHtml(message) + '</p></div></div>' + (canSignIn ? '<a class="chat-login-link" href="/login.html">Sign in to live chat</a>' : '');
  }
  NoticeChat.prototype.toggle = function (force) {
    this.open = Boolean(force);
    this.widget.classList.toggle('open', this.open);
    document.getElementById('chat-toggle').setAttribute('aria-expanded', String(this.open));
  };

  function Chat() {
    this.sid = sid();
    this.key = 'xyt_chat_h_' + this.sid;
    this.messages = this.load();
    this.open = false;
    this.busy = false;
    this.timer = null;
    this.bind();
    this.addWelcome();
    this.poll();
  }
  Chat.prototype.load = function () {
    try { var value = JSON.parse(localStorage.getItem(this.key) || '[]'); return Array.isArray(value) ? value : []; }
    catch (_error) { return []; }
  };
  Chat.prototype.save = function () { localStorage.setItem(this.key, JSON.stringify(this.messages.slice(-200))); };
  Chat.prototype.bind = function () {
    var self = this;
    bindShell(this);
    document.getElementById('chat-end').hidden = false;
    document.getElementById('chat-end').onclick = function () { self.end(); };
    document.getElementById('chat-send').disabled = false;
    document.getElementById('chat-send').onclick = function () { self.send(); };
    this.input.disabled = false;
    this.input.placeholder = 'Type your message...';
    this.input.onkeydown = function (event) { if (event.key === 'Enter') self.send(); };
    this.render();
  };
  Chat.prototype.addWelcome = function () {
    if (this.messages.length) return;
    this.messages.push({ id: 'welcome', sender: 'bot', text: CONFIG.welcomeText, time: new Date().toISOString() });
    this.save();
    this.render();
  };
  Chat.prototype.toggle = function (force) {
    this.open = Boolean(force);
    this.widget.classList.toggle('open', this.open);
    document.getElementById('chat-toggle').setAttribute('aria-expanded', String(this.open));
    if (this.open) this.input.focus();
  };
  Chat.prototype.send = async function () {
    var text = this.input.value.trim();
    if (!text || this.busy) return;
    this.busy = true;
    var item = { id: 'local-' + Date.now(), sender: 'user', text: text, time: new Date().toISOString(), status: 'sending' };
    this.messages.push(item);
    this.input.value = '';
    this.render();
    try {
      var data = await window.XytrionApi.request('/api/chat/send', { method: 'POST', body: { sessionId: this.sid, message: text } });
      item.id = data.id;
      item.status = data.delivered ? 'delivered' : 'queued';
    } catch (_error) { item.status = 'failed'; }
    this.busy = false;
    this.save();
    this.render();
  };
  Chat.prototype.poll = function () {
    var self = this;
    clearTimeout(this.timer);
    window.XytrionApi.request('/api/messages?sessionId=' + encodeURIComponent(this.sid)).then(function (items) {
      (items || []).forEach(function (item) {
        if (!self.messages.some(function (old) { return old.id === item.id; })) self.messages.push({ id: item.id, sender: 'bot', text: item.text, time: item.time });
      });
      self.save();
      self.render();
    }).catch(function () {}).finally(function () {
      self.timer = setTimeout(function () { self.poll(); }, CONFIG.pollInterval);
    });
  };
  Chat.prototype.end = async function () {
    await window.XytrionApi.request('/api/chat/end', { method: 'POST', body: { sessionId: this.sid } }).catch(function () {});
    localStorage.removeItem(this.key);
    localStorage.removeItem(CONFIG.sessionIdKey);
    this.messages = [];
    this.sid = sid();
    this.key = 'xyt_chat_h_' + this.sid;
    this.addWelcome();
    this.toggle(false);
  };
  Chat.prototype.render = function () {
    if (!this.container) return;
    this.container.innerHTML = this.messages.map(function (message) {
      var cls = message.sender === 'user' ? 'visitor' : (message.sender === 'system' ? 'system' : 'operator');
      var status = message.sender === 'user' ? '<span class="message-status status-' + escapeHtml(message.status || 'delivered') + '">' + (message.status === 'failed' ? '❌' : (message.status === 'sending' ? '🕒' : '✅')) + '</span>' : '';
      return '<div class="chat-message chat-message-' + cls + '"><div class="message-content"><p>' + escapeHtml(message.text) + '</p><div class="message-meta"><span class="message-time">' + new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>' + status + '</div></div></div>';
    }).join('');
    this.container.scrollTop = this.container.scrollHeight;
  };

  function waitForApi() {
    return new Promise(function (resolve, reject) {
      var started = Date.now();
      (function check() {
        if (window.XytrionApi && typeof window.XytrionApi.request === 'function') return resolve(window.XytrionApi);
        if (Date.now() - started >= 5000) return reject(new Error('Shared API client did not load.'));
        setTimeout(check, 50);
      })();
    });
  }

  async function boot() {
    inject();
    window.xytChat = new NoticeChat('Connecting to live support…', false);
    try {
      var api = await waitForApi();
      await api.request('/api/auth/me');
      window.xytChat = new Chat();
    } catch (error) {
      var signedOut = error && (error.status === 401 || error.status === 403);
      window.xytChat = new NoticeChat(
        signedOut ? 'Live chat is available after you sign in.' : 'Live chat is visible, but the application API is currently unavailable. Start the Node server and check /api/health.',
        signedOut
      );
    } finally {
      window.__xytChatBooting = false;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
