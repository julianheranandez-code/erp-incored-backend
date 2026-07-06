'use strict';

/**
 * Executive Intelligence Engine v2 — Sprint 6.4B.1
 * ==================================================
 * ORCHESTRATOR ONLY. No business logic. No SQL.
 *
 * BEFORE: Engine called Financial Platform 3-6× per request
 * AFTER:  Financial Platform called exactly once (ExecutiveContext)
 *
 * Pattern: Context → Registry → Providers → DTOs
 *
 * ADR-025: Engine depends ONLY on interfaces via Registry.
 * To add AI: update provider-registry.js. Engine unchanged.
 */

const { v4: uuidv4 } = require('uuid');
const { ExecutiveContextFactory } = require('./executive-intelligence-context');
const registry   = require('./provider-registry');
const pnlService = require('./financial-pnl-service');
const summaryService = require('./financial-summary-service');
const logger     = require('../utils/logger');

const round2 = n => Math.round((parseFloat(n||0)+Number.EPSILON)*100)/100;
const safePct = (n, d) => (!d||d===0)?null:round2((n/d)*100);

// ─── TYPED ERRORS ────────────────────────────────────────────
class InsufficientFinancialData extends Error {
  constructor(m){super(m);this.name='InsufficientFinancialData';this.code='INSUFFICIENT_FINANCIAL_DATA';}
}
class InvalidFiscalPeriod extends Error {
  constructor(m){super(m);this.name='InvalidFiscalPeriod';this.code='INVALID_FISCAL_PERIOD';}
}
class CompanyNotFound extends Error {
  constructor(m){super(m);this.name='CompanyNotFound';this.code='COMPANY_NOT_FOUND';}
}

// ─── MODULE 1: INSIGHTS ──────────────────────────────────────
async function getExecutiveInsights(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const ctx = await ExecutiveContextFactory.build(companyId, filters, reqId, corrId);
  return registry.insightProvider.generate(ctx); // RULE 8: always []
}

// ─── MODULE 2: RANKINGS ──────────────────────────────────────
async function getExecutiveRankings(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const ctx      = await ExecutiveContextFactory.build(companyId, filters, reqId, corrId);
  const start    = Date.now();
  const queryService = require('./financial-query-service');
  const revenueData  = await queryService.getRevenue(companyId, filters);
  const byRevenue    = [...(revenueData.by_project || [])].sort((a,b) => b.total_amount_base - a.total_amount_base);

  const buildRank = (items, metric, label, getValue, fmt) =>
    items.map((p, i) => ({
      meta:                  ctx.buildMeta(Date.now()-start),
      rank:                  i + 1,
      entity_type:           'PROJECT',
      entity_id:             p.project_id,
      entity_name:           `Project #${p.project_id}`,
      metric,                metric_label: label,
      value:                 round2(getValue(p)),
      formatted_value:       fmt(p),
      delta_previous_period: null,
      trend_direction:       null,
      data_quality:          'HIGH',
      company_id:            parseInt(companyId),
      fiscal_period:         ctx.fiscalPeriod
    }));

  const topByRevenue = buildRank(
    byRevenue.slice(0,5), 'REVENUE', 'Revenue',
    p => p.total_amount_base, p => toMXN(p.total_amount_base)
  );

  logger.info('[IntelligenceEngine] getExecutiveRankings', {
    company_id: companyId, request_id: reqId,
    projects_ranked: byRevenue.length, execution_ms: Date.now()-start
  });

  return {
    top_projects_by_revenue:   topByRevenue,
    top_projects_by_margin:    [],
    bottom_projects_by_margin: [],
  };
}

// ─── MODULE 3: ALERTS ────────────────────────────────────────
async function getExecutiveAlerts(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const ctx = await ExecutiveContextFactory.build(companyId, filters, reqId, corrId);
  return registry.alertProvider.generate(ctx); // RULE 8: always []
}

// ─── MODULE 4: TRENDS ────────────────────────────────────────
async function getExecutiveTrends(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const from = filters.fiscal_period_from;
  const to   = filters.fiscal_period_to;
  if (!from || !to) throw new InvalidFiscalPeriod('fiscal_period_from + fiscal_period_to required');

  const ctx      = await ExecutiveContextFactory.build(companyId, filters, reqId, corrId);
  const start    = Date.now();
  const groupBy  = filters.group_by_period || 'month';
  const periodType = groupBy === 'year' ? 'YEAR' : groupBy === 'quarter' ? 'QUARTER' : 'MONTH';
  const periodTrend = await summaryService.getPeriodTrend(companyId, from, to, groupBy);

  const trends = [];
  for (const p of periodTrend) {
    const metrics = [
      { metric:'revenue',            label:'Revenue',           value:p.revenue_base },
      { metric:'operating_expenses', label:'Operating Expenses', value:p.operating_expenses_base },
      { metric:'gross_profit',       label:'Gross Profit',      value:p.gross_profit },
      { metric:'net_cash',           label:'Net Cash',          value:p.net_cash },
    ];
    for (const m of metrics) {
      trends.push({
        meta:               ctx.buildMeta(Date.now()-start),
        metric:             m.metric,   metric_label: m.label,
        period_type:        periodType, period: p.period,
        value:              round2(m.value),
        comparison_value:   null, variance: null, variance_pct: null,
        trend_direction:    m.value > 0 ? 'UP' : m.value < 0 ? 'DOWN' : 'FLAT',
        data_quality:       'MEDIUM',
        company_id:         parseInt(companyId), project_id: null
      });
    }
  }

  logger.info('[IntelligenceEngine] getExecutiveTrends', {
    company_id: companyId, request_id: reqId,
    trend_count: trends.length, execution_ms: Date.now()-start
  });
  return trends; // RULE 8
}

// ─── MODULE 5: RISK ──────────────────────────────────────────
async function getExecutiveRisk(companyId, filters={}, reqId=uuidv4(), corrId=uuidv4()) {
  const ctx = await ExecutiveContextFactory.build(companyId, filters, reqId, corrId);
  return registry.riskStrategy.calculate(ctx); // ADR-023: Strategy Pattern
}

// ─── MODULE 6: PORTFOLIO ─────────────────────────────────────
async function getPortfolioSummary(companyId, filters={}, projectIds=[], reqId=uuidv4(), corrId=uuidv4()) {
  const start = Date.now();
  const ctx   = await ExecutiveContextFactory.build(companyId, filters, reqId, corrId);

  // Collect project IDs from context (no extra Financial Platform call)
  const rawProjects = Object.values(ctx.raw.by_event_type||{})
    .flat().map(r=>r.project_id).filter(Boolean);
  const ids = projectIds.length > 0 ? projectIds : [...new Set(rawProjects)];

  if (ids.length === 0) return []; // RULE 8

  const projectPnLs = await Promise.all(
    ids.map(pid => pnlService.getProjectProfitLoss(companyId, pid, filters).catch(()=>null))
  );

  const portfolio = projectPnLs
    .filter(Boolean)
    .map(pnl => registry.portfolioProvider.buildPortfolioItem(ctx, pnl, pnl.project_id));

  logger.info('[IntelligenceEngine] getPortfolioSummary', {
    company_id: companyId, request_id: reqId,
    project_count: portfolio.length, execution_ms: Date.now()-start
  });
  return portfolio; // RULE 8
}

// ─── AGGREGATE: EXECUTIVE DASHBOARD ─────────────────────────
async function getExecutiveDashboard(companyId, filters={}) {
  const start  = Date.now();
  const reqId  = uuidv4();
  const corrId = uuidv4();

  // CHANGE 11: Financial Platform called ONCE via context
  const ctx = await ExecutiveContextFactory.build(companyId, filters, reqId, corrId);

  // All providers receive same context — zero duplicate Financial Platform calls
  const [insights, alerts, risk, portfolio] = await Promise.all([
    Promise.resolve(registry.insightProvider.generate(ctx)),
    Promise.resolve(registry.alertProvider.generate(ctx)),
    Promise.resolve(registry.riskStrategy.calculate(ctx)),
    getPortfolioSummary(companyId, filters, [], reqId, corrId)
  ]);

  const { pnl, raw } = ctx;
  const eventCount = ctx.eventCount;

  logger.info('[IntelligenceEngine] getExecutiveDashboard', {
    company_id: companyId, request_id: reqId,
    insights: insights.length, alerts: alerts.length,
    execution_ms: Date.now()-start
  });

  return {
    meta:          ctx.buildMeta(Date.now()-start),
    company_id:    ctx.companyId,
    fiscal_period: ctx.fiscalPeriod,

    // CHANGE 7: executive_summary
    executive_summary: {
      revenue:            round2(raw.revenue_base),
      operating_expenses: round2(raw.operating_expenses_base),
      gross_profit:       round2(pnl.gross_profit),
      gross_margin_pct:   pnl.gross_margin_pct,
      operating_income:   round2(pnl.operating_income),
      net_income:         round2(pnl.net_income),
      cash_inflows:       round2(raw.cash_inflows_base),
      cash_outflows:      round2(raw.cash_outflows_base),
      net_cash:           round2(ctx.netCash),
      net_liability:      round2(ctx.netLiability),
      commitments:        round2(raw.commitments_base)
    },
    insights,     // RULE 8
    alerts,       // RULE 8
    rankings: { top_projects_by_revenue:[], top_projects_by_margin:[], bottom_projects_by_margin:[] },
    trends:   [],  // RULE 8
    risk,
    portfolio,    // RULE 8
    dashboard_meta: {
      widget_count:      5,
      event_count:       eventCount,
      data_as_of:        new Date().toISOString(),
      collections_empty: [
        ...(insights.length===0  ? ['insights']  : []),
        ...(alerts.length===0    ? ['alerts']    : []),
        ...(portfolio.length===0 ? ['portfolio'] : []),
      ]
    }
  };
}

module.exports = {
  getExecutiveInsights, getExecutiveRankings, getExecutiveAlerts,
  getExecutiveTrends,   getExecutiveRisk,     getPortfolioSummary,
  getExecutiveDashboard,
  InsufficientFinancialData, InvalidFiscalPeriod, CompanyNotFound
};
