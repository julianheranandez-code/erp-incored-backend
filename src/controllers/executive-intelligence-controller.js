'use strict';
/**
 * Executive Intelligence Controller — Sprint 6.4C
 * ADR-027: API Facade Pattern — controller calls Engine only.
 * No business logic. No SQL. No KPI calculations.
 */
const { v4: uuidv4 } = require('uuid');
const engine       = require('../services/executive-intelligence-service');
const { authorizeCompanyAccess, AuthorizationError }
                   = require('../services/financial-authorization-service');
const { validateCompanyId, parseExecutiveFilters, ValidationError }
                   = require('../validators/executive-intelligence-validator');
const factory      = require('../utils/executive-intelligence-response-factory');
const logger       = require('../utils/logger');

// ADR-028: RequestContext — immutable, passed through API layer
function buildRequestContext(req) {
  return Object.freeze({
    requestId:      req.id || uuidv4(),
    correlationId:  req.headers['x-correlation-id'] || uuidv4(),
    userId:         req.user?.id,
    companyId:      null,     // set after authorization
    permissions:    req.user?.permissions || [],
    locale:         req.headers['accept-language'] || 'es-MX',
    timezone:       req.headers['x-timezone'] || 'America/Mexico_City',
    startTime:      Date.now()
  });
}

// Base handler — ADR-027 Facade: validates → authorizes → calls Engine → responds
function withExecutiveAuth(endpoint, engineFn) {
  return async (req, res, next) => {
    const reqCtx    = buildRequestContext(req);
    const valStart  = Date.now();

    try {
      // 1. Validate
      const companyId = validateCompanyId(req.query.company_id);
      const filters   = parseExecutiveFilters(req.query);
      const validationMs = Date.now() - valStart;

      // 2. Authorize (reuse Financial Authorization Service — no duplication)
      await authorizeCompanyAccess(req.user, companyId);

      // 3. Call Engine (only the Engine — never Financial Platform directly)
      const engineStart = Date.now();
      const data        = await engineFn(companyId, filters, reqCtx.requestId, reqCtx.correlationId);
      const engineMs    = Date.now() - engineStart;
      const executionMs = Date.now() - reqCtx.startTime;

      // 4. Observe
      logger.info(`[ExecutiveAPI] ${endpoint}`, {
        endpoint, company_id: companyId, user_id: reqCtx.userId,
        request_id: reqCtx.requestId, correlation_id: reqCtx.correlationId,
        execution_ms: executionMs, engine_ms: engineMs,
        validation_ms: validationMs, http_status: 200
      });

      // 5. Respond
      return factory.success(res, data, {
        ...reqCtx, companyId, filters, executionMs, engineMs, validationMs
      });

    } catch(e) {
      const executionMs = Date.now() - reqCtx.startTime;
      const statusMap = {
        ValidationError:            400,
        AuthorizationError:         403,
        CompanyNotFound:            404,
        InsufficientFinancialData:  422,
        InvalidFiscalPeriod:        400,
      };
      const status = statusMap[e.name] || 500;
      const code   = e.code  || 'INTERNAL_ERROR';
      const msg    = status < 500 ? e.message : 'An internal error occurred.';

      logger.warn(`[ExecutiveAPI] ${endpoint} ${e.name}`, {
        endpoint, user_id: reqCtx.userId,
        request_id: reqCtx.requestId, correlation_id: reqCtx.correlationId,
        code, execution_ms: executionMs, http_status: status
      });

      if (status === 500) return next(e);
      return factory.error(res, status, code, msg, reqCtx);
    }
  };
}

// ── ENDPOINTS (ADR-027: one-liner Facade calls) ──────────────
const getDashboard = withExecutiveAuth('GET /dashboard',
  (id, f, r, c) => engine.getExecutiveDashboard(id, f));

const getInsights  = withExecutiveAuth('GET /insights',
  (id, f, r, c) => engine.getExecutiveInsights(id, f, r, c));

const getAlerts    = withExecutiveAuth('GET /alerts',
  (id, f, r, c) => engine.getExecutiveAlerts(id, f, r, c));

const getRankings  = withExecutiveAuth('GET /rankings',
  (id, f, r, c) => engine.getExecutiveRankings(id, f, r, c));

const getTrends    = withExecutiveAuth('GET /trends',
  (id, f, r, c) => engine.getExecutiveTrends(id, f, r, c));

const getRisk      = withExecutiveAuth('GET /risk',
  (id, f, r, c) => engine.getExecutiveRisk(id, f, r, c));

const getPortfolio = withExecutiveAuth('GET /portfolio',
  (id, f, r, c) => engine.getPortfolioSummary(id, f, [], r, c));

// CHANGE 5 — Health endpoint (no financial data)
async function getHealth(req, res) {
  const registry = require('../services/provider-registry');
  return res.json({
    success: true,
    data: {
      status:                'healthy',
      engine_version:        '6.4B-v1.0',
      schema_version:        'v1.0',
      configuration_provider:'StaticConfigurationProvider',
      registered_providers: {
        insight_provider:  registry.insightProvider?.name  || 'unknown',
        alert_provider:    registry.alertProvider?.name    || 'unknown',
        risk_strategy:     registry.riskStrategy?.name     || 'unknown',
        portfolio_provider:registry.portfolioProvider?.name|| 'unknown',
      },
      capabilities: ['dashboard','insights','alerts','rankings','trends','risk','portfolio'],
      timestamp: new Date().toISOString()
    }
  });
}

module.exports = {
  getDashboard, getInsights, getAlerts, getRankings,
  getTrends, getRisk, getPortfolio, getHealth
};
