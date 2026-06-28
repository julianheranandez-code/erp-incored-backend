'use strict';

/**
 * Executive Intelligence Context — Sprint 6.4B.1
 * ================================================
 * Loads Financial Platform data EXACTLY ONCE per request.
 * All Providers consume the same immutable Context.
 * No Provider may call the Financial Platform directly.
 *
 * ADR-021: Single context per request eliminates duplicate
 * Financial Platform calls. Before: each module called
 * getRawTotals() independently (3–6 calls per request).
 * After: exactly 1 call, shared across all providers.
 */

const { v4: uuidv4 } = require('uuid');
const queryService   = require('./financial-query-service');
const summaryService = require('./financial-summary-service');
const pnlService     = require('./financial-pnl-service');
const logger         = require('../utils/logger');

const SCHEMA_VERSION = 'v1.0';
const ENGINE_VERSION = '6.4B-v1.0';

// ─── FRESHNESS HELPER ────────────────────────────────────────
function computeFreshness(raw) {
  const lastEvent = raw?.data_as_of || null;
  const ageMs = lastEvent ? Date.now() - new Date(lastEvent).getTime() : null;
  if (ageMs === null)            return 'STALE';
  if (ageMs < 60_000)           return 'REAL_TIME';
  if (ageMs < 300_000)          return 'LESS_THAN_5_MIN';
  if (ageMs < 3_600_000)        return 'LESS_THAN_1_HOUR';
  if (ageMs < 86_400_000)       return 'LESS_THAN_1_DAY';
  return 'STALE';
}

/**
 * ExecutiveContext — immutable during request lifetime.
 * Created by ExecutiveContextFactory.build().
 * Providers receive context, never build it themselves.
 */
class ExecutiveContext {
  constructor({ companyId, filters, raw, summary, pnl, requestId, correlationId, loadedAt }) {
    // Freeze prevents accidental mutation (CHANGE 7 — request-scoped immutability)
    Object.assign(this, { companyId: parseInt(companyId), filters,
      raw, summary, pnl, requestId, correlationId, loadedAt });
    Object.freeze(this);
  }

  /** Build BaseMetadataDTO from this context — CHANGE 3: standard metadata */
  buildMeta(executionMs = 0) {
    return Object.freeze({
      schema_version:  SCHEMA_VERSION,
      engine_version:  ENGINE_VERSION,
      execution_ms:    executionMs,
      generated_at:    new Date().toISOString(),
      data_freshness:  computeFreshness(this.raw),
      request_id:      this.requestId,
      correlation_id:  this.correlationId
    });
  }

  /** Request-scoped cache (CHANGE 7) — lives only during this context */
  get cache() {
    if (!this._cache) {
      const cache = new Map();
      Object.defineProperty(this, '_cache', { value: cache, writable: false });
    }
    return this._cache;
  }

  get eventCount() {
    return Object.values(this.raw.by_event_type || {})
      .flat().reduce((a, r) => a + (r.event_count || 0), 0);
  }

  get netCash() {
    return (this.raw.cash_inflows_base || 0) - (this.raw.cash_outflows_base || 0);
  }

  get netLiability() {
    return (this.raw.gross_liability_base || 0) - (this.raw.reversed_liability_base || 0);
  }

  get fiscalPeriod() {
    return this.filters.fiscal_period || new Date().toISOString().slice(0, 7);
  }
}

/**
 * Factory — builds ExecutiveContext with exactly one Financial Platform call.
 * ADR-021: Single source of truth for request-scoped financial data.
 */
const ExecutiveContextFactory = {
  async build(companyId, filters = {}, requestId = uuidv4(), correlationId = uuidv4()) {
    const start = Date.now();
    logger.info('[ExecutiveContext] Loading financial platform data', {
      company_id: companyId, request_id: requestId
    });

    // CHANGE 11: Financial Platform called EXACTLY ONCE
    const [raw, summary, pnl] = await Promise.all([
      queryService.getRawTotals(companyId, filters),
      summaryService.getFinancialSummary(companyId, filters),
      pnlService.getProfitLoss(companyId, filters)
    ]);

    const ms = Date.now() - start;
    logger.info('[ExecutiveContext] Loaded', {
      company_id: companyId, request_id: requestId, execution_ms: ms
    });

    return new ExecutiveContext({
      companyId, filters, raw, summary, pnl,
      requestId, correlationId, loadedAt: new Date().toISOString()
    });
  }
};

module.exports = { ExecutiveContext, ExecutiveContextFactory };
