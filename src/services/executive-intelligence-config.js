'use strict';

/**
 * Executive Intelligence Configuration — Sprint 6.4B
 * ====================================================
 * ALL thresholds and weights live here.
 * Business logic NEVER contains hardcoded constants.
 * Override per-company in future Sprint 7.
 */

module.exports = {

  // ── Alert Thresholds ──────────────────────────────────────
  alerts: {
    minimum_margin_pct:        15,     // below = WARNING alert
    critical_margin_pct:       0,      // below = CRITICAL alert
    maximum_liability_days:    30,     // overdue AP bill trigger (days)
    negative_cash_threshold:   0,      // net_cash < 0 = alert
    revenue_concentration_pct: 70,     // single client > 70% = risk
    expense_concentration_pct: 60,     // single vendor > 60% = risk
    commitment_vs_revenue_pct: 80,     // commitments > 80% of revenue = alert
    project_margin_warning:    10,     // project margin < 10% = WARNING
    project_margin_critical:   0,      // project margin < 0% = CRITICAL
  },

  // ── Risk Engine Weights (must sum to 1.0) ────────────────
  risk: {
    weights: {
      CASH_FLOW:     0.30,
      MARGIN:        0.25,
      LIABILITY:     0.20,
      CONCENTRATION: 0.15,
      COMMITMENT:    0.10,
    },
    // Score thresholds → RiskLevel
    levels: {
      HEALTHY:  80,   // score >= 80
      LOW:      65,   // score >= 65
      MEDIUM:   45,   // score >= 45
      HIGH:     25,   // score >= 25
      CRITICAL: 0,    // score < 25
    }
  },

  // ── Portfolio Health Thresholds ──────────────────────────
  portfolio: {
    health: {
      EXCELLENT:  30,   // margin_pct >= 30
      GOOD:       15,   // margin_pct >= 15
      WARNING:    0,    // margin_pct >= 0
      CRITICAL:  -1,    // margin_pct < 0
    }
  },

  // ── Insight Priority Scoring ─────────────────────────────
  insights: {
    severity_base_priority: {
      CRITICAL: 90,
      HIGH:     70,
      MEDIUM:   50,
      LOW:      30,
      INFO:     10,
    }
  },

  // ── Trend Periods ────────────────────────────────────────
  trends: {
    default_periods: 6,     // last N periods for trend analysis
  }
};
