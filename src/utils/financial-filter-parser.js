'use strict';
/**
 * Financial Filter Parser — Sprint 6.1C.1
 * Centralizes ALL filter normalization for Financial API.
 * Reusable across Treasury, Portfolio, Projects, Assets.
 */
const VALID_GROUP_BY  = ['month', 'quarter', 'year'];
const VALID_CURRENCIES = ['MXN', 'USD', 'EUR'];

function parseFinancialFilters(query = {}) {
  const f = {};
  if (query.project_id         != null) f.project_id         = parseInt(query.project_id);
  if (query.fiscal_period)              f.fiscal_period       = query.fiscal_period;
  if (query.fiscal_period_from)         f.fiscal_period_from  = query.fiscal_period_from;
  if (query.fiscal_period_to)           f.fiscal_period_to    = query.fiscal_period_to;
  if (query.date_from)                  f.date_from           = query.date_from;
  if (query.date_to)                    f.date_to             = query.date_to;
  if (query.source_type)                f.source_type         = query.source_type;
  if (query.currency) {
    const c = query.currency.toUpperCase();
    if (VALID_CURRENCIES.includes(c)) f.currency = c;
  }
  if (query.groupBy && VALID_GROUP_BY.includes(query.groupBy))
    f.group_by_period = query.groupBy;
  return f;
}

module.exports = { parseFinancialFilters };
