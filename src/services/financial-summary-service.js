'use strict';

/**
 * Financial Summary Service (Analytics Layer) — Sprint 6.1A.1
 * =============================================================
 * PURE BUSINESS CALCULATIONS — No SQL. No DB access.
 *
 * RESPONSIBILITIES:
 *   ✅ Receive raw data from financial-query-service
 *   ✅ Calculate Gross Profit, Net Cash, Net Liability
 *   ✅ Calculate Operating Margin, EBITDA (future)
 *   ✅ Return strongly-typed FinancialSummary
 *
 * NOT RESPONSIBLE FOR:
 *   ❌ SQL queries
 *   ❌ DB access
 *   ❌ Formatting
 *   ❌ UI concerns
 *
 * CURRENCY RULE:
 *   All KPI calculations use amount_base (base currency)
 *   to ensure cross-currency comparisons are valid.
 *   Raw amount (original currency) is preserved in output.
 */

const queryService = require('./financial-query-service');

// ═══════════════════════════════════════════════════════════════
// DTOs
// ═══════════════════════════════════════════════════════════════

/**
 * @typedef {Object} FinancialSummary
 * @property {number} company_id
 * @property {Object} filters
 *
 * // Raw totals (original currency)
 * @property {number} revenue
 * @property {number} operating_expenses
 * @property {number} cash_inflows
 * @property {number} cash_outflows
 * @property {number} gross_liability
 * @property {number} reversed_liability
 * @property {number} commitments
 *
 * // Base currency totals (for KPIs)
 * @property {number} revenue_base
 * @property {number} operating_expenses_base
 * @property {number} cash_inflows_base
 * @property {number} cash_outflows_base
 *
 * // Calculated KPIs (always in base currency)
 * @property {number} gross_profit          - revenue_base - operating_expenses_base
 * @property {number} net_cash              - cash_inflows_base - cash_outflows_base
 * @property {number} net_liability         - gross_liability_base - reversed_liability_base
 * @property {number|null} gross_margin_pct - gross_profit / revenue_base (null if revenue=0)
 *
 * @property {Object} by_event_type
 */

// ═══════════════════════════════════════════════════════════════
// ANALYTICS CALCULATIONS
// ═══════════════════════════════════════════════════════════════

function safeDivide(numerator, denominator) {
  if (!denominator || denominator === 0) return null;
  return numerator / denominator;
}

function roundTo2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Build complete FinancialSummary from raw totals.
 * All KPIs calculated here — not in Query Layer.
 * @param {import('./financial-query-service').RawFinancialTotals} raw
 * @returns {FinancialSummary}
 */
function buildFinancialSummary(raw) {
  const grossProfit   = raw.revenue_base - raw.operating_expenses_base;
  const netCash       = raw.cash_inflows_base - raw.cash_outflows_base;
  const netLiability  = raw.gross_liability_base - raw.reversed_liability_base;
  const marginPct     = safeDivide(grossProfit, raw.revenue_base);

  return {
    company_id:   raw.company_id,
    filters:      raw.filters,

    // Raw totals — original currency
    revenue:              roundTo2(raw.revenue),
    operating_expenses:   roundTo2(raw.operating_expenses),
    cash_inflows:         roundTo2(raw.cash_inflows),
    cash_outflows:        roundTo2(raw.cash_outflows),
    gross_liability:      roundTo2(raw.gross_liability),
    reversed_liability:   roundTo2(raw.reversed_liability),
    commitments:          roundTo2(raw.commitments),

    // Base currency totals
    revenue_base:             roundTo2(raw.revenue_base),
    operating_expenses_base:  roundTo2(raw.operating_expenses_base),
    cash_inflows_base:        roundTo2(raw.cash_inflows_base),
    cash_outflows_base:       roundTo2(raw.cash_outflows_base),
    gross_liability_base:     roundTo2(raw.gross_liability_base),
    reversed_liability_base:  roundTo2(raw.reversed_liability_base),
    commitments_base:         roundTo2(raw.commitments_base),

    // ── CALCULATED KPIs (base currency only) ──────────────
    gross_profit:     roundTo2(grossProfit),
    net_cash:         roundTo2(netCash),
    net_liability:    roundTo2(netLiability),
    gross_margin_pct: marginPct !== null ? roundTo2(marginPct * 100) : null,

    // Raw breakdown for drill-down
    by_event_type: raw.by_event_type
  };
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Get complete financial summary with KPIs.
 * Orchestrates Query Layer → Analytics Layer.
 * @param {number} companyId
 * @param {Object} filters
 * @returns {Promise<FinancialSummary>}
 */
async function getFinancialSummary(companyId, filters = {}) {
  const raw = await queryService.getRawTotals(companyId, filters);
  return buildFinancialSummary(raw);
}

/**
 * Get project-level P&L summary.
 * @param {number} companyId
 * @param {number} projectId
 * @param {Object} filters
 * @returns {Promise<FinancialSummary>}
 */
async function getProjectSummary(companyId, projectId, filters = {}) {
  const raw = await queryService.getRawTotals(companyId, { ...filters, project_id: projectId });
  return { ...buildFinancialSummary(raw), project_id: projectId };
}

/**
 * Get multi-period P&L trend.
 * Returns array of FinancialSummary per period — ready for charts.
 * @param {number}   companyId
 * @param {string}   from   - 'YYYY-MM'
 * @param {string}   to     - 'YYYY-MM'
 * @param {string}   groupBy - 'month' | 'quarter' | 'year'
 * @returns {Promise<FinancialSummary[]>}
 */
async function getPeriodTrend(companyId, from, to, groupBy = 'month') {
  const [revenue, expenses, inflows, outflows] = await Promise.all([
    queryService.getRevenue(companyId, { fiscal_period_from: from, fiscal_period_to: to, group_by_period: groupBy }),
    queryService.getOperatingExpenses(companyId, { fiscal_period_from: from, fiscal_period_to: to, group_by_period: groupBy }),
    queryService.getCashInflows(companyId, { fiscal_period_from: from, fiscal_period_to: to, group_by_period: groupBy }),
    queryService.getCashOutflows(companyId, { fiscal_period_from: from, fiscal_period_to: to, group_by_period: groupBy })
  ]);

  // Collect all unique periods
  const periods = [...new Set([
    ...revenue.by_period.map(p => p.period),
    ...expenses.by_period.map(p => p.period),
    ...inflows.by_period.map(p => p.period),
    ...outflows.by_period.map(p => p.period)
  ])].sort();

  const findPeriod = (arr, period) =>
    arr.find(p => p.period === period) || { total_amount_base: 0 };

  return periods.map(period => {
    const rev  = findPeriod(revenue.by_period, period).total_amount_base;
    const exp  = findPeriod(expenses.by_period, period).total_amount_base;
    const inf  = findPeriod(inflows.by_period, period).total_amount_base;
    const out  = findPeriod(outflows.by_period, period).total_amount_base;
    const gp   = rev - exp;

    return {
      period,
      revenue_base:            roundTo2(rev),
      operating_expenses_base: roundTo2(exp),
      gross_profit:            roundTo2(gp),
      cash_inflows_base:       roundTo2(inf),
      cash_outflows_base:      roundTo2(out),
      net_cash:                roundTo2(inf - out),
      gross_margin_pct:        safeDivide(gp, rev) !== null ? roundTo2(safeDivide(gp, rev) * 100) : null
    };
  });
}

module.exports = {
  getFinancialSummary,
  getProjectSummary,
  getPeriodTrend,
  buildFinancialSummary  // exported for unit testing
};
