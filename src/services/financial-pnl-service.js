'use strict';

/**
 * Real P&L Engine — Sprint 6.2
 * ==============================
 * REUSABLE BUSINESS SERVICE — Not a report. Not a dashboard.
 *
 * Consumers: Executive Dashboard, Board Reports, Portfolio,
 *            AI Platform, Forecast, PDF exports.
 *
 * RULES:
 *   ✅ Consumes Financial Analytics Layer only
 *   ✅ No SQL
 *   ✅ No Express
 *   ✅ All calculations use amount_base (cross-currency safe)
 *   ✅ Future sections return zero until producers exist
 *   ✅ Divide-by-zero safe
 *   ✅ Extensible: Depreciation, Interest, Taxes ready
 *
 * P&L STRUCTURE:
 *   Revenue
 *   (-) COGS
 *   = Gross Profit / Gross Margin %
 *   (-) Operating Expenses
 *   = Operating Income
 *   (+/-) Other Income / Other Expenses  [future]
 *   = EBIT
 *   (-) Taxes                            [future]
 *   = Net Income
 */

const summaryService = require('./financial-summary-service');
const queryService   = require('./financial-query-service');

// ═══════════════════════════════════════════════════════════════
// DTO DEFINITION
// ═══════════════════════════════════════════════════════════════

/**
 * @typedef {Object} PnLLineItem
 * @property {string}      label          - Display label
 * @property {number}      amount         - In base currency
 * @property {number}      event_count    - Supporting events
 * @property {boolean}     is_subtotal    - True for calculated lines
 * @property {boolean}     is_future      - True for zero-value future sections
 */

/**
 * @typedef {Object} ProfitLossStatement
 * @property {number}      company_id
 * @property {string|null} project_id
 * @property {Object}      filters
 * @property {string}      generated_at
 *
 * // Income Statement lines (all amounts in base currency)
 * @property {number}      revenue
 * @property {number}      cogs
 * @property {number}      gross_profit
 * @property {number|null} gross_margin_pct
 * @property {number}      operating_expenses
 * @property {number}      operating_income
 * @property {number}      other_income        [future — always 0 now]
 * @property {number}      other_expenses      [future — always 0 now]
 * @property {number}      ebit
 * @property {number}      taxes               [future — always 0 now]
 * @property {number}      net_income
 *
 * // Full structured sections (for rendering)
 * @property {PnLLineItem[]} sections
 *
 * // Period trend (if groupBy requested)
 * @property {Array|null}  trend
 */

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function round2(n) {
  return Math.round((parseFloat(n) + Number.EPSILON) * 100) / 100;
}

function safePct(numerator, denominator) {
  if (!denominator || denominator === 0) return null;
  return round2((numerator / denominator) * 100);
}

function lineItem(label, amount, eventCount = 0, isSubtotal = false, isFuture = false) {
  return { label, amount: round2(amount), event_count: eventCount,
           is_subtotal: isSubtotal, is_future: isFuture };
}

// ═══════════════════════════════════════════════════════════════
// CORE P&L CALCULATOR
// Pure function — no I/O, fully testable
// ═══════════════════════════════════════════════════════════════

/**
 * Build ProfitLossStatement from raw financial totals.
 * All values in base currency (amount_base).
 */
function buildPnL(raw, filters = {}) {
  // ── Revenue ────────────────────────────────────────────────
  const revenue    = round2(raw.revenue_base       || 0);
  const revenueCount = raw.by_event_type?.REVENUE?.reduce((a, r) => a + r.event_count, 0) || 0;

  // ── COGS ───────────────────────────────────────────────────
  const cogs       = round2(
    (raw.by_event_type?.COGS || []).reduce((a, r) => a + parseFloat(r.total_amount_base), 0)
  );
  const cogsCount  = (raw.by_event_type?.COGS || []).reduce((a, r) => a + r.event_count, 0);

  // ── Gross Profit ───────────────────────────────────────────
  const grossProfit    = round2(revenue - cogs);
  const grossMarginPct = safePct(grossProfit, revenue);

  // ── Operating Expenses ─────────────────────────────────────
  const opex      = round2(raw.operating_expenses_base || 0);
  const opexCount = (raw.by_event_type?.OPERATING_EXPENSE || [])
    .reduce((a, r) => a + r.event_count, 0);

  // ── Operating Income ───────────────────────────────────────
  const operatingIncome = round2(grossProfit - opex);

  // ── Other Income / Expenses [future — zero until producers] ─
  const otherIncome   = 0; // Sprint 7: Interest income, FX gains
  const otherExpenses = 0; // Sprint 7: Interest expense, FX losses

  // ── EBIT ───────────────────────────────────────────────────
  const ebit = round2(operatingIncome + otherIncome - otherExpenses);

  // ── Taxes [future] ─────────────────────────────────────────
  const taxes = 0; // Sprint 9: Tax engine

  // ── Net Income ─────────────────────────────────────────────
  const netIncome = round2(ebit - taxes);

  // ── Structured sections (for rendering) ───────────────────
  const sections = [
    lineItem('Revenue',               revenue,          revenueCount),
    lineItem('Cost of Goods Sold',    -cogs,            cogsCount,  false, cogsCount === 0),
    lineItem('Gross Profit',          grossProfit,      0,          true),
    lineItem('Operating Expenses',    -opex,            opexCount),
    lineItem('Operating Income',      operatingIncome,  0,          true),
    lineItem('Other Income',          otherIncome,      0,          false, true),
    lineItem('Other Expenses',        -otherExpenses,   0,          false, true),
    lineItem('EBIT',                  ebit,             0,          true),
    lineItem('Taxes',                 -taxes,           0,          false, true),
    lineItem('Net Income',            netIncome,        0,          true),
  ];

  return {
    company_id:          raw.company_id,
    project_id:          filters.project_id || null,
    filters,
    generated_at:        new Date().toISOString(),

    // Flat values (base currency)
    revenue,
    cogs,
    gross_profit:        grossProfit,
    gross_margin_pct:    grossMarginPct,
    operating_expenses:  opex,
    operating_income:    operatingIncome,
    other_income:        otherIncome,
    other_expenses:      otherExpenses,
    ebit,
    taxes,
    net_income:          netIncome,

    // Structured for rendering
    sections,

    // Supporting data
    raw_totals: {
      revenue_base:            raw.revenue_base,
      operating_expenses_base: raw.operating_expenses_base,
      cash_inflows_base:       raw.cash_inflows_base,
      cash_outflows_base:      raw.cash_outflows_base,
      commitments_base:        raw.commitments_base
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Generate P&L statement for a company.
 * Single Analytics call — no N+1.
 * @param {number} companyId
 * @param {Object} filters
 * @returns {Promise<ProfitLossStatement>}
 */
async function getProfitLoss(companyId, filters = {}) {
  const raw = await queryService.getRawTotals(companyId, filters);
  const pnl = buildPnL(raw, filters);

  // Add period trend if groupBy requested
  if (filters.group_by_period && filters.fiscal_period_from && filters.fiscal_period_to) {
    pnl.trend = await summaryService.getPeriodTrend(
      companyId,
      filters.fiscal_period_from,
      filters.fiscal_period_to,
      filters.group_by_period
    );
  } else {
    pnl.trend = null;
  }

  return pnl;
}

/**
 * Generate project-scoped P&L.
 * @param {number} companyId
 * @param {number} projectId
 * @param {Object} filters
 * @returns {Promise<ProfitLossStatement>}
 */
async function getProjectProfitLoss(companyId, projectId, filters = {}) {
  return getProfitLoss(companyId, { ...filters, project_id: projectId });
}

// Export buildPnL for unit testing (pure function)
module.exports = { getProfitLoss, getProjectProfitLoss, buildPnL };
