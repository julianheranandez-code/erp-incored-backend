'use strict';

/**
 * Portfolio Intelligence Engine v3 — Sprint P3.2B
 * =================================================
 * ADR-050: Engine as Pure Orchestrator
 *
 * Engine pattern (3 steps only):
 *   1. Build PortfolioContext
 *   2. Build CapabilityContext
 *   3. Execute Pipeline → assemble DTOs
 *
 * Engine NEVER:
 *   - Knows capability order
 *   - Manages dependencies
 *   - Calls capabilities directly
 *   - Contains business rules
 */

const { v4: uuidv4 } = require('uuid');
const { PortfolioContextFactory }         = require('./portfolio-context');
const { CapabilityContextFactory }        = require('./portfolio-capability-context');
const registry                            = require('./portfolio-capability-registry');
const { DynamicCapabilityPipeline: PortfolioCapabilityPipeline } = require('./portfolio-capability-pipeline');
const logger                              = require('../utils/logger');

// ─── TYPED ERRORS ────────────────────────────────────────────
class PortfolioNotFound extends Error {
  constructor(m){super(m);this.name='PortfolioNotFound';this.code='PORTFOLIO_NOT_FOUND';}
}
class InsufficientPortfolioData extends Error {
  constructor(m){super(m);this.name='InsufficientPortfolioData';this.code='INSUFFICIENT_PORTFOLIO_DATA';}
}
class InvalidFiscalPeriod extends Error {
  constructor(m){super(m);this.name='InvalidFiscalPeriod';this.code='INVALID_FISCAL_PERIOD';}
}

// ─── CORE: build context + run pipeline ──────────────────────
async function runPipeline(companyId, filters, reqId, corrId) {
  const ctx    = await PortfolioContextFactory.build(companyId, filters, reqId, corrId);
  const capCtx = CapabilityContextFactory.build(ctx);
  const result = PortfolioCapabilityPipeline.execute(registry, capCtx);
  return { ctx, capCtx, result };
}

// ─── PUBLIC API ──────────────────────────────────────────────

async function getPortfolioSummary(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('aggregation')?.summary ?? null;
}

async function getPortfolioProjects(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('aggregation')?.projects ?? [];
}

async function getPortfolioRankings(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('ranking') ?? { top_by_revenue:[], top_by_margin:[], bottom_by_margin:[],
    highest_cash_consumption:[], highest_liability:[], highest_commitment:[] };
}

async function getPortfolioAllocations(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { result } = await runPipeline(companyId, filters, reqId, corrId);
  return result.get('allocation') ?? [];
}

async function getPortfolioRisk(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const { ctx, result } = await runPipeline(companyId, filters, reqId, corrId);
  const projects    = result.get('aggregation')?.projects ?? [];
  const comparison  = result.get('comparison') ?? {};
  const baseRisk    = ctx.executiveRisk || { score:50, risk_level:'MEDIUM', dimensions:[] };
  const recs        = result.get('recommendation') ?? [];

  return {
    meta:          ctx.buildMeta(result.execution_ms),
    company_id:    ctx.companyId,
    fiscal_period: ctx.fiscalPeriod,
    score:         baseRisk.score,
    risk_level:    baseRisk.risk_level,
    drivers: [
      {
        dimension:'REVENUE_CONCENTRATION', weight:0.30,
        score: (comparison.revenue_concentration_top||0)>70?30:70,
        signal:`Top project: ${comparison.revenue_concentration_top||0}% of portfolio revenue.`,
        recommendation: (comparison.revenue_concentration_top||0)>70
          ? 'Diversify revenue across more projects.' : 'Distribution acceptable.',
        affected_projects: comparison.top_revenue_project_id ? [comparison.top_revenue_project_id] : [],
        data_quality:'HIGH'
      },
      {
        dimension:'PROJECT_HEALTH', weight:0.25,
        score: Math.round(projects.reduce((a,p)=>a+p.health_score,0)/(projects.length||1)),
        signal:`${projects.filter(p=>['WARNING','CRITICAL'].includes(p.health_level)).length} projects need attention.`,
        recommendation:'Monitor WARNING/CRITICAL projects weekly.',
        affected_projects: projects.filter(p=>p.health_level==='CRITICAL').map(p=>p.project_id),
        data_quality:'HIGH'
      }
    ],
    recommendations: recs.map(r => typeof r==='string' ? r : r.description || r.title),
    ai_enhanced: false
  };
}

async function getPortfolioDashboard(companyId, filters={}) {
  const start  = Date.now();
  const reqId  = uuidv4();
  const corrId = uuidv4();

  logger.info('[PortfolioEngine] getPortfolioDashboard', { company_id:companyId, request_id:reqId });

  // ADR-050: Engine = Context + Pipeline + DTO assembly
  const { ctx, result } = await runPipeline(companyId, filters, reqId, corrId);

  const projects     = result.get('aggregation')?.projects   ?? [];
  const summary      = result.get('aggregation')?.summary    ?? {};
  const rankings     = result.get('ranking')                 ?? {};
  const allocations  = result.get('allocation')              ?? [];
  const recs         = result.get('recommendation')          ?? [];
  const risk         = await getPortfolioRisk(companyId, filters, reqId, corrId);
  const ms           = Date.now() - start;

  logger.info('[PortfolioEngine] Dashboard complete', {
    company_id: companyId, request_id: reqId,
    project_count: projects.length, execution_ms: ms,
    pipeline_health: result.health_summary?.overall
  });

  return {
    meta:          ctx.buildMeta(ms),
    company_id:    ctx.companyId,
    fiscal_period: ctx.fiscalPeriod,
    summary,
    projects,
    rankings,
    risk,
    trends:        [],
    allocations,
    portfolio_alerts: recs.map(r => typeof r==='string' ? r : r.description || r.title),
    dashboard_meta: {
      project_count:     projects.length,
      event_count:       ctx.totalEventCount,
      execution_ms:      ms,
      data_as_of:        new Date().toISOString(),
      pipeline_health:   result.health_summary?.overall || 'HEALTHY',
      capability_timings: result.capability_timings,
      collections_empty: [
        ...(projects.length===0    ? ['projects']    : []),
        ...(allocations.length===0 ? ['allocations'] : []),
      ]
    }
  };
}

module.exports = {
  getPortfolioSummary, getPortfolioProjects, getPortfolioRankings,
  getPortfolioAllocations, getPortfolioRisk, getPortfolioDashboard,
  PortfolioNotFound, InsufficientPortfolioData, InvalidFiscalPeriod
};
