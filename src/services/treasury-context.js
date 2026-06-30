'use strict';
/**
 * Treasury Context — Sprint P4.1B
 * ADR-106: Treasury Context
 * IAS-056: Treasury Context
 * Loads Financial Platform EXACTLY ONCE per request. Immutable.
 * RULE 7: Treasury NEVER recalculates accounting facts.
 */
const { v4: uuidv4 } = require('uuid');
const queryService    = require('./financial-query-service');
const summaryService  = require('./financial-summary-service');
const pnlService      = require('./financial-pnl-service');
const intelligenceService = require('./executive-intelligence-service');
const logger = require('../utils/logger');

const SCHEMA_VERSION = 'v1.0';
const ENGINE_VERSION = 'P4.1B-v1.0';

function computeFreshness(ageMs) {
  if (ageMs===null) return'STALE';
  if (ageMs<60_000) return'REAL_TIME';
  if (ageMs<300_000) return'LESS_THAN_5_MIN';
  if (ageMs<3_600_000) return'LESS_THAN_1_HOUR';
  if (ageMs<86_400_000) return'LESS_THAN_1_DAY';
  return'STALE';
}

class TreasuryContext {
  constructor({ companyId, filters, raw, summary, pnl, bankAccounts,
    executiveRisk, requestId, correlationId, loadedAt }) {
    Object.assign(this, { companyId: parseInt(companyId), filters,
      raw, summary, pnl, bankAccounts, executiveRisk,
      requestId, correlationId, loadedAt });
    Object.freeze(this);
  }

  buildMeta(executionMs=0) {
    const ageMs = this.loadedAt ? Date.now()-new Date(this.loadedAt).getTime() : null;
    return Object.freeze({
      schema_version: SCHEMA_VERSION, engine_version: ENGINE_VERSION,
      execution_ms: executionMs, generated_at: new Date().toISOString(),
      data_freshness: computeFreshness(ageMs),
      request_id: this.requestId, correlation_id: this.correlationId
    });
  }

  get fiscalPeriod() { return this.filters.fiscal_period || new Date().toISOString().slice(0,7); }
  get netCash()      { return (this.raw.cash_inflows_base||0)-(this.raw.cash_outflows_base||0); }
  get netLiability()  { return (this.raw.gross_liability_base||0)-(this.raw.reversed_liability_base||0); }
  get totalEventCount() {
    return Object.values(this.raw.by_event_type||{}).flat().reduce((a,r)=>a+(r.event_count||0),0);
  }
}

const TreasuryContextFactory = {
  async build(companyId, filters={}, requestId=uuidv4(), correlationId=uuidv4()) {
    const start = Date.now();
    logger.info('[TreasuryContext] Building', { company_id:companyId, request_id:requestId });

    // Financial Platform — ONCE (parallel)
    const [raw, summary, pnl] = await Promise.all([
      queryService.getRawTotals(companyId, filters),
      summaryService.getFinancialSummary(companyId, filters),
      pnlService.getProfitLoss(companyId, filters)
    ]);

    // Bank accounts — placeholder until bank_accounts table exists (Sprint P4.1C migration)
    // Treasury Engine reads via this hook; SQL/migration is out of scope for P4.1B
    const bankAccounts = []; // populated when bank_accounts table is migrated

    // Executive Platform — ONCE
    const executiveRisk = await intelligenceService.getExecutiveRisk(
      companyId, filters, requestId, correlationId
    ).catch(()=>null);

    logger.info('[TreasuryContext] Built', {
      company_id:companyId, request_id:requestId, execution_ms:Date.now()-start
    });

    return new TreasuryContext({
      companyId, filters, raw, summary, pnl, bankAccounts, executiveRisk,
      requestId, correlationId, loadedAt:new Date().toISOString()
    });
  }
};

module.exports = { TreasuryContext, TreasuryContextFactory };
