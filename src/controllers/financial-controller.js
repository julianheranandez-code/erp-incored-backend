'use strict';

/**
 * Financial Controller v2 — Sprint 6.1C.1
 * ==========================================
 * ORCHESTRATION ONLY. No SQL. No KPIs.
 *
 * Request lifecycle:
 *   1. Attach request_id + correlation_id (middleware)
 *   2. Authorize company access (AuthorizationService)
 *   3. Parse filters (FilterParser)
 *   4. Call Analytics or Query Layer
 *   5. Return response (ResponseFactory)
 *   6. Log structured event
 */

const summaryService = require('../services/financial-summary-service');
const queryService   = require('../services/financial-query-service');
const { authorizeCompanyAccess, AuthorizationError }
                     = require('../services/financial-authorization-service');
const { parseFinancialFilters } = require('../utils/financial-filter-parser');
const response       = require('../utils/api-response');
const logger         = require('../utils/logger');

// ─── BASE HANDLER ─────────────────────────────────────────────
/**
 * Wraps every controller action with:
 *   - Authorization
 *   - Filter parsing
 *   - Timing
 *   - Structured logging
 *   - Error handling (AuthorizationError → 403, else → next())
 */
function withFinancialAuth(endpoint, serviceFn) {
  return async (req, res, next) => {
    const start = Date.now();
    const rid   = req.id          || require('crypto').randomUUID();
    const cid   = req.headers['x-correlation-id'] || require('crypto').randomUUID();

    try {
      const companyId = await authorizeCompanyAccess(req.user, req.query.company_id);
      const filters   = parseFinancialFilters(req.query);

      const data = await serviceFn(companyId, filters, req);

      const ms = Date.now() - start;
      logger.info(`[FinancialAPI] ${endpoint}`, {
        endpoint, company_id: companyId, user_id: req.user.id,
        request_id: rid, correlation_id: cid, execution_ms: ms,
        http_status: 200
      });

      return response.success(res, data, {
        company_id: companyId, filters,
        request_id: rid, correlation_id: cid, execution_ms: ms
      });

    } catch(e) {
      const ms = Date.now() - start;
      if (e instanceof AuthorizationError) {
        logger.warn(`[FinancialAPI] ${endpoint} DENIED`, {
          endpoint, user_id: req.user?.id,
          request_id: rid, correlation_id: cid,
          code: e.code, execution_ms: ms, http_status: e.statusCode
        });
        return response.error(res, e.statusCode, e.code, e.message,
          { request_id: rid, correlation_id: cid });
      }
      next(e);
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// ENDPOINT HANDLERS — each is a one-liner
// ═══════════════════════════════════════════════════════════════

const getSummary = withFinancialAuth('GET /summary',
  (companyId, filters) => summaryService.getFinancialSummary(companyId, filters));

const getRevenue = withFinancialAuth('GET /revenue',
  (companyId, filters) => queryService.getRevenue(companyId, filters));

const getExpenses = withFinancialAuth('GET /expenses',
  (companyId, filters) => queryService.getOperatingExpenses(companyId, filters));

const getCashFlow = withFinancialAuth('GET /cash-flow',
  async (companyId, filters) => {
    const [inflows, outflows] = await Promise.all([
      queryService.getCashInflows(companyId, filters),
      queryService.getCashOutflows(companyId, filters)
    ]);
    return { inflows, outflows };
  });

const getLiabilities = withFinancialAuth('GET /liabilities',
  (companyId, filters) => queryService.getLiabilities(companyId, filters));

const getCommitments = withFinancialAuth('GET /commitments',
  (companyId, filters) => queryService.getCommitments(companyId, filters));

// Project endpoint — needs projectId from params
async function getProjectSummary(req, res, next) {
  const start = Date.now();
  const rid   = req.id || require('crypto').randomUUID();
  const cid   = req.headers['x-correlation-id'] || require('crypto').randomUUID();

  try {
    const companyId  = await authorizeCompanyAccess(req.user, req.query.company_id);
    const projectId  = parseInt(req.params.projectId);
    if (!projectId || isNaN(projectId))
      return response.error(res, 400, 'INVALID_PROJECT',
        'projectId must be a valid integer.', { request_id: rid, correlation_id: cid });

    const filters = parseFinancialFilters(req.query);
    const data    = await summaryService.getProjectSummary(companyId, projectId, filters);
    const ms = Date.now() - start;

    logger.info('[FinancialAPI] GET /project', {
      endpoint: 'GET /project', company_id: companyId,
      project_id: projectId, user_id: req.user.id,
      request_id: rid, correlation_id: cid, execution_ms: ms, http_status: 200
    });

    return response.success(res, data, {
      company_id: companyId, project_id: projectId,
      filters, request_id: rid, correlation_id: cid, execution_ms: ms
    });
  } catch(e) {
    if (e instanceof AuthorizationError)
      return response.error(res, e.statusCode, e.code, e.message,
        { request_id: rid, correlation_id: cid });
    next(e);
  }
}

// Trends endpoint — needs from/to validation
async function getTrends(req, res, next) {
  const start = Date.now();
  const rid   = req.id || require('crypto').randomUUID();
  const cid   = req.headers['x-correlation-id'] || require('crypto').randomUUID();

  try {
    const companyId = await authorizeCompanyAccess(req.user, req.query.company_id);
    const from      = req.query.fiscal_period_from;
    const to        = req.query.fiscal_period_to;
    const groupBy   = ['month','quarter','year'].includes(req.query.groupBy)
      ? req.query.groupBy : 'month';

    if (!from || !to)
      return response.error(res, 400, 'PERIOD_REQUIRED',
        'fiscal_period_from and fiscal_period_to are required for trends.',
        { request_id: rid, correlation_id: cid });

    const data = await summaryService.getPeriodTrend(companyId, from, to, groupBy);
    const ms   = Date.now() - start;

    logger.info('[FinancialAPI] GET /trends', {
      endpoint: 'GET /trends', company_id: companyId,
      user_id: req.user.id, request_id: rid, correlation_id: cid,
      execution_ms: ms, http_status: 200, periods: data.length
    });

    return response.success(res, data, {
      company_id: companyId, group_by: groupBy, from, to,
      request_id: rid, correlation_id: cid, execution_ms: ms
    });
  } catch(e) {
    if (e instanceof AuthorizationError)
      return response.error(res, e.statusCode, e.code, e.message,
        { request_id: rid, correlation_id: cid });
    next(e);
  }
}

module.exports = {
  getSummary, getRevenue, getExpenses, getCashFlow,
  getLiabilities, getCommitments, getProjectSummary, getTrends
};
