'use strict';

/**
 * Portfolio Context — Sprint P3.2
 * =================================
 * ADR-038: Portfolio Context — loads all required data ONCE per request.
 * Immutable during request lifetime. All capabilities consume same context.
 *
 * PERFORMANCE:
 *   Financial Platform:    called ONCE (3 parallel queries)
 *   Executive Platform:    called ONCE (health + risk)
 *   P&L per project:       called ONCE per project (parallel)
 *   Everything else:       reads from context
 */

const { v4: uuidv4 } = require('uuid');
const queryService   = require('./financial-query-service');
const summaryService = require('./financial-summary-service');
const pnlService     = require('./financial-pnl-service');
const intelligenceService = require('./executive-intelligence-service');
const logger = require('../utils/logger');

const SCHEMA_VERSION = 'v1.0';
const ENGINE_VERSION = 'P3.2-v1.0';

// ─── FRESHNESS ───────────────────────────────────────────────
function computeFreshness(ageMs) {
  if (ageMs === null)          return 'STALE';
  if (ageMs < 60_000)         return 'REAL_TIME';
  if (ageMs < 300_000)        return 'LESS_THAN_5_MIN';
  if (ageMs < 3_600_000)      return 'LESS_THAN_1_HOUR';
  if (ageMs < 86_400_000)     return 'LESS_THAN_1_DAY';
  return 'STALE';
}

class PortfolioContext {
  constructor({ companyId, filters, raw, summary, pnl, projectPnLs,
    executiveRisk, requestId, correlationId, loadedAt }) {
    Object.assign(this, { companyId: parseInt(companyId), filters,
      raw, summary, pnl, projectPnLs, executiveRisk,
      requestId, correlationId, loadedAt });
    Object.freeze(this);
  }

  buildMeta(executionMs = 0) {
    const ageMs = this.loadedAt
      ? Date.now() - new Date(this.loadedAt).getTime() : null;
    return Object.freeze({
      schema_version:  SCHEMA_VERSION,
      engine_version:  ENGINE_VERSION,
      execution_ms:    executionMs,
      generated_at:    new Date().toISOString(),
      data_freshness:  computeFreshness(ageMs),
      request_id:      this.requestId,
      correlation_id:  this.correlationId
    });
  }

  get fiscalPeriod() {
    return this.filters.fiscal_period || new Date().toISOString().slice(0,7);
  }

  get projectIds() {
    return Object.keys(this.projectPnLs).map(Number);
  }

  getProjectPnL(projectId) {
    return this.projectPnLs[projectId] || null;
  }

  get totalEventCount() {
    return Object.values(this.raw.by_event_type || {})
      .flat().reduce((a,r) => a + (r.event_count||0), 0);
  }
}

const PortfolioContextFactory = {
  async build(companyId, filters = {}, requestId = uuidv4(), correlationId = uuidv4()) {
    const start = Date.now();
    logger.info('[PortfolioContext] Building', { company_id: companyId, request_id: requestId });

    // PERFORMANCE: Financial Platform called ONCE (parallel)
    const [raw, summary, pnl] = await Promise.all([
      queryService.getRawTotals(companyId, filters),
      summaryService.getFinancialSummary(companyId, filters),
      pnlService.getProfitLoss(companyId, filters)
    ]);

    // Collect all project IDs from financial events
    const revenueProjects = await queryService.getRevenue(companyId, filters);
    const projectIds = [...new Set([
      ...revenueProjects.by_project.map(p => p.project_id),
      ...(await queryService.getOperatingExpenses(companyId, filters))
        .by_project.map(p => p.project_id)
    ])].filter(Boolean);

    // P&L per project — parallel, one call each
    const projectPnLResults = await Promise.all(
      projectIds.map(pid =>
        pnlService.getProjectProfitLoss(companyId, pid, filters)
          .then(p => [pid, p]).catch(() => [pid, null])
      )
    );
    const projectPnLs = Object.fromEntries(projectPnLResults.filter(([,p]) => p));

    // Executive Platform called ONCE
    const executiveRisk = await intelligenceService.getExecutiveRisk(
      companyId, filters, requestId, correlationId
    ).catch(() => null);

    logger.info('[PortfolioContext] Built', {
      company_id: companyId, request_id: requestId,
      project_count: projectIds.length, execution_ms: Date.now()-start
    });

    return new PortfolioContext({
      companyId, filters, raw, summary, pnl, projectPnLs,
      executiveRisk, requestId, correlationId,
      loadedAt: new Date().toISOString()
    });
  }
};

module.exports = { PortfolioContext, PortfolioContextFactory };
