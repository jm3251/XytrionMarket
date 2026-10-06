(function (global) {
  'use strict';
  var DAY_MS = 86400000; var plans = []; var investments = [];
  function notify() { refreshInvestmentStats(); global.dispatchEvent(new CustomEvent('investments:updated')); }
  function round2(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
  function formatMoney(value) { return global.XytrionFormat.money(value || 0); }
  function getPlans() { return plans.slice(); }
  function getPlan(id) { return plans.find(function (plan) { return plan.id === id; }) || null; }
  function getInvestments() { return investments.slice().sort(function (a, b) { return b.startTime - a.startTime; }); }
  function getActiveInvestments() { return getInvestments().filter(function (item) { return item.status === 'active'; }); }
  function getCompletedInvestments() { return getInvestments().filter(function (item) { return item.status === 'completed'; }); }
  function getActiveInvestedTotal() { return round2(getActiveInvestments().reduce(function (sum, item) { return sum + item.amount; }, 0)); }
  function getTotalProfitEarned() { return round2(investments.reduce(function (sum, item) { return sum + (item.totalProfit || 0); }, 0)); }
  function getTodayProfit() { return round2(investments.reduce(function (sum, item) { var values = item.dailyProfits || []; var last = values[values.length - 1]; return last && Date.now() - new Date(last.date).getTime() < DAY_MS ? sum + last.profit : sum; }, 0)); }
  async function refresh() {
    var data = await global.XytrionApi.request('/api/investments');
    plans = data.plans || []; investments = data.investments || [];
    try { if (global.refreshCurrentUser) await global.refreshCurrentUser({ redirect: false }); }
    finally { notify(); }
    return investments;
  }
  async function createInvestment(planId, amount) {
    var plan = getPlan(planId);
    if (!plan) return { ok: false, error: 'Invalid investment plan selected.' };
    var value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, error: 'Please enter a valid investment amount.' };
    value = round2(value);
    if (plan.durationDays < 3) return { ok: false, error: 'Investment duration must be at least 3 days.' };
    if (value < plan.minAmount) return { ok: false, error: 'Minimum investment for this bot is ' + formatMoney(plan.minAmount) + '.' };
    if (value > plan.maxAmount) return { ok: false, error: 'Maximum investment for this bot is ' + formatMoney(plan.maxAmount) + '.' };
    if (getActiveInvestments().some(function (item) { return item.botId === planId; })) return { ok: false, error: 'You already have an active investment in this bot. Please wait until it completes.' };
    if (typeof global.getBalance === 'function' && value > global.getBalance()) return { ok: false, error: 'Insufficient balance. Your available balance is ' + formatMoney(global.getBalance()) + '.' };
    try { var data = await global.XytrionApi.request('/api/investments', { method: 'POST', body: { planId: planId, amount: value } }); await refresh(); return { ok: true, investment: data.investment }; }
    catch (error) { return { ok: false, error: error.message }; }
  }
  function processInvestments() { return refresh(); }
  function getProgress(item) { return Math.max(0, Math.min(1, (Date.now() - Number(item.startTime)) / (item.durationDays * DAY_MS))); }
  function getTimeRemaining(item) { return Math.max(0, Number(item.startTime) + item.durationDays * DAY_MS - Date.now()); }
  function formatTimeRemaining(item) { var ms = getTimeRemaining(item); if (ms <= 0) return 'Matured'; var d = Math.floor(ms / DAY_MS); var h = Math.floor((ms % DAY_MS) / 3600000); var m = Math.floor((ms % 3600000) / 60000); return d ? d + 'd ' + h + 'h' : (h ? h + 'h ' + m + 'm' : m + 'm'); }
  function refreshInvestmentStats() {
    var map = { '[data-invest-active-balance]': formatMoney(getActiveInvestedTotal()), '[data-invest-total-profit]': formatMoney(getTotalProfitEarned()), '[data-invest-daily-profit]': formatMoney(getTodayProfit()) };
    Object.keys(map).forEach(function (selector) { document.querySelectorAll(selector).forEach(function (el) { el.textContent = map[selector]; }); });
    document.querySelectorAll('[data-invest-active-count]').forEach(function (el) { el.textContent = String(getActiveInvestments().length); });
    document.querySelectorAll('[data-invest-active-note]').forEach(function (el) { var count = getActiveInvestments().length; el.textContent = count ? count + ' investment' + (count > 1 ? 's' : '') + ' running' : 'No active investments'; });
  }
  global.XytrionInvestments = { MIN_DURATION_DAYS: 3, DAY_MS: DAY_MS, getPlans: getPlans, getPlan: getPlan, getInvestments: getInvestments, getActiveInvestments: getActiveInvestments, getCompletedInvestments: getCompletedInvestments, getActiveInvestedTotal: getActiveInvestedTotal, getTotalProfitEarned: getTotalProfitEarned, getTodayProfit: getTodayProfit, createInvestment: createInvestment, processInvestments: processInvestments, getProgress: getProgress, getTimeRemaining: getTimeRemaining, formatTimeRemaining: formatTimeRemaining, formatMoney: formatMoney, refreshInvestmentStats: refreshInvestmentStats };
  function reportError(error) { global.dispatchEvent(new CustomEvent('investments:error', { detail: error.message || 'Connection failed.' })); }
  document.addEventListener('DOMContentLoaded', function () { refresh().catch(reportError); setInterval(function () { refresh().catch(reportError); }, 30000); });
})(window);
