'use strict';

const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'temp/**', 'uploads/**', '*.html', 'telegram-optimized.js', 'telegram-worker.js', 'dashboard/telegram-optimized.js', 'dashboard/telegram-worker.js'] },
  {
    files: ['server.js', 'src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }], 'no-redeclare': 'error' }
  },
  {
    files: ['assets/js/**/*.js', 'user-session.js', 'telegram.js', 'dashboard/*.js'],
    ignores: ['dashboard/telegram-optimized.js', 'dashboard/telegram-worker.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser, Alpine: 'readonly', Swal: 'readonly', lucide: 'readonly', getBalance: 'readonly' } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }], 'no-redeclare': 'off' }
  }
];
