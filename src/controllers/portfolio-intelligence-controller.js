'use strict';
/**
 * Portfolio Intelligence Controller v2 — Sprint P3.3A
 * ADR-056: Portfolio API Facade Pattern
 * ADR-062: Platform API Adapter Pattern
 * Pure orchestrator. No business logic. No SQL.
 */
const { v4: uuidv4 } = require('uuid');
const engine      = require('../services/portfolio-intelligence-engine');
const registry    = require('../services/portfolio-capability-registry');
const { withPlatformAuth, PlatformResponseFactory,
        buildPlatformHealthDTO, buildCapabilityDescriptorDTO,
        buildPlatformRequestContext } = require('../utils/platform-api-adapter');
const { validateCompanyId, validateProjectId, parsePortfolioFilters }
                  = require('../validators/portfolio-intelligence-validator');

// Standard validate function for portfolio endpoints
function portfolioValidate(req) {
  const companyId = validateCompanyId(req.query.company_id);
  const filters   = parsePortfolioFilters(req.query);
  return { companyId, filters };
}

// ── ENDPOINTS (one-liner Facade calls) ───────────────────────
const getDashboard   = withPlatformAuth('GET /portfolio/dashboard',
  portfolioValidate, (id,f) => engine.getPortfolioDashboard(id, f));

const getSummary     = withPlatformAuth('GET /portfolio/summary',
  portfolioValidate, (id,f) => engine.getPortfolioSummary(id, f));

const getProjects    = withPlatformAuth('GET /portfolio/projects',
  portfolioValidate, (id,f) => engine.getPortfolioProjects(id, f));

const getRankings    = withPlatformAuth('GET /portfolio/rankings',
  portfolioValidate, (id,f) => engine.getPortfolioRankings(id, f));

const getRisk        = withPlatformAuth('GET /portfolio/risk',
  portfolioValidate, (id,f) => engine.getPortfolioRisk(id, f));

const getAllocations  = withPlatformAuth('GET /portfolio/allocations',
  portfolioValidate, (id,f) => engine.getPortfolioAllocations(id, f));

const getRecommendations = withPlatformAuth('GET /portfolio/recommendations',
  portfolioValidate, async (id,f) => {
    const d = await engine.getPortfolioDashboard(id, f);
    return d.portfolio_alerts || [];
  });

// Project by ID
async function getProjectById(req, res, next) {
  const reqCtx = buildPlatformRequestContext(req);
  try {
    const { companyId, filters } = portfolioValidate(req);
    const projectId = validateProjectId(req.params.project_id);
    if (!projectId) return PlatformResponseFactory.validationError(res,
      { code:'INVALID_PROJECT_ID', message:'project_id required' }, reqCtx);
    const { authorizeCompanyAccess } = require('../services/financial-authorization-service');
    await authorizeCompanyAccess(req.user, companyId);
    const projects = await engine.getPortfolioProjects(companyId, { ...filters, project_id: projectId });
    const project  = projects.find(p=>p.project_id===projectId) || null;
    if (!project) return PlatformResponseFactory.error(res, 404, 'PROJECT_NOT_FOUND',
      `Project ${projectId} not found.`, reqCtx);
    return PlatformResponseFactory.success(res, project, {
      ...reqCtx, companyId, executionMs: Date.now()-reqCtx.startTime });
  } catch(e) { next(e); }
}

// ADR-057+058: Health endpoint with PlatformHealthDTO
async function getHealth(req, res) {
  const healthStatus = registry.getHealthStatus();
  const graph        = registry.getExecutionGraph();
  const allHealthy   = Object.values(healthStatus).every(h=>h==='HEALTHY');
  const dto = buildPlatformHealthDTO({
    platform: 'incored-erp', platform_version: 'v3.9',
    engine_version: 'P3.2-v1.0', pipeline_version: 'P3.2C-v1.0',
    registry_version: '3.0', execution_model: 'DYNAMIC_TOPOLOGICAL_SORT',
    dep_graph_version: '1.0', capabilities: Object.keys(graph),
    capability_health: healthStatus, status: allHealthy ? 'healthy' : 'degraded'
  });
  return PlatformResponseFactory.health(res, dto);
}

// ADR-057: Capability Discovery with CapabilityDescriptorDTO
async function getCapabilities(req, res) {
  const caps = registry.getCapabilities().map(buildCapabilityDescriptorDTO);
  return PlatformResponseFactory.capabilities(res, caps,
    { requestId: uuidv4(), correlationId: uuidv4() });
}

module.exports = {
  getDashboard, getSummary, getProjects, getProjectById,
  getRankings, getRisk, getAllocations, getRecommendations,
  getCapabilities, getHealth
};
