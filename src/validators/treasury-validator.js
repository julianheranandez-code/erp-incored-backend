'use strict';
/**
 * Treasury Validator — Sprint P4.1C
 * IAS-061: Treasury API Standard
 * ZERO business logic.
 */
const VALID_PERIOD_RE = /^\d{4}-\d{2}$/;
const VALID_HORIZON    = ['DAYS_7','DAYS_30','DAYS_90','DAYS_365'];
const VALID_CURRENCY   = ['MXN','USD','EUR','CAD','GBP'];

class ValidationError extends Error {
  constructor(code, message, field=null) {
    super(message); this.name='ValidationError';
    this.code=code; this.field=field; this.statusCode=400;
  }
}

module.exports = {
  ValidationError,
  validateCompanyId(v) {
    const id = parseInt(v);
    if (!v||isNaN(id)||id<1) throw new ValidationError('INVALID_COMPANY_ID','company_id must be a positive integer.','company_id');
    return id;
  },
  validateFiscalPeriod(v, required=false) {
    if (!v) { if(required) throw new ValidationError('FISCAL_PERIOD_REQUIRED','fiscal_period required.','fiscal_period'); return null; }
    if (!VALID_PERIOD_RE.test(v)) throw new ValidationError('INVALID_FISCAL_PERIOD',`fiscal_period must be YYYY-MM. Got: ${v}`,'fiscal_period');
    return v;
  },
  validateHorizon(v) {
    if (!v) return 'DAYS_30';
    if (!VALID_HORIZON.includes(v)) throw new ValidationError('INVALID_HORIZON',`horizon must be: ${VALID_HORIZON.join(', ')}.`,'horizon');
    return v;
  },
  validateCurrency(v) {
    if (!v) return null;
    const c = v.toUpperCase();
    if (!VALID_CURRENCY.includes(c)) throw new ValidationError('INVALID_CURRENCY',`currency must be: ${VALID_CURRENCY.join(', ')}.`,'currency');
    return c;
  },
  parseTreasuryFilters(query={}) {
    const f = {};
    if (query.fiscal_period)      f.fiscal_period      = module.exports.validateFiscalPeriod(query.fiscal_period);
    if (query.fiscal_period_from) f.fiscal_period_from = module.exports.validateFiscalPeriod(query.fiscal_period_from);
    if (query.fiscal_period_to)   f.fiscal_period_to   = module.exports.validateFiscalPeriod(query.fiscal_period_to);
    if (query.horizon)            f.horizon            = module.exports.validateHorizon(query.horizon);
    if (query.currency)           f.currency           = module.exports.validateCurrency(query.currency);
    if (query.date_from)          f.date_from          = query.date_from;
    if (query.date_to)            f.date_to            = query.date_to;
    if (query.limit)              f.limit = Math.min(parseInt(query.limit)||20, 100);
    if (query.sort)               f.sort  = query.sort;
    if (query.search)             f.search= query.search;
    return f;
  }
};
