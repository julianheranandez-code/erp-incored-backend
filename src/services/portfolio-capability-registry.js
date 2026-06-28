'use strict';

/**
 * Portfolio Capability Registry v3 — Sprint P3.2C
 * =================================================
 * ADR-051: Dependency Graph Pattern
 * ADR-052: Dynamic Capability Resolution
 * ADR-053: Capability Discovery
 * ADR-054: Topological Execution Planning
 *
 * Registry owns:
 *   - Capability metadata
 *   - Dependency graph
 *   - Capability version
 *   - Provider resolution
 *   - Enabled flag
 *
 * Pipeline NEVER hardcodes capability names or order.
 * Engine NEVER knows execution order.
 */

const {
  PortfolioAggregationCapability,
  PortfolioRankingCapability,
  PortfolioAllocationCapability,
  PortfolioHealthCapability,
  PortfolioComparisonCapability,
  RuleRecommendationCapability,
  BasicComparisonStrategy,
} = require('./portfolio-capabilities');
const { CapabilityContextFactory } = require('./portfolio-capability-context');

// ─── CAPABILITY REGISTRATION ─────────────────────────────────
// CHANGE 3+6: Registry owns dependency graph + metadata
const CAPABILITY_DEFINITIONS = [
  {
    id:          'aggregation',
    version:     '1.0',
    depends_on:  [],                          // no dependencies — runs first
    provider:    new PortfolioAggregationCapability(),
    health:      'HEALTHY',
    priority:    1,
    enabled:     true,
    description: 'Aggregates project financials into portfolio summary'
  },
  {
    id:          'ranking',
    version:     '1.0',
    depends_on:  ['aggregation'],             // needs projects from aggregation
    provider:    new PortfolioRankingCapability(),
    health:      'HEALTHY',
    priority:    2,
    enabled:     true,
    description: 'Ranks projects by revenue, margin, cash, liability, commitment'
  },
  {
    id:          'allocation',
    version:     '1.0',
    depends_on:  ['aggregation'],             // needs projects
    provider:    new PortfolioAllocationCapability(),
    health:      'HEALTHY',
    priority:    2,
    enabled:     true,
    description: 'Computes revenue/cash allocation by status, type, business unit'
  },
  {
    id:          'health',
    version:     '1.0',
    depends_on:  ['aggregation'],             // needs projects
    provider:    new PortfolioHealthCapability(),
    health:      'HEALTHY',
    priority:    2,
    enabled:     true,
    description: 'Identifies critical and warning projects'
  },
  {
    id:          'comparison',
    version:     '1.0',
    depends_on:  ['aggregation', 'health'],   // needs projects + health signals
    provider:    new PortfolioComparisonCapability(new BasicComparisonStrategy()),
    health:      'HEALTHY',
    priority:    3,
    enabled:     true,
    description: 'Compares project performance and identifies concentration risk'
  },
  {
    id:          'recommendation',
    version:     '1.0',
    depends_on:  ['aggregation', 'comparison'], // needs projects + comparison
    provider:    new RuleRecommendationCapability(),
    health:      'HEALTHY',
    priority:    4,
    enabled:     true,
    description: 'Generates rule-based business recommendations'
    // AI EXTENSION (CHANGE 12): swap provider here — no other changes
    // provider: new AIRecommendationCapability()
  }
];

// ─── REGISTRY ────────────────────────────────────────────────
class CapabilityRegistry {
  constructor(definitions) {
    this._capabilities = new Map(definitions.map(d => [d.id, Object.freeze(d)]));
    this._validate();
  }

  // CHANGE 8: Capability Discovery
  getCapabilities()          { return [...this._capabilities.values()].filter(c=>c.enabled); }
  getCapability(id)          { return this._capabilities.get(id) || null; }
  getExecutionGraph()        {
    return Object.fromEntries(
      this.getCapabilities().map(c => [c.id, { depends_on: c.depends_on, version: c.version }])
    );
  }
  getHealthStatus()          {
    return Object.fromEntries(this.getCapabilities().map(c => [c.id, c.provider?.health||'HEALTHY']));
  }

  // CHANGE 4+6: Registry computes topological sort
  resolveExecutionPlan() {
    const caps    = this.getCapabilities();
    const visited = new Set();
    const inStack = new Set();
    const ordered = [];

    const visit = (id) => {
      if (inStack.has(id)) throw new Error(`[CapabilityRegistry] Circular dependency detected: ${id}`);
      if (visited.has(id)) return;
      inStack.add(id);
      const cap = this._capabilities.get(id);
      if (!cap) throw new Error(`[CapabilityRegistry] Unknown capability: ${id}`);
      for (const dep of cap.depends_on) visit(dep);
      inStack.delete(id);
      visited.add(id);
      ordered.push(cap);
    };

    // ADR-054: Topological Sort (DFS)
    for (const cap of caps) visit(cap.id);
    return ordered;
  }

  // CHANGE 11: Validate graph before execution
  _validate() {
    const ids = new Set(this._capabilities.keys());
    for (const [id, cap] of this._capabilities) {
      // Check missing dependencies
      for (const dep of cap.depends_on) {
        if (!ids.has(dep))
          throw new Error(`[CapabilityRegistry] Capability '${id}' depends on unknown '${dep}'`);
      }
    }
    // Check for circular dependencies by running topological sort
    try { this.resolveExecutionPlan(); }
    catch(e) { throw new Error(`[CapabilityRegistry] Graph validation failed: ${e.message}`); }
  }
}

const registry = new CapabilityRegistry(CAPABILITY_DEFINITIONS);

// Expose factory for CapabilityContext creation
registry.capabilityContextFactory = CapabilityContextFactory;

module.exports = registry;
