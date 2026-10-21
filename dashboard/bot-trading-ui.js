/**
 * bot-trading-ui.js - Investment dashboard UI controller for bot-trading.html
 *
 * Renders portfolio statistics, plan cards, active investments with progress
 * indicators, and the investment history table. Handles the invest modal
 * workflow with validation, loading states, and notifications.
 *
 * Depends on: investments.js (XytrionInvestments), telegram.js (balance
 * helpers), SweetAlert2, Lucide icons.
 */

(function () {
    'use strict';

    var INV = window.XytrionInvestments;

    function money(n) { return INV.formatMoney(n); }

    function refreshIcons() {
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    // ─── Portfolio Stats ─────────────────────────────────────────────────────

    function renderStats() {
        // Stats are bound via data attributes handled by investments.js;
        // trigger a refresh so freshly injected markup gets populated.
        INV.refreshInvestmentStats();
    }

    // ─── Plan Cards ──────────────────────────────────────────────────────────

    var ACCENTS = {
        blue:    { text: 'text-blue-600 dark:text-blue-400',       chip: 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',       btn: 'from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700' },
        emerald: { text: 'text-emerald-600 dark:text-emerald-400', chip: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400', btn: 'from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700' },
        purple:  { text: 'text-purple-600 dark:text-purple-400',   chip: 'bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400',   btn: 'from-purple-600 to-violet-600 hover:from-purple-700 hover:to-violet-700' },
        amber:   { text: 'text-amber-600 dark:text-amber-400',     chip: 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',     btn: 'from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700' },
        cyan:    { text: 'text-cyan-600 dark:text-cyan-400',       chip: 'bg-cyan-50 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-400',       btn: 'from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700' }
    };

    function planCardHTML(plan) {
        var a = ACCENTS[plan.accent] || ACCENTS.blue;
        var hasActive = INV.getActiveInvestments().some(function (i) { return i.botId === plan.id; });
        var pairs = plan.pairs.map(function (p) {
            return '<span class="px-2.5 py-1 text-xs font-medium ' + a.chip + ' rounded-lg">' + p + '</span>';
        }).join('');
        var badge = plan.durationDays === 3
            ? '<span class="ml-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white bg-gradient-to-r from-green-500 to-emerald-600 rounded-full">Featured</span>'
            : '';
        var cta = hasActive
            ? '<button disabled class="mt-auto w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded-xl font-semibold text-sm cursor-not-allowed">' +
              '<i data-lucide="check-circle-2" class="w-4 h-4"></i>Investment Active</button>'
            : '<button data-invest-plan="' + plan.id + '" class="mt-auto w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-gradient-to-r ' + a.btn + ' text-white rounded-xl font-semibold text-sm transition-all duration-200 shadow-md hover:shadow-lg">' +
              '<i data-lucide="play-circle" class="w-4 h-4"></i>Invest Now<i data-lucide="arrow-right" class="w-4 h-4 ml-auto"></i></button>';

        return '' +
        '<div class="bot-card group flex flex-col bg-white dark:bg-gray-800 rounded-2xl shadow-md border border-gray-100 dark:border-gray-700 overflow-hidden hover:shadow-xl hover:-translate-y-1 transition-all duration-300" data-category="' + plan.category + '">' +
            '<div class="h-1.5 bg-gradient-to-r ' + plan.gradient.replace('-600', '-500') + '"></div>' +
            '<div class="p-6 flex flex-col flex-1">' +
                '<div class="flex items-start justify-between mb-4">' +
                    '<div class="flex items-center gap-3">' +
                        '<div class="w-12 h-12 bg-gradient-to-br ' + plan.gradient + ' rounded-xl flex items-center justify-center shadow-md flex-shrink-0">' +
                            '<i data-lucide="' + plan.icon + '" class="w-6 h-6 text-white"></i>' +
                        '</div>' +
                        '<div>' +
                            '<h3 class="text-base font-bold text-gray-900 dark:text-white leading-snug">' + plan.name + badge + '</h3>' +
                            '<span class="text-xs text-gray-500 dark:text-gray-400 capitalize">' + plan.category + ' Trading</span>' +
                        '</div>' +
                    '</div>' +
                    '<span class="flex-shrink-0 px-2.5 py-1 text-xs font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 rounded-full">' + plan.winRate + ' Win</span>' +
                '</div>' +
                '<p class="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-5">' + plan.description + '</p>' +
                '<div class="grid grid-cols-3 gap-3 mb-5">' +
                    '<div class="text-center p-3 bg-gray-50 dark:bg-gray-700/60 rounded-xl">' +
                        '<div class="text-sm font-bold ' + a.text + '">' + plan.minDailyPct + '–' + plan.maxDailyPct + '%</div>' +
                        '<div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Daily Profit</div>' +
                    '</div>' +
                    '<div class="text-center p-3 bg-gray-50 dark:bg-gray-700/60 rounded-xl">' +
                        '<div class="text-sm font-bold text-gray-900 dark:text-white">' + plan.durationDays + ' Days</div>' +
                        '<div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Duration</div>' +
                    '</div>' +
                    '<div class="text-center p-3 bg-gray-50 dark:bg-gray-700/60 rounded-xl">' +
                        '<div class="text-sm font-bold text-gray-900 dark:text-white">$' + plan.minAmount.toLocaleString() + '+</div>' +
                        '<div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Min. Invest</div>' +
                    '</div>' +
                '</div>' +
                '<div class="flex items-center justify-between text-sm mb-4 px-1">' +
                    '<span class="text-gray-500 dark:text-gray-400">Investment Range</span>' +
                    '<span class="font-semibold text-gray-900 dark:text-white">$' + plan.minAmount.toLocaleString() + ' – $' + plan.maxAmount.toLocaleString() + '</span>' +
                '</div>' +
                '<div class="mb-5">' +
                    '<p class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Trading Pairs</p>' +
                    '<div class="flex flex-wrap gap-1.5">' + pairs + '</div>' +
                '</div>' +
                cta +
            '</div>' +
        '</div>';
    }

    function renderPlanCards() {
        var grid = document.getElementById('bot-plans-grid');
        if (!grid) return;
        if (!INV.getPlans().length) {
            grid.innerHTML = '<p class="col-span-full text-center text-gray-500 dark:text-gray-400 py-8">Loading trading bot plans…</p>';
            return;
        }
        grid.innerHTML = INV.getPlans().map(planCardHTML).join('');
        grid.querySelectorAll('[data-invest-plan]').forEach(function (btn) {
            btn.addEventListener('click', function () { openInvestModal(btn.getAttribute('data-invest-plan')); });
        });
        bindFilters();
        refreshIcons();
    }

    function bindFilters() {
        var filterBtns = document.querySelectorAll('.filter-btn');
        var botCards = document.querySelectorAll('#bot-plans-grid .bot-card');
        function applyFilter(filter) {
            botCards.forEach(function (card) {
                if (filter === 'all' || card.dataset.category === filter) {
                    card.style.display = '';
                    card.style.animation = 'fadeIn 0.3s ease-in-out';
                } else {
                    card.style.display = 'none';
                }
            });
        }
        filterBtns.forEach(function (btn) {
            btn.onclick = function () {
                filterBtns.forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                applyFilter(btn.dataset.filter);
            };
        });
        var selected = document.querySelector('.filter-btn.active');
        applyFilter(selected ? selected.dataset.filter : 'all');
    }

    // ─── Invest Modal ────────────────────────────────────────────────────────

    function openInvestModal(planId) {
        var plan = INV.getPlan(planId);
        if (!plan) return;
        var balance = (typeof getBalance === 'function') ? getBalance() : 0;
        var estMin = plan.minDailyPct * plan.durationDays;
        var estMax = plan.maxDailyPct * plan.durationDays;

        Swal.fire({
            title: 'Invest in ' + plan.name,
            html:
                '<div class="text-left space-y-3" style="text-align:left">' +
                    '<div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;"><span style="color:#6b7280">Available Balance</span><strong>' + money(balance) + '</strong></div>' +
                    '<div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;"><span style="color:#6b7280">Plan Duration</span><strong>' + plan.durationDays + ' days</strong></div>' +
                    '<div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;"><span style="color:#6b7280">Simulated Daily Profit</span><strong>' + plan.minDailyPct + '% – ' + plan.maxDailyPct + '%</strong></div>' +
                    '<div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;"><span style="color:#6b7280">Est. Total Return</span><strong style="color:#059669">+' + estMin + '% to +' + estMax + '%</strong></div>' +
                    '<div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;"><span style="color:#6b7280">Allowed Range</span><strong>$' + plan.minAmount.toLocaleString() + ' – $' + plan.maxAmount.toLocaleString() + '</strong></div>' +
                    '<input id="invest-amount-input" aria-label="Investment amount in USD" inputmode="decimal" type="number" min="' + plan.minAmount + '" max="' + plan.maxAmount + '" step="0.01" placeholder="Enter amount (USD)" class="swal2-input" style="width:100%;margin:12px 0 0 0;box-sizing:border-box;">' +
                    '<div id="invest-estimate" style="font-size:13px;color:#6b7280;min-height:18px;margin-top:6px;"></div>' +
                '</div>',
            showCancelButton: true,
            confirmButtonText: 'Confirm Investment',
            confirmButtonColor: '#2563eb',
            cancelButtonText: 'Cancel',
            focusConfirm: false,
            showLoaderOnConfirm: true,
            didOpen: function () {
                var input = document.getElementById('invest-amount-input');
                var est = document.getElementById('invest-estimate');
                input.addEventListener('input', function () {
                    var v = parseFloat(input.value);
                    if (!isNaN(v) && v > 0) {
                        var lo = v * plan.minDailyPct / 100;
                        var hi = v * plan.maxDailyPct / 100;
                        est.textContent = 'Est. daily profit: ' + money(lo) + ' – ' + money(hi);
                    } else {
                        est.textContent = '';
                    }
                });
                if (window.matchMedia('(pointer: fine) and (min-width: 768px)').matches) input.focus();
            },
            preConfirm: async function () {
                var input = document.getElementById('invest-amount-input');
                var amount = parseFloat(input.value);
                var result = await INV.createInvestment(plan.id, amount);
                if (!result.ok) { Swal.showValidationMessage(result.error); return false; }
                return result.investment;
            },
            allowOutsideClick: function () { return !Swal.isLoading(); }
        }).then(function (res) {
            if (res.isConfirmed && res.value) {
                var inv = res.value;
                renderAll();
                Swal.fire({
                    icon: 'success',
                    title: 'Investment Created',
                    html: '<p style="font-size:14px;color:#6b7280">' + money(inv.amount) + ' has been invested in <strong>' + inv.botName + '</strong>.<br>' +
                          'Reference: <code>' + inv.id + '</code><br>' +
                          'Your balance has been updated.</p>',
                    timer: 3500,
                    showConfirmButton: true,
                    confirmButtonColor: '#2563eb'
                });
            }
        });
    }

    // ─── Active Investments ──────────────────────────────────────────────────

    function activeCardHTML(inv) {
        var plan = INV.getPlan(inv.botId) || {};
        var progress = Math.round(INV.getProgress(inv) * 100);
        var daysDone = inv.lastProcessedDay;
        var today = inv.dailyProfits.length ? inv.dailyProfits[inv.dailyProfits.length - 1] : null;
        var gradient = plan.gradient || 'from-blue-500 to-indigo-600';
        var dailyRows = inv.dailyProfits.map(function (d) {
            return '<div class="flex items-center justify-between text-xs py-1.5 border-b border-gray-100 dark:border-gray-700/60 last:border-0">' +
                '<span class="text-gray-500 dark:text-gray-400">Day ' + d.day + ' · ' + new Date(d.date).toLocaleDateString() + '</span>' +
                '<span class="text-gray-500 dark:text-gray-400">' + d.ratePct.toFixed(2) + '%</span>' +
                '<span class="font-semibold text-green-600 dark:text-green-400">+' + money(d.profit) + '</span>' +
            '</div>';
        }).join('');

        return '' +
        '<div class="bg-white dark:bg-gray-800 rounded-2xl shadow-md border border-gray-100 dark:border-gray-700 overflow-hidden">' +
            '<div class="h-1.5 bg-gradient-to-r ' + gradient + '"></div>' +
            '<div class="p-5">' +
                '<div class="flex items-start justify-between mb-4">' +
                    '<div class="flex items-center gap-3">' +
                        '<div class="w-10 h-10 bg-gradient-to-br ' + gradient + ' rounded-xl flex items-center justify-center flex-shrink-0">' +
                            '<i data-lucide="' + (plan.icon || 'bot') + '" class="w-5 h-5 text-white"></i>' +
                        '</div>' +
                        '<div>' +
                            '<h4 class="text-sm font-bold text-gray-900 dark:text-white">' + inv.botName + '</h4>' +
                            '<span class="text-xs text-gray-400">' + inv.id + '</span>' +
                        '</div>' +
                    '</div>' +
                    '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30">' +
                        '<span class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>Running</span>' +
                '</div>' +
                '<div class="grid grid-cols-3 gap-3 mb-4">' +
                    '<div class="text-center p-2.5 bg-gray-50 dark:bg-gray-700/60 rounded-xl">' +
                        '<div class="text-sm font-bold text-gray-900 dark:text-white">' + money(inv.amount) + '</div>' +
                        '<div class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">Invested</div>' +
                    '</div>' +
                    '<div class="text-center p-2.5 bg-gray-50 dark:bg-gray-700/60 rounded-xl">' +
                        '<div class="text-sm font-bold text-green-600 dark:text-green-400">+' + money(inv.totalProfit) + '</div>' +
                        '<div class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">Profit So Far</div>' +
                    '</div>' +
                    '<div class="text-center p-2.5 bg-gray-50 dark:bg-gray-700/60 rounded-xl">' +
                        '<div class="text-sm font-bold text-gray-900 dark:text-white">' + (today ? '+' + money(today.profit) : '—') + '</div>' +
                        '<div class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">Latest Daily</div>' +
                    '</div>' +
                '</div>' +
                '<div class="mb-2 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">' +
                    '<span>Day ' + daysDone + ' of ' + inv.durationDays + '</span>' +
                    '<span>' + INV.formatTimeRemaining(inv) + ' remaining</span>' +
                '</div>' +
                '<div class="w-full h-2.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden mb-4">' +
                    '<div class="h-full bg-gradient-to-r ' + gradient + ' rounded-full transition-all duration-700" style="width:' + progress + '%"></div>' +
                '</div>' +
                (dailyRows
                    ? '<details class="group"><summary class="cursor-pointer text-xs font-medium text-blue-600 dark:text-blue-400 select-none">Daily earnings breakdown</summary><div class="mt-2">' + dailyRows + '</div></details>'
                    : '<p class="text-xs text-gray-400">First daily profit will be credited after 24 hours.</p>') +
            '</div>' +
        '</div>';
    }

    function renderActive() {
        var container = document.getElementById('active-investments-list');
        var empty = document.getElementById('active-investments-empty');
        if (!container) return;
        var list = INV.getActiveInvestments();
        if (!list.length) {
            container.innerHTML = '';
            if (empty) empty.classList.remove('hidden');
        } else {
            if (empty) empty.classList.add('hidden');
            container.innerHTML = list.map(activeCardHTML).join('');
        }
        refreshIcons();
    }

    // ─── Investment History ──────────────────────────────────────────────────

    function historyRowHTML(inv) {
        var isCompleted = inv.status === 'completed';
        var statusBadge = isCompleted
            ? '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">Completed</span>'
            : '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30"><span class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>Running</span>';
        return '<tr class="hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors">' +
            '<td class="px-4 py-3 text-sm"><div class="font-medium text-gray-900 dark:text-white">' + inv.botName + '</div><div class="text-xs text-gray-400">' + inv.id + '</div></td>' +
            '<td class="px-4 py-3 text-sm font-semibold text-gray-900 dark:text-white">' + money(inv.amount) + '</td>' +
            '<td class="px-4 py-3 text-sm font-semibold text-green-600 dark:text-green-400">+' + money(inv.totalProfit) + '</td>' +
            '<td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">' + inv.durationDays + ' days</td>' +
            '<td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">' + new Date(inv.startTime).toLocaleDateString() + '</td>' +
            '<td class="px-4 py-3">' + statusBadge + '</td>' +
        '</tr>';
    }

    function historyCardHTML(inv) {
        var isCompleted = inv.status === 'completed';
        var statusBadge = isCompleted
            ? '<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">Completed</span>'
            : '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30"><span class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>Running</span>';
        return '<div class="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">' +
            '<div class="flex items-start justify-between mb-3">' +
                '<div><div class="font-medium text-gray-900 dark:text-white text-sm">' + inv.botName + '</div><div class="text-xs text-gray-400">' + inv.id + '</div></div>' +
                statusBadge +
            '</div>' +
            '<div class="grid grid-cols-3 gap-2 text-center">' +
                '<div><div class="text-xs text-gray-400">Amount</div><div class="text-sm font-semibold text-gray-900 dark:text-white">' + money(inv.amount) + '</div></div>' +
                '<div><div class="text-xs text-gray-400">Profit</div><div class="text-sm font-semibold text-green-600 dark:text-green-400">+' + money(inv.totalProfit) + '</div></div>' +
                '<div><div class="text-xs text-gray-400">Started</div><div class="text-sm text-gray-500 dark:text-gray-300">' + new Date(inv.startTime).toLocaleDateString() + '</div></div>' +
            '</div>' +
        '</div>';
    }

    function renderHistory() {
        var tbody = document.getElementById('investment-history-tbody');
        var mobile = document.getElementById('investment-history-mobile');
        var empty = document.getElementById('investment-history-empty');
        var table = document.getElementById('investment-history-table');
        if (!tbody && !mobile) return;
        var list = INV.getInvestments();
        if (!list.length) {
            if (empty) empty.classList.remove('hidden');
            if (table) table.classList.add('hidden');
            if (mobile) mobile.innerHTML = '';
            if (tbody) tbody.innerHTML = '';
        } else {
            if (empty) empty.classList.add('hidden');
            if (table) table.classList.remove('hidden');
            if (tbody) tbody.innerHTML = list.map(historyRowHTML).join('');
            if (mobile) mobile.innerHTML = list.map(historyCardHTML).join('');
        }
        refreshIcons();
    }

    // ─── Master render ───────────────────────────────────────────────────────

    function renderAll() {
        renderStats();
        renderPlanCards();
        renderActive();
        renderHistory();
    }

    document.addEventListener('DOMContentLoaded', function () {
        renderAll();
        // Plans are loaded asynchronously; the first render runs before /api/investments
        // responds, so refresh plan cards as well as balances and history.
        window.addEventListener('investments:updated', function () {
            renderAll();
        });
        window.addEventListener('investments:error', function (event) {
            var grid = document.getElementById('bot-plans-grid');
            if (grid && !INV.getPlans().length) {
                grid.textContent = 'Bot plans are temporarily unavailable: ' + event.detail;
            }
        });
        // Refresh countdown/progress UI every 60s.
        setInterval(renderActive, 60000);
    });

})();
