'use strict';

const { config, assertProductionConfig } = require('../src/config');
const { connectDatabase, disconnectDatabase } = require('../src/db');
const { getMarketPrices } = require('../src/services/market');
const { smtpConfigured, verifySmtp } = require('../src/services/email');
const { EmailDelivery } = require('../src/models');

async function main() {
  console.log(`Node.js: ${process.version}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Application origin: ${config.appOrigin}`);
  assertProductionConfig();
  console.log('Required environment variables: present');
  await connectDatabase();
  console.log('MongoDB: connected');
  console.log(`Telegram: ${config.telegram.token && config.telegram.adminChatId ? 'configured' : 'not fully configured (registration still works without Telegram)'}`);
  console.log(`Telegram polling: ${config.telegram.pollingEnabled ? 'enabled' : 'disabled'}`);
  if (smtpConfigured()) {
    await verifySmtp();
    console.log('Customer email: SMTP connection and authentication verified');
  } else {
    console.warn('Customer email: not configured. Registration, deposit and withdrawal emails will stay queued until SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM are set. Telegram settings do not send customer email.');
  }
  const [pending, failed] = await Promise.all([
    EmailDelivery.countDocuments({ status: { $in: ['pending', 'sending'] } }),
    EmailDelivery.countDocuments({ status: 'failed' })
  ]);
  console.log(`Customer email outbox: ${pending} pending, ${failed} exhausted retries`);
  const market = await getMarketPrices({ force: true });
  if (market.available) {
    console.log(`Market: ${market.stale ? 'last verified' : 'live'} (${market.source}; BTC and ETH available)`);
    if (!String(market.source).includes('Kraken')) console.warn('Market warning: Kraken did not respond. Check MARKET_API_BASE and outbound access to api.kraken.com; CoinGecko currently supplies quotes.');
  } else {
    console.warn('Market warning: BTC/ETH unavailable. Check outbound access to api.kraken.com and api.coingecko.com and any MARKET_API_BASE override.');
  }
  console.log('Configuration check passed. Start the app with: npm start');
}

main()
  .catch((error) => {
    console.error(`Configuration check failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => { await disconnectDatabase().catch(() => {}); });
