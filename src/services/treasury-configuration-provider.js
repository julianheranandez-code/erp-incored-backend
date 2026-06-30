'use strict';
/**
 * Treasury Configuration Provider — Sprint P4.1B
 * ADR-109: Treasury Provider Pattern
 * No hardcoded constants anywhere in capabilities.
 */
const config = {
  liquidity: {
    excellent_ratio: 2.0, healthy_ratio: 1.5, adequate_ratio: 1.0, tight_ratio: 0.5,
    burn_rate_warning_months: 6,   // runway < 6mo = warning
  },
  risk: {
    weights: {
      CONCENTRATION_BANK:     0.20,
      CONCENTRATION_CUSTOMER: 0.20,
      CONCENTRATION_SUPPLIER: 0.15,
      FX_EXPOSURE:            0.15,
      LIQUIDITY:              0.20,
      COUNTERPARTY:           0.10,
    },
    levels: { HEALTHY:80, LOW:65, MEDIUM:45, HIGH:25, CRITICAL:0 }
  },
  forecast: {
    default_confidence: 0.75,
    horizon_days: { DAYS_7:7, DAYS_30:30, DAYS_90:90, DAYS_365:365 }
  },
  payments: {
    overdue_threshold_days: 0,
    priority_amount_threshold: 100000,  // amount_base above = HIGH priority
  },
  collections: {
    default_probability: 0.85,
    overdue_probability_penalty: 0.3,   // reduce probability by this much if overdue
  },
  health: {
    weights: { LIQUIDITY:0.30, CASH:0.20, RISK:0.25, COLLECTIONS:0.15, PAYMENTS:0.10 }
  }
};

class TreasuryConfigurationProvider {
  get(path) { return path.split('.').reduce((o,k)=>o?.[k], config); }
  liquidityThreshold(level) { return this.get(`liquidity.${level}_ratio`); }
  riskWeight(dim) { return this.get(`risk.weights.${dim}`); }
  riskLevel(score) {
    const l = this.get('risk.levels');
    if (score>=l.HEALTHY) return'HEALTHY'; if(score>=l.LOW)return'LOW';
    if (score>=l.MEDIUM) return'MEDIUM'; if(score>=l.HIGH)return'HIGH'; return'CRITICAL';
  }
  liquidityHealth(ratio) {
    if (ratio===null) return 'CRITICAL';
    if (ratio>=this.liquidityThreshold('excellent')) return'EXCELLENT';
    if (ratio>=this.liquidityThreshold('healthy'))   return'HEALTHY';
    if (ratio>=this.liquidityThreshold('adequate'))  return'ADEQUATE';
    if (ratio>=this.liquidityThreshold('tight'))     return'TIGHT';
    return'CRITICAL';
  }
  healthWeight(dim) { return this.get(`health.weights.${dim}`); }
}

module.exports = new TreasuryConfigurationProvider();
