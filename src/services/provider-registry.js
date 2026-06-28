'use strict';

/**
 * Provider Registry — Sprint 6.4B.1
 * ====================================
 * ADR-025: Dependency Inversion — Engine depends on interfaces,
 * not implementations. Providers injected through Registry.
 *
 * CHANGE 8+9: Registry decouples Engine from concrete providers.
 * Future: swap RuleInsightProvider → AIInsightProvider here.
 * Engine requires ZERO modifications.
 */

const {
  StaticConfigurationProvider,
  RuleInsightProvider,
  RuleAlertProvider,
  WeightedRiskStrategy,
  PortfolioHealthProvider
} = require('./executive-providers');

const config = new StaticConfigurationProvider();

const registry = {
  config:             config,
  insightProvider:    new RuleInsightProvider(config),    // → AIInsightProvider (Sprint 6.5)
  alertProvider:      new RuleAlertProvider(config),      // → AIAlertProvider
  riskStrategy:       new WeightedRiskStrategy(config),   // → AIRiskStrategy
  portfolioProvider:  new PortfolioHealthProvider(config),
};

Object.freeze(registry);
module.exports = registry;
