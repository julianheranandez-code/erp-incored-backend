'use strict';
/**
 * Treasury Capabilities — Sprint P4.1B
 * 10 self-contained capabilities. execute(capCtx) → CapabilityResult.
 * Never communicate with each other directly — pipeline enriches context.
 */
const { v4: uuidv4 } = require('uuid');
const { CapabilityResult } = require('./treasury-capability-context');
const config = require('./treasury-configuration-provider');
const logger = require('../utils/logger');

const round2 = n => Math.round((parseFloat(n||0)+Number.EPSILON)*100)/100;
const safePct = (n,d) => (!d||d===0)?null:round2((n/d)*100);
const toMXN = v => (v||0).toLocaleString('es-MX',{style:'currency',currency:'MXN',maximumFractionDigits:0});
const dataQuality = cnt => cnt===0?'INSUFFICIENT':cnt<3?'LOW':cnt<10?'MEDIUM':'HIGH';

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 1 — Cash Position
// ═══════════════════════════════════════════════════════════════
class CashPositionCapability {
  constructor(){ this.name='CashPositionCapability'; this.health='HEALTHY'; }
  execute(capCtx) {
    const metrics = capCtx.createMetrics(this.name);
    const raw = capCtx.financialFacts();
    const t   = capCtx.treasury;

    const result = {
      meta: capCtx.buildMeta(0), company_id: capCtx.companyId, fiscal_period: capCtx.fiscalPeriod,
      current_cash:      round2(t.netCash),
      available_cash:    round2(t.netCash), // restricted=0 until bank_accounts migrated
      restricted_cash:   0,
      net_cash:          round2(t.netCash - t.netLiability),
      intercompany_cash: 0,
      currency_breakdown: [
        { currency:'MXN', amount: round2(t.netCash), amount_base: round2(t.netCash),
          percentage: 100, account_count: capCtx.bankAccounts().length }
      ],
      data_quality: dataQuality(t.totalEventCount)
    };
    metrics.finish(1);
    logger.info(`[${this.name}]`, { execution_ms:metrics.execution_ms, request_id:capCtx.requestId });
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 2 — Liquidity
// ═══════════════════════════════════════════════════════════════
class LiquidityCapability {
  constructor(){ this.name='LiquidityCapability'; this.health='HEALTHY'; }
  execute(capCtx) {
    const metrics = capCtx.createMetrics(this.name);
    const t = capCtx.treasury;
    const raw = capCtx.financialFacts();

    const currentAssets = t.netCash;
    const currentLiabilities = t.netLiability || 1; // avoid div/0
    const ratio = round2(currentAssets / currentLiabilities);
    const workingCapital = round2(currentAssets - t.netLiability);
    const operatingCash = round2(raw.cash_inflows_base - raw.cash_outflows_base);

    // Burn rate: negative cash flow per month (simplified, single-period)
    const burnRate = operatingCash < 0 ? round2(Math.abs(operatingCash)) : null;
    const runwayDays = burnRate && burnRate > 0
      ? Math.floor((currentAssets > 0 ? currentAssets : 0) / (burnRate/30)) : null;

    const score = Math.max(0, Math.min(100, Math.round(50 + ratio*25)));

    const result = {
      meta: capCtx.buildMeta(0), company_id: capCtx.companyId, fiscal_period: capCtx.fiscalPeriod,
      liquidity_score: score,
      liquidity_ratio: ratio,
      working_capital: workingCapital,
      operating_cash:  operatingCash,
      burn_rate:       burnRate,
      runway_days:     runwayDays,
      health: config.liquidityHealth(ratio),
      trend:  operatingCash >= 0 ? 'UP' : 'DOWN',
      data_quality: dataQuality(t.totalEventCount)
    };
    metrics.finish(1);
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 3 — Forecast (Provider Pattern — ADR-109)
// ═══════════════════════════════════════════════════════════════
class RuleForecastProvider {
  constructor(){ this.name='RuleForecastProvider'; }
  project(t, horizonDays) {
    // Simple linear projection from current period net cash (rule-based v1.0)
    const dailyNet = t.netCash / 30; // assume 30-day fiscal period
    const expectedNet = round2(dailyNet * horizonDays);
    return {
      expected_inflows:  round2(Math.max(0, dailyNet) * horizonDays),
      expected_outflows: round2(Math.max(0, -dailyNet) * horizonDays),
      net_cash_forecast: expectedNet,
      confidence: config.get('forecast.default_confidence')
    };
  }
}
class ForecastCapability {
  constructor(provider = new RuleForecastProvider()) {
    this.name='ForecastCapability'; this.provider=provider; this.health='HEALTHY';
  }
  execute(capCtx) {
    const metrics = capCtx.createMetrics(this.name);
    const t = capCtx.treasury;
    const horizonDays = config.get('forecast.horizon_days.DAYS_30');
    const proj = this.provider.project(t, horizonDays);

    const result = {
      meta: capCtx.buildMeta(0), company_id: capCtx.companyId,
      horizon: 'DAYS_30', scenario: 'BASE',
      as_of_date: new Date().toISOString().slice(0,10),
      expected_inflows:   proj.expected_inflows,
      expected_outflows:  proj.expected_outflows,
      net_cash_forecast:  proj.net_cash_forecast,
      ending_cash_balance: round2(t.netCash + proj.net_cash_forecast),
      confidence: proj.confidence,
      data_quality: dataQuality(t.totalEventCount),
      is_projection: true
    };
    metrics.finish(1);
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 4 — Payment Calendar
// ═══════════════════════════════════════════════════════════════
class PaymentCalendarCapability {
  constructor(){ this.name='PaymentCalendarCapability'; this.health='HEALTHY'; }
  execute(capCtx) {
    const metrics = capCtx.createMetrics(this.name);
    const t = capCtx.treasury;
    const raw = capCtx.financialFacts();

    // Derived from net liability (AP bills) — actual payment schedule requires AP table detail (future)
    const totalOutstanding = t.netLiability;
    const upcoming = totalOutstanding > 0 ? [{
      id: 1, vendor_name: 'Outstanding Liabilities (aggregate)',
      amount: round2(totalOutstanding), due_date: new Date().toISOString().slice(0,10),
      priority: totalOutstanding > config.get('payments.priority_amount_threshold') ? 'HIGH' : 'MEDIUM',
      method: 'WIRE', status: 'SCHEDULED', cash_impact: -round2(totalOutstanding)
    }] : [];

    const result = {
      meta: capCtx.buildMeta(0), company_id: capCtx.companyId, fiscal_period: capCtx.fiscalPeriod,
      upcoming_payments: upcoming, overdue_payments: [], scheduled_payments: upcoming,
      total_upcoming: round2(totalOutstanding), total_overdue: 0,
      data_quality: dataQuality(t.totalEventCount)
    };
    metrics.finish(upcoming.length);
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 5 — Collection Calendar
// ═══════════════════════════════════════════════════════════════
class CollectionCalendarCapability {
  constructor(){ this.name='CollectionCalendarCapability'; this.health='HEALTHY'; }
  execute(capCtx) {
    const metrics = capCtx.createMetrics(this.name);
    const t = capCtx.treasury;
    const raw = capCtx.financialFacts();

    const expectedRevenue = raw.revenue_base || 0;
    const collected = raw.cash_inflows_base || 0;
    const pendingAR = round2(Math.max(0, expectedRevenue - collected));

    const expected = pendingAR > 0 ? [{
      id: 1, customer_name: 'Outstanding Receivables (aggregate)',
      amount: pendingAR, due_date: new Date().toISOString().slice(0,10),
      collection_probability: config.get('collections.default_probability'),
      customer_priority: 'MEDIUM',
      expected_cash: round2(pendingAR * config.get('collections.default_probability'))
    }] : [];

    const result = {
      meta: capCtx.buildMeta(0), company_id: capCtx.companyId, fiscal_period: capCtx.fiscalPeriod,
      expected_collections: expected, overdue_receivables: [],
      total_expected: pendingAR, total_overdue: 0,
      data_quality: dataQuality(t.totalEventCount)
    };
    metrics.finish(expected.length);
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 6 — FX Exposure
// ═══════════════════════════════════════════════════════════════
class FXExposureCapability {
  constructor(){ this.name='FXExposureCapability'; this.health='HEALTHY'; }
  execute(capCtx) {
    const metrics = capCtx.createMetrics(this.name);
    const t = capCtx.treasury;
    // Single-currency (MXN) until multi-currency bank accounts are migrated
    const result = {
      meta: capCtx.buildMeta(0), company_id: capCtx.companyId, fiscal_period: capCtx.fiscalPeriod,
      base_currency: 'MXN', total_exposure_base: 0,
      lines: [], // RULE 1 — empty until FX accounts exist
      data_quality: 'INSUFFICIENT'
    };
    metrics.finish(0);
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 7 — Working Capital
// ═══════════════════════════════════════════════════════════════
class WorkingCapitalCapability {
  constructor(){ this.name='WorkingCapitalCapability'; this.health='HEALTHY'; }
  execute(capCtx) {
    const metrics = capCtx.createMetrics(this.name);
    const t = capCtx.treasury;
    const raw = capCtx.financialFacts();

    const ar = round2(Math.max(0, (raw.revenue_base||0) - (raw.cash_inflows_base||0)));
    const ap = round2(t.netLiability);
    const cash = round2(t.netCash);
    const inventory = 0; // reserved
    const workingCapital = round2(ar + inventory + cash - ap);

    const result = {
      meta: capCtx.buildMeta(0), company_id: capCtx.companyId, fiscal_period: capCtx.fiscalPeriod,
      accounts_receivable: ar, accounts_payable: ap, inventory, cash,
      working_capital: workingCapital,
      cash_conversion_cycle: null, // requires historical AR/AP turnover data
      data_quality: dataQuality(t.totalEventCount)
    };
    metrics.finish(1);
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 8 — Treasury Risk
// ═══════════════════════════════════════════════════════════════
class TreasuryRiskCapability {
  constructor(){ this.name='TreasuryRiskCapability'; this.health='HEALTHY'; }
  execute(capCtx) {
    const metrics = capCtx.createMetrics(this.name);
    const t = capCtx.treasury;
    const liq = capCtx.liquidity();
    const execRisk = capCtx.executiveRisk();

    const liqScore = liq?.liquidity_score ?? 50;

    const drivers = [
      { dimension:'LIQUIDITY', weight:config.riskWeight('LIQUIDITY'), score: liqScore,
        signal:`Liquidity ratio: ${liq?.liquidity_ratio??'N/A'}`,
        recommendation: liqScore<50?'Improve liquidity position.':'Liquidity adequate.',
        affected_entities:[], data_quality:'HIGH' },
      { dimension:'CONCENTRATION_BANK', weight:config.riskWeight('CONCENTRATION_BANK'), score:70,
        signal:'Bank concentration analysis pending account data.',
        recommendation:'Diversify across multiple banking relationships.',
        affected_entities:[], data_quality:'MEDIUM' },
      { dimension:'CONCENTRATION_CUSTOMER', weight:config.riskWeight('CONCENTRATION_CUSTOMER'), score:70,
        signal:'Customer concentration analysis pending CRM data.',
        recommendation:'Diversify customer base.', affected_entities:[], data_quality:'MEDIUM' },
      { dimension:'FX_EXPOSURE', weight:config.riskWeight('FX_EXPOSURE'), score:90,
        signal:'Minimal FX exposure (single-currency operations).',
        recommendation:'Monitor as international operations grow.',
        affected_entities:[], data_quality:'HIGH' },
      { dimension:'COUNTERPARTY', weight:config.riskWeight('COUNTERPARTY'), score:75,
        signal:'Counterparty risk within normal range.',
        recommendation:'Continue standard due diligence.', affected_entities:[], data_quality:'MEDIUM' }
    ];

    const compositeScore = Math.round(drivers.reduce((s,d)=>s+d.score*d.weight,0));

    const result = {
      meta: capCtx.buildMeta(0), company_id: capCtx.companyId, fiscal_period: capCtx.fiscalPeriod,
      score: compositeScore, risk_level: config.riskLevel(compositeScore),
      drivers, recommendations: drivers.filter(d=>d.score<60).map(d=>d.recommendation),
      ai_enhanced: false
    };
    metrics.finish(drivers.length);
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 9 — Treasury Health
// ═══════════════════════════════════════════════════════════════
class TreasuryHealthCapability {
  constructor(){ this.name='TreasuryHealthCapability'; this.health='HEALTHY'; }
  execute(capCtx) {
    const metrics = capCtx.createMetrics(this.name);
    const liq = capCtx.liquidity();
    const risk = capCtx.risk();
    const payments = capCtx.payments();
    const collections = capCtx.collections();
    const t = capCtx.treasury;

    const dims = [
      { dimension:'LIQUIDITY', score: liq?.liquidity_score??50, status: liq?.health??'ADEQUATE',
        signal:`Liquidity score ${liq?.liquidity_score??50}` },
      { dimension:'CASH', score: t.netCash>=0?80:30, status: t.netCash>=0?'HEALTHY':'CRITICAL',
        signal:`Net cash: ${toMXN(t.netCash)}` },
      { dimension:'RISK', score: risk?.score??50, status: risk?.risk_level??'MEDIUM',
        signal:`Risk score ${risk?.score??50}` },
      { dimension:'COLLECTIONS', score: collections?.total_expected>0?60:80,
        status: collections?.total_expected>0?'ADEQUATE':'HEALTHY',
        signal:`Pending collections: ${toMXN(collections?.total_expected??0)}` },
      { dimension:'PAYMENTS', score: payments?.total_upcoming>0?60:85,
        status: payments?.total_upcoming>0?'ADEQUATE':'HEALTHY',
        signal:`Upcoming payments: ${toMXN(payments?.total_upcoming??0)}` }
    ];

    const overallScore = Math.round(dims.reduce((s,d)=>s+d.score*config.healthWeight(d.dimension),0));

    const result = {
      meta: capCtx.buildMeta(0), company_id: capCtx.companyId, fiscal_period: capCtx.fiscalPeriod,
      overall_health: config.liquidityHealth(overallScore/40), // approximate ratio mapping
      overall_score: overallScore, dimensions: dims,
      forecast_accuracy: null, ai_confidence: null,
      data_quality: dataQuality(t.totalEventCount)
    };
    metrics.finish(dims.length);
    return new CapabilityResult(result, metrics);
  }
}

// ═══════════════════════════════════════════════════════════════
// CAPABILITY 10 — Dashboard Aggregation
// ═══════════════════════════════════════════════════════════════
class DashboardAggregationCapability {
  constructor(){ this.name='DashboardAggregationCapability'; this.health='HEALTHY'; }
  execute(capCtx) {
    const metrics = capCtx.createMetrics(this.name);
    const t = capCtx.treasury;

    const result = {
      meta: capCtx.buildMeta(0), company_id: capCtx.companyId, fiscal_period: capCtx.fiscalPeriod,
      cash_position:        capCtx.cashPosition(),
      forecast_summary:     capCtx.forecast(),
      liquidity:            capCtx.liquidity(),
      bank_accounts:        capCtx.bankAccounts(),
      upcoming_payments:    capCtx.payments()?.upcoming_payments ?? [],
      upcoming_collections: capCtx.collections()?.expected_collections ?? [],
      fx_exposure:          capCtx.fxExposure(),
      working_capital:      capCtx.workingCapital(),
      treasury_health:      capCtx.risk() ? null : null, // set by engine after health capability runs
      dashboard_meta: {
        bank_account_count: capCtx.bankAccounts().length,
        event_count: t.totalEventCount,
        data_as_of: new Date().toISOString(),
        collections_empty: [
          ...(capCtx.bankAccounts().length===0 ? ['bank_accounts'] : []),
          ...(capCtx.fxExposure()?.lines.length===0 ? ['fx_exposure.lines'] : [])
        ]
      }
    };
    metrics.finish(1);
    return new CapabilityResult(result, metrics);
  }
}

module.exports = {
  CashPositionCapability, LiquidityCapability, ForecastCapability,
  PaymentCalendarCapability, CollectionCalendarCapability, FXExposureCapability,
  WorkingCapitalCapability, TreasuryRiskCapability, TreasuryHealthCapability,
  DashboardAggregationCapability, RuleForecastProvider
};
