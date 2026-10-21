'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pages = [...fs.readdirSync(root).filter(file => file.endsWith('.html')), ...fs.readdirSync(path.join(root, 'dashboard')).filter(file => file.endsWith('.html')).map(file => 'dashboard/' + file)];
test('all site pages share one responsive stylesheet and touch controller', () => {
  for (const page of pages) {
    const html = read(page);
    assert.equal((html.match(/href="\/assets\/css\/responsive\.css(?:\?[^"\s]*)?"/g) || []).length, 1, page);
    assert.equal((html.match(/src="\/assets\/js\/responsive\.js"/g) || []).length, 1, page);
    assert.doesNotMatch(html, /charset=UTF-8"\s*<head>/, page);
  }
});
test('every protected page has accessible closeable navigation and consistent sidebar reservation', () => {
  for (const page of pages.filter(file => file.startsWith('dashboard/') || ['dashboard.html', 'kyc-form.html', 'verify-account.html'].includes(file))) {
    const html = read(page);
    for (const attribute of ['data-sidebar-toggle', 'data-sidebar-close', 'data-responsive-sidebar', 'data-responsive-main', 'data-responsive-navbar']) assert.match(html, new RegExp(attribute), page);
    assert.doesNotMatch(html, /md:ml-64/, page);
    assert.doesNotMatch(html, /<div class="font-semibold text-gray-900 dark:text-white">\s*\$5\.00\s*<\/div>/, page);
  }
});
test('mobile market cards retain live price, change and volume instead of hiding them', () => {
  const html = read('dashboard/trade.html');
  for (const hook of ['data-market-price', 'data-market-change', 'data-market-volume', 'data-responsive-market-row']) assert.match(html, new RegExp(hook));
  assert.doesNotMatch(html, /:href="trade\.html"/);
  const css = read('assets/css/responsive.css');
  assert.match(css, /\[data-market-price\][\s\S]+display: block !important/);
});
test('payment upload is validated and duplicate taps cannot initiate multiple requests', () => {
  const html = read('dashboard/payment.html');
  assert.match(html, /if \(this\.isSubmitting\) return/);
  assert.match(html, /!fileName \|\| isSubmitting/);
  assert.match(html, /XytrionUI\.copyText/);
  assert.match(html, /data-responsive-progress/);
  assert.equal((html.match(/<script[^>]+src="telegram\.js"/g) || []).length, 1);
});
test('chat and modals use viewport and safe-area sizing with adequate touch targets', () => {
  const css = read('assets/css/responsive.css') + read('dashboard/chat-widget.css');
  for (const phrase of ['--xyt-viewport-height', '--xyt-keyboard-offset', 'safe-area-inset-bottom', 'min-height: 44px', '.swal2-popup', 'xyt-modal-open']) assert(css.includes(phrase), phrase);
  const profile = read('dashboard/account-settings.html');
  assert.doesNotMatch(profile, /x-on:click="saving = true"/);
  assert.match(profile, /checkPasswordStrength\(password\)/);
});

test('every sidebar page uses the same explicit mobile balance binding without a fixed $5 fallback', () => {
  for (const page of pages.filter(file => file.startsWith('dashboard/') || ['dashboard.html', 'kyc-form.html', 'verify-account.html'].includes(file))) {
    const html = read(page);
    const start = html.indexOf('data-responsive-mobile-ticker');
    assert(start >= 0, page);
    const ticker = html.slice(start, html.indexOf('</nav>', start));
    assert.match(ticker, /data-user-balance/, page);
    assert.doesNotMatch(ticker, /\$5\.00/, page);
  }
  const shared = read('user-session.js');
  assert.match(shared, /function renderBalances\(user\)/);
  assert.match(shared, /scheduleBalancePaint/);
  assert.match(shared, /global\.MutationObserver/);
  assert.equal(shared, read('dashboard/user-session.js'));
});

test('shared balance renderer displays funded, updated and zero balances identically', () => {
  const vm = require('node:vm');
  const fields = [null, null, 'Account Balance: '].map(prefix => ({
    textContent: '$5.00', attributes: {},
    getAttribute: name => name === 'data-balance-prefix' ? prefix : null,
    setAttribute(name, value) { this.attributes[name] = value; }
  }));
  const cache = new Map();
  const context = {
    window: { addEventListener: () => {}, location: { pathname: '/dashboard.html' }, XytrionFormat: { money: value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value) } },
    localStorage: { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
    document: { addEventListener: () => {}, querySelector: () => null, getElementById: () => null, querySelectorAll: selector => selector.includes('user-balance-text') ? fields : [] }
  };
  vm.runInNewContext(read('user-session.js'), context);
  for (const balance of [12345.67, 9876.50, 0]) {
    cache.set('xytrion_current_user', JSON.stringify({ balance }));
    context.window.refreshBalanceUI();
    const amount = context.window.XytrionFormat.money(balance);
    assert.deepEqual(fields.map(field => field.textContent), [amount, amount, 'Account Balance: ' + amount]);
    assert(fields.every(field => field.attributes['aria-busy'] === 'false'));
  }
  cache.clear();context.window.refreshBalanceUI();
  assert.deepEqual(fields.map(field => field.textContent), ['—', '—', 'Account Balance: —']);
});

test('withdrawal view uses scoped phone/tablet styling and no desktop-height modal shell', () => {
  const html = read('dashboard/withdraw-funds.html');
  assert.match(html, /withdrawal\.css\?v=/);
  assert.match(html, /class="withdrawal-form /);
  assert.match(html, /class="withdrawal-modal-shell"/);
  const css = read('assets/css/withdrawal.css');
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /@media \(min-width: 768px\) and \(max-width: 1023px\)/);
  assert.match(css, /\.withdrawal-submit-button[\s\S]*width: 100% !important/);
});

test('sidebar pages cannot overwrite shared balances using independent cached or $5 formatters', () => {
  for (const page of pages.filter(file => file.startsWith('dashboard/') || ['dashboard.html', 'kyc-form.html', 'verify-account.html'].includes(file))) {
    const html = read(page);
    assert.doesNotMatch(html, /document\.querySelectorAll\(['"](?:\.user-balance-text|\[data-user-balance\])['"]\)\.forEach\(el\s*=>\s*(?:\{\s*)?el\.textContent\s*=\s*['"]\$['"]\s*\+\s*balance/, page);
  }
});
