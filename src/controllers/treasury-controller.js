'use strict';
/**
 * Treasury Controller — Sprint P4.1C
 * ADR-112: Treasury API Facade
 * IAS-062: Treasury Controller Pattern
 *
 * Pure Facade. Reuses @incored/platform-core entirely.
 * ZERO business logic. ZERO duplication of Portfolio/Executive controller patterns.
 */
const { v4: uuidv4 } = require('uuid');
const engine    = require('../services/treasury-engine');
const registry  = require('../services/treasury-capability-registry');

// MODULE 8: Platform Core Integration — reuse, never duplicate
const {
  withPlatformAuth, PlatformResponseFactory,
  buildPlatformHealthDTO, buildCapabilityDescriptorDTO,
  buildPlatformRequestContext
} = require('../utils/platform-api-adapter');

const { validateCompanyId, parseTreasuryFilters } = require('../validators/treasury-validator');
const { authorizeCompanyAccess } = require('../services/financial-authorization-service');

// Standard validate function — reused across all treasury endpoints
function treasuryValidate(req) {
  const companyId = validateCompanyId(req.query.company_id);
  const filters   = parseTreasuryFilters(req.query);
  return { companyId, filters };
}

// ── ENDPOINTS (Facade one-liners — ADR-112) ──────────────────
const getDashboard         = withPlatformAuth('GET /treasury/dashboard',
  treasuryValidate, (id,f) => engine.getTreasuryDashboard(id, f));

const getCashPosition      = withPlatformAuth('GET /treasury/cash-position',
  treasuryValidate, (id,f) => engine.getCashPosition(id, f));

const getLiquidity         = withPlatformAuth('GET /treasury/liquidity',
  treasuryValidate, (id,f) => engine.getLiquidity(id, f));

const getForecast          = withPlatformAuth('GET /treasury/forecast',
  treasuryValidate, (id,f) => engine.getForecast(id, f));

const getPaymentCalendar   = withPlatformAuth('GET /treasury/payments',
  treasuryValidate, (id,f) => engine.getPaymentCalendar(id, f));

const getCollectionCalendar = withPlatformAuth('GET /treasury/collections',
  treasuryValidate, (id,f) => engine.getCollectionCalendar(id, f));

const getFXExposure        = withPlatformAuth('GET /treasury/fx-exposure',
  treasuryValidate, (id,f) => engine.getFXExposure(id, f));

const getWorkingCapital    = withPlatformAuth('GET /treasury/working-capital',
  treasuryValidate, (id,f) => engine.getWorkingCapital(id, f));

const getRisk              = withPlatformAuth('GET /treasury/risk',
  treasuryValidate, (id,f) => engine.getTreasuryRisk(id, f));

const getHealthStatus      = withPlatformAuth('GET /treasury/health-status',
  treasuryValidate, (id,f) => engine.getTreasuryHealth(id, f));

const getBankAccounts      = withPlatformAuth('GET /treasury/bank-accounts',
  treasuryValidate, (id,f) => engine.getBankAccounts(id, f));

// ── HEALTH ENDPOINT (Module 5 — no auth) ──────────────────────
// ADR-114: Treasury Capability Discovery
// IAS-064: Treasury Health Endpoint
async function getHealth(req, res) {
  const engineHealth = engine.getEngineHealth();
  const dto = buildPlatformHealthDTO({
    platform:           'incored-erp',
    platform_version:   'v3.9',
    engine_version:      engineHealth.engine_version,
    pipeline_version:   'P4.1B-v1.0',
    registry_version:   '1.0',
    execution_model:    'DYNAMIC_TOPOLOGICAL_SORT',
    dep_graph_version:  '1.0',
    capabilities:        engineHealth.registered_capabilities,
    capability_health:   engineHealth.capability_health,
    status:              engineHealth.pipeline_health === 'HEALTHY' ? 'healthy' : 'degraded'
  });
  // Extend with treasury-specific fields (Module 5)
  return PlatformResponseFactory.health(res, {
    ...dto,
    dependency_graph:  engineHealth.dependency_graph,
    execution_plan:    engineHealth.execution_plan,
    pipeline_health:   engineHealth.pipeline_health,
    feature_flags:     {} // reserved
  });
}

// ── CAPABILITIES ENDPOINT (Module 6) ──────────────────────────
// IAS-065: Treasury Capability Discovery
async function getCapabilities(req, res) {
  const plan = registry.resolveExecutionPlan().map(c => c.id);
  const caps = registry.getCapabilities().map(c => ({
    ...buildCapabilityDescriptorDTO(c),
    feature_flag:    c.feature_flag ?? null,
    execution_order: plan.indexOf(c.id) + 1
  }));
  return PlatformResponseFactory.capabilities(res, caps,
    { requestId: uuidv4(), correlationId: uuidv4() });
}

module.exports = {
  getDashboard, getCashPosition, getLiquidity, getForecast,
  getPaymentCalendar, getCollectionCalendar, getFXExposure,
  getWorkingCapital, getRisk, getHealthStatus, getBankAccounts,
  getHealth, getCapabilities
};
