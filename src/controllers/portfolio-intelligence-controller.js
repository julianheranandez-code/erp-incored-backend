'use strict';
/**
 * Portfolio Intelligence Controller — Sprint P3.3
 * ADR-056: Portfolio API Facade Pattern
 * Pure orchestrator. No business logic. No SQL. No calculations.
 */
const { v4: uuidv4 } = require('uuid');
const engine      = require('../services/portfolio-intelligence-engine');
const registry    = require('../services/portfolio-capability-registry');
const { authorizeCompanyAccess, AuthorizationError }
                  = require('../services/financial-authorization-service');
const { ValidationError, validateCompanyId, validateProjectId,
        parsePortfolioFilters } = require('../validators/portfolio-intelligence-validator');
const factory     = require('../utils/portfolio-response-factory');
const logger      = require('../utils/logger');

// ADR-060: Portfolio Request Context
function buildRequestContext(req) {
  return Object.freeze({
    requestId:      req.id || uuidv4(),
    correlationId:  req.headers['x-correlation-id'] || uuidv4(),
    userId:         req.user?.id,
    permissions:    req.user?.permissions || [],
    locale:         req.headers['accept-language'] || 'es-MX',
    timezone:       req.headers['x-timezone'] || 'America/Mexico_City',
    featureFlags:   {},
    startTime:      Date.now()
  });
}

// Base handler — Facade: validate → authorize → engine → respond
function withPortfolioAuth(endpoint, engineFn) {
  return async (req, res, next) => {
    const reqCtx    = buildRequestContext(req);
    const valStart  = Date.now();
    try {
      const companyId    = validateCompanyId(req.query.company_id);
      const filters      = parsePortfolioFilters(req.query);
      const validationMs = Date.now() - valStart;
      await authorizeCompanyAccess(req.user, companyId);
      const engineStart  = Date.now();
      const data         = await engineFn(companyId, filters, req, reqCtx);
      const engineMs     = Date.now() - engineStart;
      const executionMs  = Date.now() - reqCtx.startTime;
      logger.info(`[PortfolioAPI] ${endpoint}`, {
        endpoint, company_id: companyId, user_id: reqCtx.userId,
        request_id: reqCtx.requestId, correlation_id: reqCtx.correlationId,
        execution_ms: executionMs, engine_ms: engineMs, validation_ms: validationMs,
        http_status: 200
      });
      return factory.success(res, data, {
        ...reqCtx, companyId, filters, executionMs, engineMs, validationMs
      });
    } catch(e) {
      const ms     = Date.now() - reqCtx.startTime;
      const status = { ValidationError:400, AuthorizationError:403,
        PortfolioNotFound:404, ProjectNotFound:404,
        InsufficientPortfolioData:422, InvalidFiscalPeriod:400,
        DependencyResolutionFailed:500 }[e.name] || 500;
      logger.warn(`[PortfolioAPI] ${endpoint} ${e.name}`, {
        endpoint, user_id: reqCtx.userId, request_id: reqCtx.requestId,
        code: e.code||'INTERNAL_ERROR', execution_ms: ms, http_status: status
      });
      if (status===500) return next(e);
      return factory.error(res, status, e.code||'ERROR', e.message, reqCtx);
    }
  };
}

// ── ENDPOINTS ────────────────────────────────────────────────
const getDashboard    = withPortfolioAuth('GET /dashboard',
  (id,f,req,ctx) => engine.getPortfolioDashboard(id, f));

const getSummary      = withPortfolioAuth('GET /summary',
  (id,f) => engine.getPortfolioSummary(id, f));

const getProjects     = withPortfolioAuth('GET /projects',
  (id,f) => engine.getPortfolioProjects(id, f));

const getRankings     = withPortfolioAuth('GET /rankings',
  (id,f) => engine.getPortfolioRankings(id, f));

const getRisk         = withPortfolioAuth('GET /risk',
  (id,f) => engine.getPortfolioRisk(id, f));

const getAllocations   = withPortfolioAuth('GET /allocations',
  (id,f) => engine.getPortfolioAllocations(id, f));

// Project by ID
async function getProjectById(req, res, next) {
  const reqCtx = buildRequestContext(req);
  try {
    const companyId  = validateCompanyId(req.query.company_id);
    const projectId  = validateProjectId(req.params.project_id);
    if (!projectId) return factory.error(res, 400, 'INVALID_PROJECT_ID', 'project_id required', reqCtx);
    await authorizeCompanyAccess(req.user, companyId);
    const filters  = parsePortfolioFilters(req.query);
    const projects = await engine.getPortfolioProjects(companyId, { ...filters, project_id: projectId });
    const project  = projects.find(p => p.project_id === projectId) || null;
    if (!project) return factory.error(res, 404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found.`, reqCtx);
    return factory.success(res, project, { ...reqCtx, companyId, filters,
      executionMs: Date.now()-reqCtx.startTime });
  } catch(e) { next(e); }
}

// Recommendations
const getRecommendations = withPortfolioAuth('GET /recommendations', async (id,f) => {
  const dashboard = await engine.getPortfolioDashboard(id, f);
  return dashboard.portfolio_alerts || [];
});

// ADR-057: Capability Discovery
async function getCapabilities(req, res) {
  const caps = registry.getCapabilities().map(c => ({
    id: c.id, name: c.id, version: c.version,
    provider: c.provider?.name || c.id,
    depends_on: c.depends_on, enabled: c.enabled,
    health: c.provider?.health || 'HEALTHY',
    description: c.description || ''
  }));
  return factory.success(res, caps, { requestId: uuidv4(), correlationId: uuidv4() });
}

// ADR-058: Health endpoint
async function getHealth(req, res) {
  const healthStatus = registry.getHealthStatus();
  const graph        = registry.getExecutionGraph();
  const allHealthy   = Object.values(healthStatus).every(h=>h==='HEALTHY');
  return res.json({ success:true, data: {
    status:              allHealthy ? 'healthy' : 'degraded',
    schema_version:      'v1.0',
    engine_version:      'P3.2-v1.0',
    pipeline_version:    'P3.2C-v1.0',
    registry_version:    '3.0',
    dependency_graph:    graph,
    capability_health:   healthStatus,
    registered_capabilities: Object.keys(graph),
    execution_model:     'DYNAMIC_TOPOLOGICAL_SORT',
    timestamp:           new Date().toISOString()
  }});
}

module.exports = {
  getDashboard, getSummary, getProjects, getProjectById,
  getRankings, getRisk, getAllocations, getRecommendations,
  getCapabilities, getHealth
};
