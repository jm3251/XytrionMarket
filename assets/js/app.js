(function (global) {
  'use strict';
  if (global.XytrionApp) return;

  function invalidResponseMessage(response, text) {
    var status = response && response.status ? 'HTTP ' + response.status : 'unknown status';
    var isHtml = /^\s*</.test(text || '') || /text\/html/i.test((response && response.headers && response.headers.get('content-type')) || '');
    if (isHtml) {
      return 'The API returned a web page instead of JSON (' + status + '). Start this project with "npm start" and open the URL printed by the Node server; do not use a static file server or open the HTML file directly.';
    }
    if (response && [502, 503, 504].includes(response.status)) {
      return 'The application backend is unavailable (' + status + '). Check the Node server logs and MongoDB connection, then retry.';
    }
    return 'The server returned an invalid API response (' + status + '). Check the Node server logs and the /api/health endpoint.';
  }

  async function request(path, options) {
    var config = options || {};
    var headers = Object.assign({ Accept: 'application/json' }, config.headers || {});
    if (config.body && !(config.body instanceof FormData) && typeof config.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      config.body = JSON.stringify(config.body);
    }
    var response;
    try {
      response = await fetch(path, Object.assign({ credentials: 'same-origin' }, config, { headers: headers }));
    } catch (_error) {
      throw new Error('Cannot reach the application backend. Start the project with "npm start" and use the same server URL for the website and API.');
    }
    var text = await response.text();
    var data;
    try { data = text ? JSON.parse(text) : {}; }
    catch (_error) { throw Object.assign(new Error(invalidResponseMessage(response, text)), { status: response.status }); }
    if (!response.ok) {
      var fallback = response.status === 405 && String(path).indexOf('/api/') === 0
        ? 'The hosting server rejected this API request (HTTP 405). The site is being served as static files or by the wrong application. Configure the host to run "npm start", route /api requests to this Node app, and verify /api/health returns JSON.'
        : 'Request failed (HTTP ' + response.status + ').';
      var error = new Error(data.error || fallback);
      error.status = response.status; error.details = data.errors || [];
      throw error;
    }
    return data;
  }

  function number(value) {
    var parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function money(value, currency) {
    var parsed = number(value);
    if (parsed === null) return 'Unavailable';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(parsed);
  }

  function decimal(value) {
    var parsed = number(value);
    if (parsed === null) return 'Unavailable';
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(parsed);
  }

  var marketSnapshot = null;
  var marketSnapshotUntil = 0;
  var marketRequest = null;
  function marketPrices() {
    if (marketSnapshot && Date.now() < marketSnapshotUntil) return Promise.resolve(marketSnapshot);
    if (!marketRequest) {
      marketRequest = request('/api/market/prices').then(function (data) {
        marketSnapshot = data;
        marketSnapshotUntil = Date.now() + 5000;
        return data;
      }).finally(function () { marketRequest = null; });
    }
    return marketRequest;
  }

  function cryptoPrices() {
    return {
      btcPrice: null, ethPrice: null, btcChange: 0, ethChange: 0,
      marketStatus: 'loading', lastUpdate: null, marketSource: null, marketError: null, _timer: null,
      formatMarket: function (value) { return value == null ? 'Unavailable' : money(value); },
      statusLabel: function () { return this.marketStatus === 'live' ? 'LIVE' : (this.marketStatus === 'stale' ? 'STALE' : (this.marketStatus === 'loading' ? 'LOADING' : 'UNAVAILABLE')); },
      async fetchPrices() {
        try {
          var data = await marketPrices();
          if (!data.available || !data.quotes || !data.quotes.BTC || !data.quotes.ETH ||
              !Number.isFinite(Number(data.quotes.BTC.price)) || Number(data.quotes.BTC.price) <= 0 ||
              !Number.isFinite(Number(data.quotes.ETH.price)) || Number(data.quotes.ETH.price) <= 0) {
            throw new Error(data.error || 'Market prices unavailable.');
          }
          this.btcPrice = data.quotes.BTC.price; this.ethPrice = data.quotes.ETH.price;
          this.btcChange = data.quotes.BTC.change24h || 0; this.ethChange = data.quotes.ETH.change24h || 0;
          this.marketStatus = data.stale ? 'stale' : 'live'; this.lastUpdate = data.fetchedAt;
          this.marketSource = data.source; this.marketError = null;
        } catch (error) {
          this.marketError = error.message;
          if (this.btcPrice != null && this.ethPrice != null && this.lastUpdate && Date.now() - Date.parse(this.lastUpdate) <= 300000) {
            this.marketStatus = 'stale';
          } else {
            this.btcPrice = null; this.ethPrice = null; this.btcChange = 0; this.ethChange = 0; this.marketStatus = 'unavailable';
          }
        } finally {
          clearTimeout(this._timer); this._timer = setTimeout(this.fetchPrices.bind(this), 30000);
        }
      }
    };
  }

  global.XytrionApp = { request: request, marketPrices: marketPrices, formatMoney: money, formatDecimal: decimal, cryptoPrices: cryptoPrices };
  global.XytrionApi = { request: request };
  global.XytrionFormat = { money: money, decimal: decimal };
  global.cryptoPrices = cryptoPrices;
})(window);
