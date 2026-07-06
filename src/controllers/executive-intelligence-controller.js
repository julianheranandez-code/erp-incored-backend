'use strict';
/**
 * Executive Intelligence Controller v2 — Sprint P4.0B
 * Migrated to @incored/platform-core pattern.
 * ADR-062: Platform API Adapter Pattern
 *
 * BEFORE: custom withExecutiveAuth, executive-intelligence-response-factory.js
 * AFTER:  withPlatformAuth() — identical to Financial, Portfolio, Treasury
 */
const { v4: uuidv4 } = require('uuid');
const engine   = require('../services/executive-intelligence-service');
const registry = require('../services/provider-registry');

// MODULE 8: Platform Core — reuse, never duplicate
const {
  withPlatformAuth, PlatformResponseFactory,
  buildPlatformHealthDTO, buildPlatformRequestContext
} = require('../utils/platform-api-adapter');

// Standard validate function for executive endpoints
function executiveValidate(req) {
  const companyId = parseInt(req.query.company_id);
  if (!companyId || isNaN(companyId) || companyId < 1) {
    const err = new Error('company_id must be a positive integer.');
    err.name = 'ValidationError'; err.code = 'INVALID_COMPANY_ID'; err.statusCode = 400;
    throw err;
  }
  const filters = {};
  if (req.query.fiscal_period)      filters.fiscal_period      = req.query.fiscal_period;
  if (req.query.fiscal_period_from) filters.fiscal_period_from = req.query.fiscal_period_from;
  if (req.query.fiscal_period_to)   filters.fiscal_period_to   = req.query.fiscal_period_to;
  if (req.query.groupBy)            filters.group_by_period    = req.query.groupBy;
  if (req.query.project_id)         filters.project_id         = parseInt(req.query.project_id);
  return { companyId, filters };
}

// ── ENDPOINTS (Facade one-liners — ADR-062) ──────────────────
const getDashboard = withPlatformAuth('GET /executive/dashboard',
  executiveValidate, (id,f) => engine.getExecutiveDashboard(id, f));

const getInsights  = withPlatformAuth('GET /executive/insights',
  executiveValidate, (id,f,req,ctx) => engine.getExecutiveInsights(id, f, ctx.requestId, ctx.correlationId));

const getAlerts    = withPlatformAuth('GET /executive/alerts',
  executiveValidate, (id,f,req,ctx) => engine.getExecutiveAlerts(id, f, ctx.requestId, ctx.correlationId));

const getRankings  = withPlatformAuth('GET /executive/rankings',
  executiveValidate, (id,f,req,ctx) => engine.getExecutiveRankings(id, f, ctx.requestId, ctx.correlationId));

const getTrends    = withPlatformAuth('GET /executive/trends',
  executiveValidate, (id,f,req,ctx) => engine.getExecutiveTrends(id, f, ctx.requestId, ctx.correlationId));

const getRisk      = withPlatformAuth('GET /executive/risk',
  executiveValidate, (id,f,req,ctx) => engine.getExecutiveRisk(id, f, ctx.requestId, ctx.correlationId));

const getPortfolio = withPlatformAuth('GET /executive/portfolio',
  executiveValidate, (id,f,req,ctx) => engine.getPortfolioSummary(id, f, [], ctx.requestId, ctx.correlationId));

// Health endpoint (no auth — ADR-063)
async function getHealth(req, res) {
  const dto = buildPlatformHealthDTO({
    platform:            'incored-erp',
    platform_version:    'v3.9',
    engine_version:      '6.4B-v1.0',
    pipeline_version:    '6.4B-v1.0',
    registry_version:    '1.0',
    execution_model:     'PROVIDER_REGISTRY',
    capabilities:        ['dashboard','insights','alerts','rankings','trends','risk','portfolio'],
    capability_health:   {
      insight_provider:  registry.insightProvider?.name  ? 'HEALTHY' : 'UNKNOWN',
      alert_provider:    registry.alertProvider?.name    ? 'HEALTHY' : 'UNKNOWN',
      risk_strategy:     registry.riskStrategy?.name     ? 'HEALTHY' : 'UNKNOWN',
      portfolio_provider:registry.portfolioProvider?.name? 'HEALTHY' : 'UNKNOWN',
    },
    status: 'healthy'
  });
  return PlatformResponseFactory.health(res, {
    ...dto,
    registered_providers: {
      insight_provider:   registry.insightProvider?.name  || 'unknown',
      alert_provider:     registry.alertProvider?.name    || 'unknown',
      risk_strategy:      registry.riskStrategy?.name     || 'unknown',
      portfolio_provider: registry.portfolioProvider?.name|| 'unknown',
    }
  });
}

module.exports = {
  getDashboard, getInsights, getAlerts, getRankings,
  getTrends, getRisk, getPortfolio, getHealth
};
