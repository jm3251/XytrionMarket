'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const errors = [];
const skip = new Set(['node_modules', '.git']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skip.has(entry.name) || entry.name.endsWith('.zip')) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(root);
const clientFiles = files.filter((file) => /\.(?:html|js|css)$/.test(file) && !file.includes(`${path.sep}src${path.sep}`) && !file.includes(`${path.sep}scripts${path.sep}`) && !file.includes(`${path.sep}test${path.sep}`));
const forbidden = [
  [/api\.telegram\.org\/bot\d+:/, 'embedded Telegram bot token'],
  [/TG_BOT_KEY|TG_CHAT_ID/, 'browser Telegram credential variable'],
  [/localStorage\.(?:getItem|setItem)\(['"]xytrion_users/, 'client-side user/password authority'],
  [/api\.binance\.com|fetch\(['"]https:\/\/api\.coingecko\.com/, 'direct browser market-provider call'],
  [/0xc9c94C74f2F0725a0a83367Bd95c7aC2A39305CB|TCtGLWZ83L1RNm2L26fVSm8m57E7XGf9U9/, 'obsolete deposit wallet']
];
for (const file of clientFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [regex, label] of forbidden) if (regex.test(text)) errors.push(`${path.relative(root, file)}: ${label}`);
}

const htmlFiles = files.filter((file) => file.endsWith('.html'));
if (/youtube\.com\/embed|youtu\.be\//i.test(fs.readFileSync(path.join(root, 'index.html'), 'utf8'))) errors.push('index.html: homepage YouTube video must be removed');
if (fs.readFileSync(path.join(root, 'user-session.js'), 'utf8') !== fs.readFileSync(path.join(root, 'dashboard/user-session.js'), 'utf8')) errors.push('root and dashboard session modules must have matching authentication behavior');
for (const file of htmlFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const relative = path.relative(root, file).replaceAll(path.sep, '/');
  if (!text.includes('/assets/js/app.js')) errors.push(`${path.relative(root, file)}: missing shared app client`);
  if ((text.match(/\/dashboard\/chat-widget\.css/g) || []).length !== 1) errors.push(`${path.relative(root, file)}: expected exactly one shared chat stylesheet`);
  if ((text.match(/\/dashboard\/chat-widget\.js/g) || []).length !== 1) errors.push(`${path.relative(root, file)}: expected exactly one shared chat script`);
  const protectedPage = relative === 'dashboard.html' || relative === 'kyc-form.html' || relative === 'verify-account.html' || /^dashboard\/.*\.html$/.test(relative);
  if (protectedPage) {
    const appIndex = text.search(/<script[^>]+src=["']\/assets\/js\/app\.js["']/i);
    const sessionIndex = text.search(/<script[^>]+src=["'][^"']*user-session\.js(?:\?[^"']*)?["']/i);
    const authIndex = text.search(/<script[^>]+src=["'][^"']*auth\.js["']/i);
    const notificationIndex = text.search(/<script[^>]+src=["']\/assets\/js\/notifications\.js["']/i);
    const chatIndex = text.search(/<script[^>]+src=["']\/dashboard\/chat-widget\.js["']/i);
    if (!(appIndex >= 0 && sessionIndex > appIndex && authIndex > sessionIndex && chatIndex > authIndex)) errors.push(`${relative}: shared app/session/auth/chat scripts are missing or out of order`);
    if ((text.match(/data-notifications-root/g) || []).length !== 1 || (text.match(/src=["']\/assets\/js\/notifications\.js["']/g) || []).length !== 1 || !(notificationIndex > authIndex && notificationIndex < chatIndex)) errors.push(`${relative}: missing or duplicate live notification bell/client`);
    if (/New login detected from IP:|Welcome to Algo Trading|href=["']#\/83\d["']/.test(text)) errors.push(`${relative}: fabricated account notifications must be removed`);
    if (/if \(!currentUser\)\s*\{\s*window\.location\.replace\(['"](?:\.\.\/)?login\.html['"]\)/.test(text)) errors.push(`${relative}: client-only login redirect races with the server session`);
    if ((relative === 'kyc-form.html' || relative === 'verify-account.html') && /href=["']accounthistory\.html["']/.test(text)) errors.push(`${relative}: Account Statement link points outside /dashboard/`);
  }
  if ((text.match(/<\/body>/gi) || []).length !== 1 || (text.match(/<\/html>/gi) || []).length !== 1) errors.push(`${path.relative(root, file)}: duplicate or missing closing tags`);
  if (!/<\/html>\s*$/i.test(text)) errors.push(`${path.relative(root, file)}: incomplete HTML document`);
}

try {
  const trade = fs.readFileSync(path.join(root, 'dashboard/trade.html'), 'utf8');
  const match = /instruments:\s*(\[\{[\s\S]*?\}\]),\s*selectedType:/.exec(trade);
  if (!match) throw new Error('Live Markets instrument list not found');
  const listed = JSON.parse(match[1]).filter((asset) => asset.type === 'crypto');
  const mapped = JSON.parse(fs.readFileSync(path.join(root, 'src/services/market-assets.json'), 'utf8'));
  const expectedSymbols = new Set(listed.map((asset) => asset.symbol.split('/')[0].toUpperCase()));
  if (!listed.length || listed.some((asset) => asset.price !== null || asset.percent_change_24h !== null)) errors.push('Live Markets contains an embedded cryptocurrency quote');
  if (mapped.length !== expectedSymbols.size || mapped.some((asset) => !expectedSymbols.has(asset.symbol))) errors.push('Live Markets symbols do not match the server market catalog');
} catch (error) { errors.push(`Live Markets price integrity: ${error.message}`); }

for (const required of ['server.js', 'src/app.js', 'src/models.js', 'src/routes.js', '.env.example', 'README.md']) {
  if (!fs.existsSync(path.join(root, required))) errors.push(`missing required file: ${required}`);
}
if (errors.length) {
  console.error(`Project check failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
console.log(`Project integrity check passed for ${files.length} files and ${htmlFiles.length} HTML pages.`);
