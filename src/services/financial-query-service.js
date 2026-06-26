'use strict';

/**
 * Financial Query Service v2 — Sprint 6.1A.1
 * ============================================
 * PURE DATA ACCESS LAYER — SQL only.
 * No business calculations. No KPIs. No derived metrics.
 *
 * RESPONSIBILITIES:
 *   ✅ Read financial_events
 *   ✅ Apply filters
 *   ✅ Execute SQL aggregations
 *   ✅ Return normalized DTOs
 *
 * NOT RESPONSIBLE FOR:
 *   ❌ Gross Profit
 *   ❌ Net Cash
 *   ❌ Net Liability
 *   ❌ EBITDA
 *   ❌ Operating Margin
 *   ❌ Business interpretation
 *
 * CURRENCY RULES:
 *   amount      = original transaction currency (MXN, USD, etc.)
 *   amount_base = pre-computed base currency via exchange_rate at event creation
 *   Analytics layer MUST use amount_base for cross-currency comparisons.
 *
 * ALL queries enforce: status='active' (reversed events excluded)
 * ALL queries enforce: company_id scoping
 *
 * INDEXES USED:
 *   idx_fe_company_period_type  → (company_id, fiscal_period, event_type) WHERE active
 *   idx_fe_company_project_type → (company_id, project_id, event_type) WHERE active
 *   idx_fe_status               → partial WHERE status='active'
 */

const { query } = require('../config/database');

// ═══════════════════════════════════════════════════════════════
// DTOs
// ═══════════════════════════════════════════════════════════════

/**
 * @typedef {Object} PeriodTotal
 * @property {string} period         - Fiscal period label (YYYY-MM, YYYY-Q#, YYYY)
 * @property {number} total_amount   - Sum in original currency
 * @property {number} total_amount_base - Sum in base currency
 * @property {number} event_count    - Number of events
 */

/**
 * @typedef {Object} ProjectTotal
 * @property {number|null} project_id
 * @property {number} total_amount
 * @property {number} total_amount_base
 * @property {number} event_count
 */

/**
 * @typedef {Object} RevenueSummary
 * @property {string}        event_type         - Always 'REVENUE'
 * @property {number}        total_amount       - Sum in original currency
 * @property {number}        total_amount_base  - Sum in base currency (use for KPIs)
 * @property {number}        event_count
 * @property {number}        source_count       - Distinct invoices
 * @property {string|null}   earliest_date
 * @property {string|null}   latest_date
 * @property {string[]}      currencies
 * @property {PeriodTotal[]} by_period
 * @property {ProjectTotal[]} by_project
 */

/**
 * @typedef {Object} ExpenseSummary
 * @property {string[]}      event_types        - ['OPERATING_EXPENSE','COGS']
 * @property {number}        total_amount
 * @property {number}        total_amount_base
 * @property {number}        event_count
 * @property {PeriodTotal[]} by_period
 * @property {ProjectTotal[]} by_project
 * @property {Array}         by_subtype
 */

/**
 * @typedef {Object} CashFlowSummary
 * @property {string}        event_type
 * @property {number}        total_amount
 * @property {number}        total_amount_base
 * @property {number}        event_count
 * @property {PeriodTotal[]} by_period
 * @property {ProjectTotal[]} by_project
 */

/**
 * @typedef {Object} LiabilitySummary
 * @property {number} gross_liability       - Total LIABILITY events
 * @property {number} gross_liability_base
 * @property {number} total_reversed        - Total REVERSAL events against liabilities
 * @property {number} total_reversed_base
 * @property {number} liability_count
 * @property {number} reversal_count
 */

/**
 * @typedef {Object} CommitmentSummary
 * @property {string}        event_type
 * @property {number}        total_amount
 * @property {number}        total_amount_base
 * @property {number}        event_count
 * @property {PeriodTotal[]} by_period
 * @property {ProjectTotal[]} by_project
 */

/**
 * @typedef {Object} RawFinancialTotals
 * @property {number} revenue
 * @property {number} revenue_base
 * @property {number} operating_expenses
 * @property {number} operating_expenses_base
 * @property {number} cash_inflows
 * @property {number} cash_inflows_base
 * @property {number} cash_outflows
 * @property {number} cash_outflows_base
 * @property {number} gross_liability
 * @property {number} gross_liability_base
 * @property {number} reversed_liability
 * @property {number} reversed_liability_base
 * @property {number} commitments
 * @property {number} commitments_base
 * @property {Object} by_event_type        - Raw breakdown by type+subtype+currency
 */

// ═══════════════════════════════════════════════════════════════
// FILTER BUILDER
// ═══════════════════════════════════════════════════════════════

/**
 * @typedef {Object} QueryFilters
 * @property {number}  [project_id]
 * @property {string}  [fiscal_period]       - 'YYYY-MM' exact match
 * @property {string}  [fiscal_period_from]  - 'YYYY-MM' range start
 * @property {string}  [fiscal_period_to]    - 'YYYY-MM' range end
 * @property {string}  [date_from]           - 'YYYY-MM-DD'
 * @property {string}  [date_to]             - 'YYYY-MM-DD'
 * @property {string}  [currency]            - 'MXN' | 'USD'
 * @property {string}  [source_type]
 * @property {string}  [group_by_period]     - 'month' | 'quarter' | 'year'
 */

function buildFilters(companyId, filters = {}) {
  const conditions = [`company_id = $1`, `status = 'active'`];
  const values     = [parseInt(companyId)];
  let idx = 2;

  if (filters.project_id != null) {
    conditions.push(`project_id = $${idx++}`);
    values.push(parseInt(filters.project_id));
  }
  if (filters.fiscal_period) {
    conditions.push(`fiscal_period = $${idx++}`);
    values.push(filters.fiscal_period);
  }
  if (filters.fiscal_period_from) {
    conditions.push(`fiscal_period >= $${idx++}`);
    values.push(filters.fiscal_period_from);
  }
  if (filters.fiscal_period_to) {
    conditions.push(`fiscal_period <= $${idx++}`);
    values.push(filters.fiscal_period_to);
  }
  if (filters.date_from) {
    conditions.push(`event_date >= $${idx++}`);
    values.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push(`event_date <= $${idx++}`);
    values.push(filters.date_to);
  }
  if (filters.currency) {
    conditions.push(`currency = $${idx++}`);
    values.push(filters.currency.toUpperCase());
  }
  if (filters.source_type) {
    conditions.push(`source_type = $${idx++}`);
    values.push(filters.source_type);
  }

  return { where: `WHERE ${conditions.join(' AND ')}`, values, nextIdx: idx };
}

// ─── PERIOD GROUPING ─────────────────────────────────────────
/**
 * Generic period grouping — reusable by all queries.
 * group_by_period: 'month' (default) | 'quarter' | 'year'
 */
function periodGroupExpr(groupBy = 'month') {
  switch (groupBy) {
    case 'year':    return `TO_CHAR(event_date, 'YYYY')`;
    case 'quarter': return `TO_CHAR(event_date, 'YYYY-"Q"Q')`;
    default:        return `fiscal_period`; // YYYY-MM
  }
}

// ─── CORE AGGREGATOR ─────────────────────────────────────────
async function aggregateByType(eventType, companyId, filters = {}) {
  const { where, values, nextIdx } = buildFilters(companyId, filters);
  const typeParam   = `$${nextIdx}`;
  const allValues   = [...values, eventType];
  const periodExpr  = periodGroupExpr(filters.group_by_period);

  const [summary, byPeriod, byProject] = await Promise.all([
    query(`
      SELECT
        COALESCE(SUM(amount), 0)        AS total_amount,
        COALESCE(SUM(amount_base), 0)   AS total_amount_base,
        COUNT(*)::int                    AS event_count,
        COUNT(DISTINCT source_id)::int   AS source_count,
        COUNT(DISTINCT project_id)::int  AS project_count,
        MIN(event_date)::text            AS earliest_date,
        MAX(event_date)::text            AS latest_date,
        array_agg(DISTINCT currency)     AS currencies
      FROM financial_events
      ${where} AND event_type = ${typeParam}
    `, allValues),

    query(`
      SELECT
        ${periodExpr}                          AS period,
        COALESCE(SUM(amount), 0)               AS total_amount,
        COALESCE(SUM(amount_base), 0)          AS total_amount_base,
        COUNT(*)::int                           AS event_count
      FROM financial_events
      ${where} AND event_type = ${typeParam}
      GROUP BY 1 ORDER BY 1 ASC
    `, allValues),

    query(`
      SELECT
        project_id,
        COALESCE(SUM(amount), 0)               AS total_amount,
        COALESCE(SUM(amount_base), 0)          AS total_amount_base,
        COUNT(*)::int                           AS event_count
      FROM financial_events
      ${where} AND event_type = ${typeParam} AND project_id IS NOT NULL
      GROUP BY project_id ORDER BY total_amount DESC
    `, allValues)
  ]);

  const s = summary.rows[0];
  return {
    event_type:        eventType,
    total_amount:      parseFloat(s.total_amount),
    total_amount_base: parseFloat(s.total_amount_base),
    event_count:       s.event_count,
    source_count:      s.source_count,
    project_count:     s.project_count,
    earliest_date:     s.earliest_date || null,
    latest_date:       s.latest_date   || null,
    currencies:        (s.currencies || []).filter(Boolean),
    by_period:         byPeriod.rows.map(r => ({
      period:             r.period,
      total_amount:       parseFloat(r.total_amount),
      total_amount_base:  parseFloat(r.total_amount_base),
      event_count:        r.event_count
    })),
    by_project:        byProject.rows.map(r => ({
      project_id:         r.project_id,
      total_amount:       parseFloat(r.total_amount),
      total_amount_base:  parseFloat(r.total_amount_base),
      event_count:        r.event_count
    }))
  };
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API — Returns DTOs only. No business calculations.
// ═══════════════════════════════════════════════════════════════

/** @returns {Promise<RevenueSummary>} */
async function getRevenue(companyId, filters = {}) {
  return aggregateByType('REVENUE', companyId, filters);
}

/** @returns {Promise<ExpenseSummary>} */
async function getOperatingExpenses(companyId, filters = {}) {
  const { where, values, nextIdx } = buildFilters(companyId, filters);
  const typesParam  = `$${nextIdx}`;
  const allValues   = [...values, ['OPERATING_EXPENSE', 'COGS']];
  const periodExpr  = periodGroupExpr(filters.group_by_period);

  const [summary, byPeriod, byProject, bySubtype] = await Promise.all([
    query(`SELECT COALESCE(SUM(amount),0) AS total_amount,
      COALESCE(SUM(amount_base),0) AS total_amount_base, COUNT(*)::int AS event_count
      FROM financial_events ${where} AND event_type = ANY(${typesParam})`, allValues),
    query(`SELECT ${periodExpr} AS period, COALESCE(SUM(amount),0) AS total_amount,
      COALESCE(SUM(amount_base),0) AS total_amount_base, COUNT(*)::int AS event_count
      FROM financial_events ${where} AND event_type = ANY(${typesParam})
      GROUP BY 1 ORDER BY 1`, allValues),
    query(`SELECT project_id, COALESCE(SUM(amount),0) AS total_amount,
      COALESCE(SUM(amount_base),0) AS total_amount_base, COUNT(*)::int AS event_count
      FROM financial_events ${where} AND event_type = ANY(${typesParam}) AND project_id IS NOT NULL
      GROUP BY project_id ORDER BY total_amount DESC`, allValues),
    query(`SELECT event_subtype, COALESCE(SUM(amount),0) AS total_amount,
      COUNT(*)::int AS event_count
      FROM financial_events ${where} AND event_type = ANY(${typesParam})
      GROUP BY event_subtype ORDER BY total_amount DESC`, allValues)
  ]);

  const s = summary.rows[0];
  return {
    event_types:       ['OPERATING_EXPENSE', 'COGS'],
    total_amount:      parseFloat(s.total_amount),
    total_amount_base: parseFloat(s.total_amount_base),
    event_count:       s.event_count,
    by_period:  byPeriod.rows.map(r => ({ period: r.period,
      total_amount: parseFloat(r.total_amount),
      total_amount_base: parseFloat(r.total_amount_base), event_count: r.event_count })),
    by_project: byProject.rows.map(r => ({ project_id: r.project_id,
      total_amount: parseFloat(r.total_amount),
      total_amount_base: parseFloat(r.total_amount_base), event_count: r.event_count })),
    by_subtype: bySubtype.rows.map(r => ({ event_subtype: r.event_subtype,
      total_amount: parseFloat(r.total_amount), event_count: r.event_count }))
  };
}

/** @returns {Promise<CashFlowSummary>} */
async function getCashInflows(companyId, filters = {}) {
  return aggregateByType('CASH_INFLOW', companyId, filters);
}

/** @returns {Promise<CashFlowSummary>} */
async function getCashOutflows(companyId, filters = {}) {
  return aggregateByType('CASH_OUTFLOW', companyId, filters);
}

/** @returns {Promise<LiabilitySummary>} */
async function getLiabilities(companyId, filters = {}) {
  const { where, values } = buildFilters(companyId, filters);
  const result = await query(`
    SELECT
      COALESCE(SUM(CASE WHEN event_type='LIABILITY' THEN amount      ELSE 0 END),0) AS gross_liability,
      COALESCE(SUM(CASE WHEN event_type='LIABILITY' THEN amount_base ELSE 0 END),0) AS gross_liability_base,
      COALESCE(SUM(CASE WHEN event_type='REVERSAL'
        AND event_subtype IN ('AP_BILL_PAYMENT','AP_BILL_CANCEL')
        THEN amount      ELSE 0 END),0) AS total_reversed,
      COALESCE(SUM(CASE WHEN event_type='REVERSAL'
        AND event_subtype IN ('AP_BILL_PAYMENT','AP_BILL_CANCEL')
        THEN amount_base ELSE 0 END),0) AS total_reversed_base,
      COUNT(CASE WHEN event_type='LIABILITY' THEN 1 END)::int AS liability_count,
      COUNT(CASE WHEN event_type='REVERSAL'  THEN 1 END)::int AS reversal_count
    FROM financial_events
    ${where} AND event_type IN ('LIABILITY','REVERSAL')
  `, values);

  const r = result.rows[0];
  return {
    gross_liability:      parseFloat(r.gross_liability),
    gross_liability_base: parseFloat(r.gross_liability_base),
    total_reversed:       parseFloat(r.total_reversed),
    total_reversed_base:  parseFloat(r.total_reversed_base),
    liability_count:      r.liability_count,
    reversal_count:       r.reversal_count
    // net_liability = gross - reversed → computed by Analytics Layer
  };
}

/** @returns {Promise<CommitmentSummary>} */
async function getCommitments(companyId, filters = {}) {
  return aggregateByType('COMMITMENT', companyId, filters);
}

/**
 * Raw financial totals — Analytics Layer computes KPIs from this.
 * @returns {Promise<RawFinancialTotals>}
 */
async function getRawTotals(companyId, filters = {}) {
  const { where, values } = buildFilters(companyId, filters);

  const result = await query(`
    SELECT
      event_type, event_subtype, currency,
      COALESCE(SUM(amount), 0)      AS total_amount,
      COALESCE(SUM(amount_base), 0) AS total_amount_base,
      COUNT(*)::int                  AS event_count
    FROM financial_events
    ${where}
    GROUP BY event_type, event_subtype, currency
    ORDER BY event_type, event_subtype, currency
  `, values);

  // Helper: sum amount_base for event types
  const sumBase = (...types) => result.rows
    .filter(r => types.includes(r.event_type))
    .reduce((acc, r) => acc + parseFloat(r.total_amount_base), 0);

  const sum = (...types) => result.rows
    .filter(r => types.includes(r.event_type))
    .reduce((acc, r) => acc + parseFloat(r.total_amount), 0);

  // Group by_event_type for Analytics Layer
  const byType = {};
  for (const row of result.rows) {
    if (!byType[row.event_type]) byType[row.event_type] = [];
    byType[row.event_type].push({
      event_subtype:     row.event_subtype,
      currency:          row.currency,
      total_amount:      parseFloat(row.total_amount),
      total_amount_base: parseFloat(row.total_amount_base),
      event_count:       row.event_count
    });
  }

  return {
    company_id:               parseInt(companyId),
    filters,
    // Raw totals only — NO calculations here
    revenue:                  sum('REVENUE'),
    revenue_base:             sumBase('REVENUE'),
    operating_expenses:       sum('OPERATING_EXPENSE', 'COGS'),
    operating_expenses_base:  sumBase('OPERATING_EXPENSE', 'COGS'),
    cash_inflows:             sum('CASH_INFLOW'),
    cash_inflows_base:        sumBase('CASH_INFLOW'),
    cash_outflows:            sum('CASH_OUTFLOW'),
    cash_outflows_base:       sumBase('CASH_OUTFLOW'),
    gross_liability:          sum('LIABILITY'),
    gross_liability_base:     sumBase('LIABILITY'),
    reversed_liability:       sum('REVERSAL'),
    reversed_liability_base:  sumBase('REVERSAL'),
    commitments:              sum('COMMITMENT'),
    commitments_base:         sumBase('COMMITMENT'),
    by_event_type:            byType
  };
}

module.exports = {
  getRevenue,
  getOperatingExpenses,
  getCashInflows,
  getCashOutflows,
  getLiabilities,
  getCommitments,
  getRawTotals
};
