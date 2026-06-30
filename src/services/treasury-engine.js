'use strict';
/**
 * Treasury Engine — Sprint P4.1B
 * ADR-110: Treasury Engine
 * IAS-059: Treasury Engine
 *
 * Engine = 4 responsibilities ONLY:
 *   1. Build TreasuryContext
 *   2. Build CapabilityContext
 *   3. Execute Dynamic Pipeline
 *   4. Aggregate DTOs
 *
 * NEVER: calculates accounting balances, duplicates Financial Platform,
 *        executes SQL, knows HTTP/Express/Controllers.
 */
const { v4: uuidv4 } = require('uuid');
const { TreasuryContextFactory } = require('./treasury-context');
const { TreasuryCapabilityContextFactory } = require('./treasury-capability-context');
const registry = require('./treasury-capability-registry');
const { TreasuryDynamicPipeline } = require('./treasury-capability-pipeline');
const logger = require('../utils/logger');

class TreasuryNotFound extends Error {
  constructor(m){super(m);this.name='TreasuryNotFound';this.code='TREASURY_NOT_FOUND';}
}
class InsufficientTreasuryData extends Error {
  constructor(m){super(m);this.name='InsufficientTreasuryData';this.code='INSUFFICIENT_TREASURY_DATA';}
}

// Core: build context + run pipeline (responsibilities 1-3)
async function runPipeline(companyId, filters, reqId, corrId) {
  const ctx    = await TreasuryContextFactory.build(companyId, filters, reqId, corrId);
  const capCtx = TreasuryCapabilityContextFactory.build(ctx);
  const result = TreasuryDynamicPipeline.execute(registry, capCtx);
  return { ctx, capCtx, result };
}

// ── PUBLIC API (responsibility 4: aggregate DTOs) ────────────

async function getCashPosition(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('cashPosition');
}

async function getLiquidity(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('liquidity');
}

async function getForecast(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('forecast');
}

async function getPaymentCalendar(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('payments');
}

async function getCollectionCalendar(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('collections');
}

async function getFXExposure(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('fxExposure');
}

async function getWorkingCapital(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('workingCapital');
}

async function getTreasuryRisk(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('risk');
}

async function getTreasuryHealth(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('health');
}

async function getBankAccounts(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { ctx } = await runPipeline(companyId, filters, reqId, corrId);
  return ctx.bankAccounts || []; // RULE 1
}

async function getTreasuryDashboard(companyId, filters={}) {
  const start=Date.now(), reqId=uuidv4(), corrId=uuidv4();
  logger.info('[TreasuryEngine] getTreasuryDashboard', { company_id:companyId, request_id:reqId });

  const { ctx, result } = await runPipeline(companyId, filters, reqId, corrId);
  const ms = Date.now()-start;

  logger.info('[TreasuryEngine] Dashboard complete', {
    company_id:companyId, request_id:reqId, execution_ms:ms,
    pipeline_health: result.health_summary?.overall
  });

  const dashboard = result.get('dashboard');
  if (!dashboard) throw new InsufficientTreasuryData('Dashboard aggregation failed');

  return {
    ...dashboard,
    meta: ctx.buildMeta(ms),
    dashboard_meta: {
      ...dashboard.dashboard_meta,
      execution_ms: ms,
      pipeline_health: result.health_summary?.overall || 'HEALTHY',
      capability_timings: result.capability_timings
    }
  };
}

// Health support for engine (Module 10 — no API yet)
function getEngineHealth() {
  return {
    engine_version: 'P4.1B-v1.0',
    schema_version: 'v1.0',
    registered_capabilities: Object.keys(registry.getExecutionGraph()),
    dependency_graph: registry.getExecutionGraph(),
    capability_health: registry.getHealthStatus(),
    execution_plan: registry.resolveExecutionPlan().map(c=>c.id),
    pipeline_health: Object.values(registry.getHealthStatus()).every(h=>h==='HEALTHY') ? 'HEALTHY' : 'DEGRADED'
  };
}

module.exports = {
  getCashPosition, getLiquidity, getForecast, getPaymentCalendar,
  getCollectionCalendar, getFXExposure, getWorkingCapital,
  getTreasuryRisk, getTreasuryHealth, getBankAccounts, getTreasuryDashboard,
  getEngineHealth,
  TreasuryNotFound, InsufficientTreasuryData
};
