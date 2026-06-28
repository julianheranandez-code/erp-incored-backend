'use strict';

/**
 * Executive Intelligence Provider Layer — Sprint 6.4B.1
 * =======================================================
 * ADR-022: Provider Pattern for Insights + Alerts
 * ADR-023: Strategy Pattern for Risk Engine
 *
 * Each Provider implements a single interface:
 *   { generate(context): DTO[] }
 *
 * Engine orchestrates. Providers generate. No mixing.
 *
 * AI INTEGRATION POINTS (Sprint 6.5):
 *   RuleInsightProvider → AIInsightProvider
 *   RuleAlertProvider   → AIAlertProvider
 *   WeightedRiskStrategy → AIRiskStrategy
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ─── PURE HELPERS (testable, no I/O) ─────────────────────────
const round2 = n => Math.round((parseFloat(n||0)+Number.EPSILON)*100)/100;
const safePct = (n, d) => (!d||d===0) ? null : round2((n/d)*100);
const toMXN = v => (v||0).toLocaleString('es-MX',{style:'currency',currency:'MXN',maximumFractionDigits:0});
const dataQuality = count => count===0?'INSUFFICIENT':count<3?'LOW':count<10?'MEDIUM':'HIGH';

// ─── CONFIGURATION PROVIDER (ADR-024) ────────────────────────
/**
 * ADR-024: ConfigurationProvider abstraction.
 * Current: StaticConfigurationProvider (reads from file).
 * Future:  DatabaseConfigurationProvider (per-company overrides).
 * Engine never reads config directly.
 */
class StaticConfigurationProvider {
  constructor() {
    this._config = require('./executive-intelligence-config');
  }
  get(path) {
    return path.split('.').reduce((obj, key) => obj?.[key], this._config);
  }
  alerts(key)    { return this.get(`alerts.${key}`); }
  riskWeight(dim){ return this.get(`risk.weights.${dim}`); }
  riskLevel(score) {
    const levels = this.get('risk.levels');
    if (score >= levels.HEALTHY) return 'HEALTHY';
    if (score >= levels.LOW)     return 'LOW';
    if (score >= levels.MEDIUM)  return 'MEDIUM';
    if (score >= levels.HIGH)    return 'HIGH';
    return 'CRITICAL';
  }
  portfolioHealth(marginPct) {
    if (marginPct === null) return 'NO_DATA';
    const h = this.get('portfolio.health');
    if (marginPct >= h.EXCELLENT) return 'EXCELLENT';
    if (marginPct >= h.GOOD)      return 'GOOD';
    if (marginPct >= h.WARNING)   return 'WARNING';
    return 'CRITICAL';
  }
  insightPriority(severity, boost=0) {
    const base = this.get(`insights.severity_base_priority.${severity}`) || 50;
    return Math.min(100, Math.max(1, base + boost));
  }
}

// ═══════════════════════════════════════════════════════════════
// INSIGHT PROVIDER (ADR-022)
// ═══════════════════════════════════════════════════════════════

/**
 * Interface: InsightProvider
 * Method:    generate(context) → ExecutiveInsightDTO[]
 */
class RuleInsightProvider {
  constructor(config) { this.config = config; this.name = 'RuleInsightProvider'; }

  generate(ctx) {
    const start = Date.now();
    const insights = [];
    const { raw, pnl, companyId, fiscalPeriod, eventCount } = ctx;
    const dq = dataQuality(eventCount);

    const ins = (code, title, desc, category, severity, value, recommendation, boost=0) => ({
      meta:             ctx.buildMeta(Date.now()-start),
      id:               uuidv4(),
      code,             title,          description: desc,
      category,         severity,
      priority:         this.config.insightPriority(severity, boost),
      value:            round2(value),
      formatted_value:  toMXN(value),
      trend:            null,           trend_direction: null,  trend_pct: null,
      recommendation,   confidence:     1.0,
      data_quality:     dq,             source:         'RULES',
      company_id:       companyId,      project_id:     null,
      fiscal_period:    fiscalPeriod
    });

    // Margin insight
    if (raw.revenue_base > 0) {
      const margin = safePct(pnl.operating_income, raw.revenue_base);
      const minMargin = this.config.alerts('minimum_margin_pct');
      const critMargin = this.config.alerts('critical_margin_pct');
      const sev = margin < critMargin ? 'CRITICAL'
                : margin < minMargin  ? 'HIGH'
                : margin < 25         ? 'MEDIUM' : 'INFO';
      const boost = margin < minMargin ? 15 : 0;
      insights.push(ins('INS_OPERATING_MARGIN',
        `Operating margin at ${margin}%`,
        `Operating income ${toMXN(pnl.operating_income)} on revenue ${toMXN(raw.revenue_base)}.`,
        'MARGIN', sev, pnl.operating_income,
        sev === 'INFO' ? 'Margin is healthy.' : 'Review operating expenses to improve margin.', boost));
    }

    // Cash insight
    const netCash = ctx.netCash;
    if (raw.cash_outflows_base > 0 || raw.cash_inflows_base > 0) {
      const sev = netCash < 0 ? 'HIGH' : 'INFO';
      insights.push(ins('INS_CASH_POSITION',
        netCash < 0 ? `Negative net cash: ${toMXN(netCash)}` : `Positive net cash: ${toMXN(netCash)}`,
        `Inflows ${toMXN(raw.cash_inflows_base)} vs outflows ${toMXN(raw.cash_outflows_base)}.`,
        'CASH_FLOW', sev, netCash,
        netCash < 0 ? 'Accelerate AR collections.' : 'Maintain collection velocity.', netCash<0?20:0));
    }

    // Liability insight
    const netLiab = ctx.netLiability;
    if (raw.gross_liability_base > 0) {
      const paidPct = safePct(raw.reversed_liability_base, raw.gross_liability_base);
      const sev = paidPct < 20 ? 'HIGH' : paidPct < 50 ? 'MEDIUM' : 'LOW';
      insights.push(ins('INS_LIABILITY_OUTSTANDING',
        `${toMXN(netLiab)} in outstanding payables (${paidPct}% paid)`,
        `Gross AP ${toMXN(raw.gross_liability_base)}, ${paidPct}% settled.`,
        'LIABILITY', sev, netLiab,
        'Schedule remaining AP payments to maintain vendor relationships.'));
    }

    // Commitment insight
    if (raw.commitments_base > 0 && raw.revenue_base > 0) {
      const commitPct = safePct(raw.commitments_base, raw.revenue_base);
      const threshold = this.config.alerts('commitment_vs_revenue_pct');
      const sev = commitPct > threshold ? 'HIGH' : 'INFO';
      insights.push(ins('INS_COMMITMENT_RATIO',
        `Commitments at ${commitPct}% of revenue`,
        `${toMXN(raw.commitments_base)} committed vs ${toMXN(raw.revenue_base)} revenue.`,
        'EXPENSE', sev, raw.commitments_base,
        commitPct > threshold ? 'Review IPO approvals before new commitments.' : 'Commitment ratio within range.'));
    }

    const result = insights.sort((a,b) => b.priority - a.priority);
    logger.info(`[${this.name}] generated`, {
      count: result.length, execution_ms: Date.now()-start,
      company_id: companyId, request_id: ctx.requestId
    });
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════
// ALERT PROVIDER (ADR-022)
// ═══════════════════════════════════════════════════════════════

class RuleAlertProvider {
  constructor(config) { this.config = config; this.name = 'RuleAlertProvider'; }

  generate(ctx) {
    const start = Date.now();
    const { raw, pnl, companyId, fiscalPeriod, eventCount } = ctx;
    const dq = dataQuality(eventCount);
    const alerts = [];

    const alert = (code, type, severity, title, desc, recommendation, threshold, currentValue) => ({
      meta:             ctx.buildMeta(Date.now()-start),
      id:               uuidv4(),
      code,             type,           severity,
      title,            description:    desc,
      recommendation,   threshold,      current_value: currentValue,
      data_quality:     dq,
      status:           'OPEN',
      acknowledged:     false,
      company_id:       companyId,      project_id:         null,
      affected_entities: [],            // RULE 8
      created_at:       new Date().toISOString(),
      expires_at:       null,
      history:          []              // RULE 8
    });

    // Negative cash
    const netCash = ctx.netCash;
    if (netCash < this.config.alerts('negative_cash_threshold')) {
      alerts.push(alert('ALERT_NEGATIVE_CASH','TREASURY','HIGH',
        `Net cash is negative: ${toMXN(netCash)}`,
        `Outflows (${toMXN(raw.cash_outflows_base)}) exceed inflows (${toMXN(raw.cash_inflows_base)}).`,
        'Prioritize AR collections and defer non-essential outflows.',
        this.config.alerts('negative_cash_threshold'), netCash));
    }

    // Low margin
    if (raw.revenue_base > 0) {
      const margin = safePct(pnl.operating_income, raw.revenue_base);
      const minMargin = this.config.alerts('minimum_margin_pct');
      const critMargin = this.config.alerts('critical_margin_pct');
      if (margin !== null && margin < minMargin) {
        alerts.push(alert('ALERT_LOW_MARGIN','FINANCIAL',
          margin < critMargin ? 'CRITICAL' : 'HIGH',
          `Operating margin below threshold: ${margin}%`,
          `Current margin ${margin}% is below minimum ${minMargin}%.`,
          'Review operating expense breakdown.',
          minMargin, margin));
      }
    }

    // High commitments
    if (raw.revenue_base > 0 && raw.commitments_base > 0) {
      const ratio = safePct(raw.commitments_base, raw.revenue_base);
      const threshold = this.config.alerts('commitment_vs_revenue_pct');
      if (ratio > threshold) {
        alerts.push(alert('ALERT_HIGH_COMMITMENTS','FINANCIAL','MEDIUM',
          `Commitments at ${ratio}% of revenue`,
          `${toMXN(raw.commitments_base)} committed against ${toMXN(raw.revenue_base)} revenue.`,
          'Review pending IPOs before approving new commitments.',
          threshold, ratio));
      }
    }

    logger.info(`[${this.name}] generated`, {
      count: alerts.length, execution_ms: Date.now()-start,
      company_id: companyId, request_id: ctx.requestId
    });
    return alerts; // RULE 8
  }
}

// ═══════════════════════════════════════════════════════════════
// RISK STRATEGY (ADR-023)
// ═══════════════════════════════════════════════════════════════

function scoreFromPct(pct, goodThreshold, badThreshold) {
  if (pct === null) return 50;
  if (pct >= goodThreshold) return 90;
  if (pct <= badThreshold)  return 10;
  return Math.round(10 + ((pct - badThreshold) / (goodThreshold - badThreshold)) * 80);
}

/**
 * Interface: RiskStrategy
 * Method:    calculate(context) → ExecutiveRiskDTO
 * ADR-023: Strategy Pattern — Engine selects strategy, never hardcodes.
 */
class WeightedRiskStrategy {
  constructor(config) { this.config = config; this.name = 'WeightedRiskStrategy'; }

  calculate(ctx) {
    const start = Date.now();
    const { raw, pnl, companyId, fiscalPeriod } = ctx;
    const marginPct   = safePct(pnl.operating_income, raw.revenue_base) || 0;
    const paidLiabPct = safePct(raw.reversed_liability_base, raw.gross_liability_base) || 100;
    const commitRatio = safePct(raw.commitments_base, raw.revenue_base) || 0;
    const netCash     = ctx.netCash;

    const dimensions = [
      {
        category:   'CASH_FLOW',
        weight:     this.config.riskWeight('CASH_FLOW'),
        score:      netCash >= 0 ? 80 : Math.max(10, 80 + (netCash / Math.max(1, raw.cash_outflows_base)) * 70),
        signal:     `Net cash: ${toMXN(netCash)}`,
        recommendation: netCash < 0 ? 'Accelerate AR collections.' : 'Maintain cash discipline.',
        data_point: netCash, data_quality: 'HIGH'
      },
      {
        category:   'MARGIN',
        weight:     this.config.riskWeight('MARGIN'),
        score:      scoreFromPct(marginPct, 25, this.config.alerts('critical_margin_pct')),
        signal:     `Operating margin: ${marginPct}%`,
        recommendation: marginPct < this.config.alerts('minimum_margin_pct')
          ? 'Margin below target — review cost structure.' : 'Target 25%+ for EXCELLENT.',
        data_point: marginPct, data_quality: 'HIGH'
      },
      {
        category:   'LIABILITY',
        weight:     this.config.riskWeight('LIABILITY'),
        score:      scoreFromPct(paidLiabPct, 80, 20),
        signal:     `${round2(paidLiabPct)}% of liabilities paid.`,
        recommendation: paidLiabPct < 50 ? 'Schedule payments before due dates.' : 'Liability management on track.',
        data_point: ctx.netLiability, data_quality: 'HIGH'
      },
      {
        category:   'CONCENTRATION',
        weight:     this.config.riskWeight('CONCENTRATION'),
        score:      70,
        signal:     'Concentration analysis pending client breakdown.',
        recommendation: 'Diversify revenue across more clients.',
        data_point: null, data_quality: 'MEDIUM'
      },
      {
        category:   'COMMITMENT',
        weight:     this.config.riskWeight('COMMITMENT'),
        score:      scoreFromPct(100 - commitRatio, 30, 0),
        signal:     `Commitments at ${round2(commitRatio)}% of revenue.`,
        recommendation: commitRatio > this.config.alerts('commitment_vs_revenue_pct')
          ? 'Commitment ratio exceeds threshold.' : 'Commitment ratio within safe range.',
        data_point: commitRatio, data_quality: 'HIGH'
      }
    ];

    const compositeScore = Math.round(
      dimensions.reduce((sum, d) => sum + (d.score * d.weight), 0)
    );

    logger.info(`[${this.name}] calculated`, {
      risk_score: compositeScore, execution_ms: Date.now()-start,
      company_id: companyId, request_id: ctx.requestId
    });

    return {
      meta:         ctx.buildMeta(Date.now()-start),
      score:        compositeScore,
      risk_level:   this.config.riskLevel(compositeScore),
      dimensions,   // RULE 8
      company_id:   companyId,
      fiscal_period: fiscalPeriod,
      ai_enhanced:  false
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// PORTFOLIO HEALTH PROVIDER (CHANGE 5)
// ═══════════════════════════════════════════════════════════════

class PortfolioHealthProvider {
  constructor(config) { this.config = config; this.name = 'PortfolioHealthProvider'; }

  computeHealth(marginPct, revenue) {
    if (revenue === 0 || marginPct === null) return { health: 'NO_DATA', health_score: 0 };
    const health = this.config.portfolioHealth(marginPct);
    const scoreMap = { EXCELLENT:90, GOOD:70, WARNING:40, CRITICAL:15, NO_DATA:0 };
    return { health, health_score: scoreMap[health] || 0 };
  }

  computeRiskLevel(health) {
    return { EXCELLENT:'HEALTHY', GOOD:'LOW', WARNING:'MEDIUM', CRITICAL:'CRITICAL', NO_DATA:'MEDIUM' }[health] || 'MEDIUM';
  }

  buildPortfolioItem(ctx, pnl, projectId) {
    const marginPct = safePct(pnl.gross_profit, pnl.revenue);
    const { health, health_score } = this.computeHealth(marginPct, pnl.revenue);
    const riskLevel = this.computeRiskLevel(health);
    const dq = pnl.revenue > 0 ? 'HIGH' : 'INSUFFICIENT';

    return {
      meta:          ctx.buildMeta(0),
      project_id:    projectId,
      project_name:  `Project #${projectId}`,
      company_id:    ctx.companyId,
      status:        'active',
      fiscal_period: ctx.fiscalPeriod,
      revenue:       round2(pnl.revenue),
      expenses:      round2(pnl.operating_expenses),
      gross_profit:  round2(pnl.gross_profit),
      margin_pct:    marginPct,
      liabilities:   round2(pnl.raw_totals?.gross_liability_base || 0),
      commitments:   round2(pnl.raw_totals?.commitments_base     || 0),
      cash_inflows:  round2(pnl.raw_totals?.cash_inflows_base    || 0),
      cash_outflows: round2(pnl.raw_totals?.cash_outflows_base   || 0),
      health_score,  health,
      health_trend:  'FLAT',  // Sprint 6.5: prior period comparison
      risk_level:    riskLevel,
      revenue_trend: 'FLAT',
      data_quality:  dq
    };
  }
}

module.exports = {
  StaticConfigurationProvider,
  RuleInsightProvider,
  RuleAlertProvider,
  WeightedRiskStrategy,
  PortfolioHealthProvider
};
