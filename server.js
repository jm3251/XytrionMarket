'use strict';

const { config, assertProductionConfig } = require('./src/config');
const { connectDatabase, disconnectDatabase } = require('./src/db');
const { createTelegramService } = require('./src/services/telegram');
const { createEmailWorker } = require('./src/services/email');
const { createApp } = require('./src/app');

async function start() {
  assertProductionConfig();
  await connectDatabase();
  const telegramService = createTelegramService();
  const emailWorker = createEmailWorker();
  const app = createApp({ telegramService });
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`Xytrion Markets listening on port ${config.port}`);
    console.log(`Application URL: ${config.appOrigin}`);
    console.log(`Health check: ${config.appOrigin}/api/health`);
    if (telegramService.startPolling()) console.log('Telegram admin polling started.');
    if (emailWorker.start()) console.log('Customer email delivery worker started.');
    else console.warn('Customer email is not configured. Receipts are queued until SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM are set.');
  });

  const shutdown = async () => {
    telegramService.stopPolling();
    emailWorker.stop();
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Startup failed:', error.message);
    process.exit(1);
  });
}

module.exports = { start };
