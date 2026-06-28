'use strict';
/**
 * Executive Intelligence Validator — Sprint 6.4C
 * Centralized validation. Never duplicated in controllers.
 */
const VALID_GROUP_BY = ['month','quarter','year'];
const VALID_PERIOD_RE = /^\d{4}-\d{2}$/;

class ValidationError extends Error {
  constructor(code, message, field=null) {
    super(message); this.name='ValidationError';
    this.code=code; this.field=field; this.statusCode=400;
  }
}

function validateCompanyId(value) {
  const id = parseInt(value);
  if (!value || isNaN(id) || id < 1)
    throw new ValidationError('INVALID_COMPANY_ID','company_id must be a positive integer.','company_id');
  return id;
}

function validateFiscalPeriod(value, required=false) {
  if (!value) { if (required) throw new ValidationError('FISCAL_PERIOD_REQUIRED','fiscal_period is required.','fiscal_period'); return null; }
  if (!VALID_PERIOD_RE.test(value)) throw new ValidationError('INVALID_FISCAL_PERIOD',`fiscal_period must be YYYY-MM format. Got: ${value}`,'fiscal_period');
  return value;
}

function validateGroupBy(value) {
  if (!value) return 'month';
  if (!VALID_GROUP_BY.includes(value))
    throw new ValidationError('INVALID_GROUP_BY',`groupBy must be: ${VALID_GROUP_BY.join(', ')}.`,'groupBy');
  return value;
}

function validateProjectId(value) {
  if (!value) return null;
  const id = parseInt(value);
  if (isNaN(id) || id < 1) throw new ValidationError('INVALID_PROJECT_ID','projectId must be a positive integer.','projectId');
  return id;
}

function parseExecutiveFilters(query={}) {
  const f = {};
  if (query.fiscal_period)      f.fiscal_period      = validateFiscalPeriod(query.fiscal_period);
  if (query.fiscal_period_from) f.fiscal_period_from = validateFiscalPeriod(query.fiscal_period_from);
  if (query.fiscal_period_to)   f.fiscal_period_to   = validateFiscalPeriod(query.fiscal_period_to);
  if (query.date_from)          f.date_from          = query.date_from;
  if (query.date_to)            f.date_to            = query.date_to;
  if (query.groupBy)            f.group_by_period    = validateGroupBy(query.groupBy);
  if (query.project_id)         f.project_id         = validateProjectId(query.project_id);
  if (query.currency)           f.currency           = query.currency.toUpperCase();
  return f;
}

module.exports = { ValidationError, validateCompanyId, validateFiscalPeriod, validateGroupBy, parseExecutiveFilters };
