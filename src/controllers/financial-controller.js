'use strict';
/**
 * Financial Controller v2 — Sprint P4.0B
 * Migrated to @incored/platform-core pattern.
 * ADR-062: Platform API Adapter Pattern
 *
 * BEFORE: custom try/catch, api-response.js, manual request context
 * AFTER:  withPlatformAuth() — same pattern as Portfolio + Treasury
 * ZERO business logic. ZERO duplication.
 */
const summaryService = require('../services/financial-summary-service');
const pnlService     = require('../services/financial-pnl-service');
const queryService   = require('../services/financial-query-service');
const { authorizeCompanyAccess } = require('../services/financial-authorization-service');
const { parseFinancialFilters }  = require('../utils/financial-filter-parser');
const logger = require('../utils/logger');

// MODULE 8: Platform Core — reuse, never duplicate
const {
  withPlatformAuth, PlatformResponseFactory,
  buildPlatformRequestContext
} = require('../utils/platform-api-adapter');

// Standard validate function for financial endpoints
function financialValidate(req) {
  const companyId = parseInt(req.query.company_id);
  if (!companyId || isNaN(companyId) || companyId < 1) {
    const err = new Error('company_id must be a positive integer.');
    err.name = 'ValidationError'; err.code = 'INVALID_COMPANY_ID'; err.statusCode = 400;
    throw err;
  }
  const filters = parseFinancialFilters(req.query);
  return { companyId, filters };
}

// ── ENDPOINTS (Facade one-liners — ADR-062) ──────────────────
const getSummary = withPlatformAuth('GET /financial/summary',
  financialValidate,
  (id, f) => summaryService.getFinancialSummary(id, f)
);

const getRevenue = withPlatformAuth('GET /financial/revenue',
  financialValidate,
  (id, f) => queryService.getRevenue(id, f)
);

const getExpenses = withPlatformAuth('GET /financial/expenses',
  financialValidate,
  (id, f) => queryService.getOperatingExpenses(id, f)
);

const getCashFlow = withPlatformAuth('GET /financial/cash-flow',
  financialValidate,
  async (id, f) => {
    const [inflows, outflows] = await Promise.all([
      queryService.getCashInflows(id, f),
      queryService.getCashOutflows(id, f)
    ]);
    return { inflows, outflows };
  }
);

const getLiabilities = withPlatformAuth('GET /financial/liabilities',
  financialValidate,
  (id, f) => queryService.getLiabilities(id, f)
);

const getCommitments = withPlatformAuth('GET /financial/commitments',
  financialValidate,
  (id, f) => queryService.getCommitments(id, f)
);

const getPnL = withPlatformAuth('GET /financial/pnl',
  financialValidate,
  (id, f) => pnlService.getProfitLoss(id, f)
);

const getTrends = withPlatformAuth('GET /financial/trends',
  financialValidate,
  async (id, f, req) => {
    const from = req.query.fiscal_period_from;
    const to   = req.query.fiscal_period_to;
    const groupBy = req.query.groupBy || 'month';
    if (!from || !to) {
      const err = new Error('fiscal_period_from and fiscal_period_to required for trends');
      err.name = 'ValidationError'; err.code = 'INVALID_FISCAL_PERIOD'; err.statusCode = 400;
      throw err;
    }
    return summaryService.getPeriodTrend(id, from, to, groupBy);
  }
);

// Project summary — keeps custom handler (needs :projectId param)
async function getProjectSummary(req, res, next) {
  const reqCtx = buildPlatformRequestContext(req);
  try {
    const companyId = parseInt(req.query.company_id);
    const projectId = parseInt(req.params.projectId);
    if (!companyId || isNaN(companyId))
      return PlatformResponseFactory.error(res, 400, 'INVALID_COMPANY_ID', 'company_id required', reqCtx);
    if (!projectId || isNaN(projectId))
      return PlatformResponseFactory.error(res, 400, 'INVALID_PROJECT_ID', 'projectId required', reqCtx);
    await authorizeCompanyAccess(req.user, companyId);
    const filters = parseFinancialFilters(req.query);
    const data    = await pnlService.getProjectProfitLoss(companyId, projectId, filters);
    return PlatformResponseFactory.success(res, data, {
      ...reqCtx, companyId, executionMs: Date.now()-reqCtx.startTime
    });
  } catch(e) {
    if (e.name === 'ValidationError' || e.name === 'AuthorizationError')
      return PlatformResponseFactory.error(res, e.statusCode||400, e.code||'ERROR', e.message, reqCtx);
    next(e);
  }
}

module.exports = {
  getSummary, getRevenue, getExpenses, getCashFlow,
  getLiabilities, getCommitments, getPnL, getTrends,
  getProjectSummary
};
