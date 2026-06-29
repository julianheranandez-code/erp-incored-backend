'use strict';
/**
 * Portfolio Intelligence Validator — Sprint P3.3
 * Centralized. Never duplicated in controllers.
 */
const VALID_STATUS    = ['ACTIVE','COMPLETED','ON_HOLD','CANCELLED','PIPELINE'];
const VALID_HEALTH    = ['EXCELLENT','GOOD','WARNING','CRITICAL','NO_DATA'];
const VALID_PRIORITY  = ['CRITICAL','HIGH','MEDIUM','LOW','MONITOR'];
const VALID_RISK      = ['CRITICAL','HIGH','MEDIUM','LOW','HEALTHY'];
const VALID_PERIOD_RE = /^\d{4}-\d{2}$/;
const VALID_ALLOC     = ['BY_CLIENT','BY_COMPANY','BY_PROJECT_TYPE','BY_REGION','BY_TECHNOLOGY','BY_STATUS','BY_BUSINESS_UNIT'];
const VALID_METRIC    = ['REVENUE','GROSS_PROFIT','MARGIN_PCT','CASH_CONSUMPTION','LIABILITY','COMMITMENT','HEALTH_SCORE','RISK_SCORE'];
const VALID_GROUPBY   = ['month','quarter','year'];

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
  validateProjectId(v) {
    if (!v) return null;
    const id = parseInt(v);
    if (isNaN(id)||id<1) throw new ValidationError('INVALID_PROJECT_ID','project_id must be a positive integer.','project_id');
    return id;
  },
  validateFiscalPeriod(v, required=false) {
    if (!v) { if(required) throw new ValidationError('FISCAL_PERIOD_REQUIRED','fiscal_period required.','fiscal_period'); return null; }
    if (!VALID_PERIOD_RE.test(v)) throw new ValidationError('INVALID_FISCAL_PERIOD',`fiscal_period must be YYYY-MM. Got: ${v}`,'fiscal_period');
    return v;
  },
  validateAllocationType(v) {
    if (!v) return null;
    if (!VALID_ALLOC.includes(v)) throw new ValidationError('INVALID_ALLOCATION_TYPE',`allocation_type must be: ${VALID_ALLOC.join(', ')}.`,'allocation_type');
    return v;
  },
  validateRankingMetric(v) {
    if (!v) return null;
    if (!VALID_METRIC.includes(v)) throw new ValidationError('INVALID_RANKING_METRIC',`metric must be: ${VALID_METRIC.join(', ')}.`,'metric');
    return v;
  },
  parsePortfolioFilters(query={}) {
    const f = {};
    if (query.fiscal_period)      f.fiscal_period      = module.exports.validateFiscalPeriod(query.fiscal_period);
    if (query.fiscal_period_from) f.fiscal_period_from = module.exports.validateFiscalPeriod(query.fiscal_period_from);
    if (query.fiscal_period_to)   f.fiscal_period_to   = module.exports.validateFiscalPeriod(query.fiscal_period_to);
    if (query.date_from)          f.date_from          = query.date_from;
    if (query.date_to)            f.date_to            = query.date_to;
    if (query.groupBy && VALID_GROUPBY.includes(query.groupBy)) f.group_by_period = query.groupBy;
    if (query.status   && VALID_STATUS.includes(query.status))   f.status  = query.status;
    if (query.health   && VALID_HEALTH.includes(query.health))   f.health  = query.health;
    if (query.priority && VALID_PRIORITY.includes(query.priority)) f.priority = query.priority;
    if (query.risk     && VALID_RISK.includes(query.risk))       f.risk    = query.risk;
    if (query.client_id) f.client_id = parseInt(query.client_id);
    if (query.limit)     f.limit = Math.min(parseInt(query.limit)||20, 100);
    return f;
  }
};
