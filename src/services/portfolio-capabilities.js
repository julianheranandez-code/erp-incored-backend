'use strict';

/**
 * Portfolio Capabilities v2 — Sprint P3.2A
 * ==========================================
 * All capabilities now receive CapabilityContext (ADR-041)
 * and return CapabilityResult (ADR-042).
 *
 * ADR-043: Allocation Provider Pattern
 * ADR-044: Recommendation Provider Registry
 * ADR-045: Comparison Strategy Pattern
 */

const { v4: uuidv4 } = require('uuid');
const { CapabilityResult, CapabilityContextFactory, buildRecommendationDTO }
  = require('./portfolio-capability-context');
const logger = require('../utils/logger');

const round2 = n => Math.round((parseFloat(n||0)+Number.EPSILON)*100)/100;
const safePct = (n,d) => (!d||d===0)?null:round2((n/d)*100);
const toMXN = v => (v||0).toLocaleString('es-MX',{style:'currency',currency:'MXN',maximumFractionDigits:0});
const dataQuality = cnt => cnt===0?'INSUFFICIENT':cnt<3?'LOW':cnt<10?'MEDIUM':'HIGH';

function healthLevel(m,rev){
  if(rev===0||m===null)return'NO_DATA';
  if(m>=30)return'EXCELLENT';if(m>=15)return'GOOD';if(m>=0)return'WARNING';return'CRITICAL';
}
function healthScore(l){return{EXCELLENT:90,GOOD:70,WARNING:40,CRITICAL:15,NO_DATA:0}[l]||0;}
function executivePriority(l,rs){
  if(l==='CRITICAL')return'CRITICAL';
  if(l==='WARNING'||rs<40)return'HIGH';
  if(l==='GOOD')return'MEDIUM';
  if(l==='EXCELLENT')return'MONITOR';
  return'LOW';
}

function buildProjectDTO(ctx, projectId, pnl) {
  if (!pnl) return null;
  const m = safePct(pnl.gross_profit, pnl.revenue);
  const l = healthLevel(m, pnl.revenue);
  const rs = ctx.portfolio.executiveRisk?.score ?? 50;
  return {
    meta: ctx.portfolio.buildMeta(0), project_id: projectId,
    project_code: `PRJ-${projectId}`, project_name: `Project #${projectId}`,
    company_id: ctx.companyId, client_id: null, status: 'ACTIVE',
    fiscal_period: ctx.fiscalPeriod,
    revenue: round2(pnl.revenue), operating_expenses: round2(pnl.operating_expenses),
    gross_profit: round2(pnl.gross_profit), operating_income: round2(pnl.gross_profit),
    margin_pct: m, liabilities: round2(pnl.raw_totals?.gross_liability_base||0),
    commitments: round2(pnl.raw_totals?.commitments_base||0),
    cash_position: round2((pnl.raw_totals?.cash_inflows_base||0)-(pnl.raw_totals?.cash_outflows_base||0)),
    health_score: healthScore(l), health_level: l, health_trend: 'FLAT',
    executive_priority: executivePriority(l, rs), risk_score: rs,
    data_quality: pnl.revenue>0?'HIGH':'INSUFFICIENT',
    metadata: { event_count:5, last_event_at:null, tags:null, region:null, technology:null }
  };
}

// ─── ALLOCATION PROVIDERS (ADR-043) ──────────────────────────
const AllocationProviders = {
  BY_STATUS: {
    execute(projects) {
      return projects.map(p => ({ key: p.status, value: p.revenue, projectId: p.project_id }));
    }
  },
  BY_PROJECT_TYPE: {
    execute(projects) {
      return projects.map(p => ({ key: 'TELECOM', value: p.revenue, projectId: p.project_id })); // Sprint P3.4: real taxonomy
    }
  },
  BY_BUSINESS_UNIT: {
    execute(projects) {
      return projects.map(p => ({ key: 'UNASSIGNED', value: p.revenue, projectId: p.project_id })); // reserved ADR-033
    }
  }
};

function buildAllocationFromSlices(ctx, type, metric, sliceData) {
  const groups = {};
  for (const { key, value } of sliceData) {
    if (!groups[key]) groups[key] = { value:0, count:0 };
    groups[key].value += value; groups[key].count++;
  }
  const total = Object.values(groups).reduce((a,g)=>a+g.value,0);
  return {
    meta: ctx.portfolio.buildMeta(0), company_id: ctx.companyId,
    fiscal_period: ctx.fiscalPeriod, allocation_type: type, metric,
    total: round2(total),
    slices: Object.entries(groups).sort(([,a],[,b])=>b.value-a.value).map(([label,g])=>({
      label, entity_id: null, value: round2(g.value),
      percentage: safePct(g.value,total)||0, project_count: g.count, trend_direction: null
    })),
    data_quality: dataQuality(ctx.portfolio.totalEventCount)
  };
}

// ─── COMPARISON STRATEGIES (ADR-045) ─────────────────────────
class BasicComparisonStrategy {
  constructor() { this.name = 'BasicComparisonStrategy'; }
  execute(projects) {
    if (projects.length < 2) return { comparisons:[], revenue_concentration_top:0, top_revenue_project_id:null, average_margin:0, margin_spread:0 };
    const margins  = projects.map(p=>p.margin_pct||0);
    const avgM     = margins.reduce((a,b)=>a+b,0)/margins.length;
    const totalRev = projects.reduce((a,p)=>a+p.revenue,0);
    const top      = [...projects].sort((a,b)=>b.revenue-a.revenue)[0];
    return {
      comparisons: projects.map(p=>({
        project_id: p.project_id,
        margin_vs_portfolio: safePct((p.margin_pct||0)-avgM, Math.abs(avgM)||1),
        revenue_concentration: safePct(p.revenue,totalRev),
        cash_vs_portfolio: round2(p.cash_position-(projects.reduce((a,x)=>a+x.cash_position,0)/projects.length)),
        outperforms_margin: (p.margin_pct||0)>avgM
      })),
      revenue_concentration_top: safePct(top?.revenue||0,totalRev),
      top_revenue_project_id:    top?.project_id||null,
      average_margin:            round2(avgM),
      margin_spread:             round2(Math.max(...margins)-Math.min(...margins))
    };
  }
}
// Reserved: BenchmarkComparisonStrategy, AIComparisonStrategy

// ─── RECOMMENDATION PROVIDER REGISTRY (ADR-044) ──────────────
class RuleRecommendationProvider {
  constructor() { this.name = 'RuleRecommendationProvider'; this.source = 'RULES'; }
  generate(projects, comparison) {
    const recs = [];
    if ((comparison.revenue_concentration_top||0) > 70)
      recs.push(buildRecommendationDTO({
        category:'RISK', priority:85, severity:'HIGH',
        title:'Revenue concentration risk',
        description:`Top project holds ${comparison.revenue_concentration_top}% of portfolio revenue.`,
        action:'Develop 2 new project opportunities in Q3.',
        impact:'Reduce concentration below 50% within 6 months.',
        confidence:1.0, source:'RULES'
      }));
    const neg = projects.filter(p=>p.cash_position<0);
    if (neg.length) recs.push(buildRecommendationDTO({
      category:'CASH', priority:80, severity:'HIGH',
      title:`${neg.length} project(s) with negative cash`,
      description:`Projects ${neg.map(p=>p.project_id).join(',')} have negative cash position.`,
      action:'Accelerate AR collections on affected projects.',
      impact:'Improve net cash position by end of quarter.',
      confidence:1.0, source:'RULES'
    }));
    const low = projects.filter(p=>p.margin_pct!==null&&p.margin_pct<15);
    if (low.length) recs.push(buildRecommendationDTO({
      category:'MARGIN', priority:70, severity:'MEDIUM',
      title:`${low.length} project(s) below 15% margin`,
      description:`Projects need cost review: ${low.map(p=>p.project_id).join(',')}.`,
      action:'Review operating expenses for affected projects.',
      impact:'Target 20%+ margin within 2 months.',
      confidence:1.0, source:'RULES'
    }));
    return recs;
  }
}

const RecommendationProviderRegistry = Object.freeze({
  default: new RuleRecommendationProvider(),
  // future: forecast: new ForecastRecommendationProvider(),
  // future: ai: new AIRecommendationProvider()
});

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 1 — Aggregation
// ═══════════════════════════════════════════════════════════════
class PortfolioAggregationCapability {
  constructor() { this.name='PortfolioAggregationCapability'; this.health='HEALTHY'; }

  execute(capCtx) {
    const metrics = capCtx.createMetrics(this.name);
    const ctx     = capCtx.portfolio;

    const projects = ctx.projectIds
      .map(id => buildProjectDTO(capCtx, id, ctx.getProjectPnL(id)))
      .filter(Boolean);

    const totalRevenue   = projects.reduce((a,p)=>a+p.revenue,0);
    const totalOpEx      = projects.reduce((a,p)=>a+p.operating_expenses,0);
    const totalGP        = projects.reduce((a,p)=>a+p.gross_profit,0);
    const totalLiab      = projects.reduce((a,p)=>a+p.liabilities,0);
    const totalCommit    = projects.reduce((a,p)=>a+p.commitments,0);
    const totalCash      = projects.reduce((a,p)=>a+p.cash_position,0);
    const avgMargin      = safePct(totalGP,totalRevenue);
    const margins        = projects.map(p=>p.margin_pct).filter(m=>m!==null);
    const dist           = {EXCELLENT:0,GOOD:0,WARNING:0,CRITICAL:0,NO_DATA:0};
    projects.forEach(p=>{ if(dist[p.health_level]!==undefined)dist[p.health_level]++; });

    function portfolioHealth(ps) {
      if(!ps.length) return 'NO_DATA';
      const t=ps.length,c=ps.filter(x=>x.health_level==='CRITICAL').length,w=ps.filter(x=>x.health_level==='WARNING').length,g=ps.filter(x=>['GOOD','EXCELLENT'].includes(x.health_level)).length;
      if(c/t>0.3)return'CRITICAL';if(w/t>0.4)return'WARNING';if(g/t>0.8)return'EXCELLENT';if(g/t>0.6)return'GOOD';return'WARNING';
    }

    const summary = {
      meta: ctx.buildMeta(metrics.execution_ms), company_id: ctx.companyId,
      fiscal_period: ctx.fiscalPeriod, total_projects: projects.length,
      active_projects: projects.filter(p=>p.status==='ACTIVE').length,
      completed_projects:0,
      projects_at_risk: projects.filter(p=>['WARNING','CRITICAL'].includes(p.health_level)).length,
      projects_needing_attention: projects.filter(p=>['CRITICAL','HIGH'].includes(p.executive_priority)).length,
      total_revenue: round2(totalRevenue), total_operating_expenses: round2(totalOpEx),
      total_gross_profit: round2(totalGP), total_operating_income: round2(totalGP),
      total_cash_position: round2(totalCash), total_liabilities: round2(totalLiab),
      total_commitments: round2(totalCommit), average_margin: avgMargin,
      best_margin: margins.length?Math.max(...margins):null,
      worst_margin: margins.length?Math.min(...margins):null,
      portfolio_health: portfolioHealth(projects), portfolio_health_trend:'FLAT',
      portfolio_risk: ctx.executiveRisk?.risk_level||'MEDIUM',
      health_distribution: dist,
      executive_summary: `Portfolio of ${projects.length} projects at ${avgMargin??0}% avg margin.`,
      data_quality: dataQuality(ctx.totalEventCount)
    };

    metrics.finish(projects.length);
    logger.info(`[${this.name}]`, { records: projects.length,
      execution_ms: metrics.execution_ms, request_id: capCtx.requestId });
    return new CapabilityResult({ summary, projects }, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 2 — Ranking
// ═══════════════════════════════════════════════════════════════
class PortfolioRankingCapability {
  constructor() { this.name='PortfolioRankingCapability'; this.health='HEALTHY'; }
  execute(capCtx, projects) {
    const metrics = capCtx.createMetrics(this.name);
    const rank = (sorted,metric,label,getValue,fmt) =>
      sorted.map((p,i)=>({ meta:capCtx.portfolio.buildMeta(0), rank:i+1, metric, metric_label:label,
        project:p, value:round2(getValue(p)), formatted_value:fmt(p),
        delta_prior_period:null, trend_direction:null, data_quality:p.data_quality }));

    const byRevD = [...projects].sort((a,b)=>b.revenue-a.revenue);
    const byMD   = [...projects].filter(p=>p.margin_pct!==null).sort((a,b)=>b.margin_pct-a.margin_pct);
    const result = {
      top_by_revenue:           rank(byRevD.slice(0,5),'REVENUE','Revenue',p=>p.revenue,p=>toMXN(p.revenue)),
      top_by_margin:            rank(byMD.slice(0,5),'MARGIN_PCT','Margin %',p=>p.margin_pct,p=>`${p.margin_pct}%`),
      bottom_by_margin:         rank([...byMD].reverse().slice(0,5),'MARGIN_PCT','Margin %',p=>p.margin_pct,p=>`${p.margin_pct}%`),
      highest_cash_consumption: rank([...projects].sort((a,b)=>a.cash_position-b.cash_position).slice(0,5),'CASH_CONSUMPTION','Net Cash',p=>p.cash_position,p=>toMXN(p.cash_position)),
      highest_liability:        rank([...projects].sort((a,b)=>b.liabilities-a.liabilities).slice(0,5),'LIABILITY','Liabilities',p=>p.liabilities,p=>toMXN(p.liabilities)),
      highest_commitment:       rank([...projects].sort((a,b)=>b.commitments-a.commitments).slice(0,5),'COMMITMENT','Commitments',p=>p.commitments,p=>toMXN(p.commitments)),
    };
    metrics.finish(projects.length);
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 3 — Allocation (ADR-043: Provider Pattern)
// ═══════════════════════════════════════════════════════════════
class PortfolioAllocationCapability {
  constructor() { this.name='PortfolioAllocationCapability'; this.health='HEALTHY'; }
  execute(capCtx, projects) {
    const metrics = capCtx.createMetrics(this.name);
    const allocations = Object.entries(AllocationProviders).map(([type, provider]) => {
      const sliceData = provider.execute(projects);
      return buildAllocationFromSlices(capCtx, type, 'revenue', sliceData);
    });
    metrics.finish(allocations.length);
    return new CapabilityResult(allocations, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 4 — Health
// ═══════════════════════════════════════════════════════════════
class PortfolioHealthCapability {
  constructor() { this.name='PortfolioHealthCapability'; this.health='HEALTHY'; }
  execute(capCtx, projects) {
    const metrics = capCtx.createMetrics(this.name);
    const result = {
      critical_projects: projects.filter(p=>p.health_level==='CRITICAL'),
      warning_projects:  projects.filter(p=>p.health_level==='WARNING')
    };
    metrics.finish(projects.length);
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 5 — Comparison (ADR-045: Strategy Pattern)
// ═══════════════════════════════════════════════════════════════
class PortfolioComparisonCapability {
  constructor(strategy = new BasicComparisonStrategy()) {
    this.name='PortfolioComparisonCapability'; this.strategy=strategy; this.health='HEALTHY';
  }
  execute(capCtx, projects) {
    const metrics = capCtx.createMetrics(this.name);
    const result  = this.strategy.execute(projects);
    metrics.finish(result.comparisons?.length||0);
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 6 — Recommendation (ADR-044: Provider Registry)
// ═══════════════════════════════════════════════════════════════
class RuleRecommendationCapability {
  constructor() { this.name='RuleRecommendationCapability'; this.health='HEALTHY'; }
  execute(capCtx, projects, comparison) {
    const metrics  = capCtx.createMetrics(this.name);
    const provider = RecommendationProviderRegistry.default;
    const result   = provider.generate(projects, comparison);
    metrics.finish(result.length);
    logger.info(`[${this.name}]`, { recommendations:result.length, request_id:capCtx.requestId });
    return new CapabilityResult(result, metrics);
  }
}

module.exports = {
  PortfolioAggregationCapability,
  PortfolioRankingCapability,
  PortfolioAllocationCapability,
  PortfolioHealthCapability,
  PortfolioComparisonCapability,
  RuleRecommendationCapability,
  BasicComparisonStrategy,
  RecommendationProviderRegistry
};
