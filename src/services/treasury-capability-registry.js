'use strict';
/**
 * Treasury Capability Registry — Sprint P4.1B
 * ADR-108: Capability Registry
 * IAS-057: Treasury Capability Registry
 * Registry owns dependency graph. Topological sort execution order.
 */
const {
  CashPositionCapability, LiquidityCapability, ForecastCapability,
  PaymentCalendarCapability, CollectionCalendarCapability, FXExposureCapability,
  WorkingCapitalCapability, TreasuryRiskCapability, TreasuryHealthCapability,
  DashboardAggregationCapability, RuleForecastProvider
} = require('./treasury-capabilities');

const CAPABILITY_DEFINITIONS = [
  { id:'cashPosition',   version:'1.0', depends_on:[], provider:new CashPositionCapability(),
    enabled:true, priority:1, feature_flag:null,
    description:'Current/available/restricted cash from Financial Platform' },
  { id:'liquidity',      version:'1.0', depends_on:['cashPosition'], provider:new LiquidityCapability(),
    enabled:true, priority:2, feature_flag:null,
    description:'Liquidity score, ratio, burn rate, runway' },
  { id:'forecast',       version:'1.0', depends_on:['cashPosition'], provider:new ForecastCapability(new RuleForecastProvider()),
    enabled:true, priority:2, feature_flag:null,
    description:'30-day cash projection (rule-based v1.0)' },
  { id:'payments',       version:'1.0', depends_on:[], provider:new PaymentCalendarCapability(),
    enabled:true, priority:1, feature_flag:null,
    description:'Upcoming/overdue payment calendar' },
  { id:'collections',    version:'1.0', depends_on:[], provider:new CollectionCalendarCapability(),
    enabled:true, priority:1, feature_flag:null,
    description:'Expected collections with probability scoring' },
  { id:'fxExposure',     version:'1.0', depends_on:[], provider:new FXExposureCapability(),
    enabled:true, priority:1, feature_flag:null,
    description:'Currency exposure (reserved for multi-currency)' },
  { id:'workingCapital', version:'1.0', depends_on:['cashPosition'], provider:new WorkingCapitalCapability(),
    enabled:true, priority:2, feature_flag:null,
    description:'AR+Inventory+Cash-AP, cash conversion cycle' },
  { id:'risk',           version:'1.0', depends_on:['liquidity'], provider:new TreasuryRiskCapability(),
    enabled:true, priority:3, feature_flag:null,
    description:'6-dimension weighted treasury risk' },
  { id:'health',         version:'1.0', depends_on:['liquidity','risk','payments','collections'],
    provider:new TreasuryHealthCapability(), enabled:true, priority:4, feature_flag:null,
    description:'5-dimension treasury health composite' },
  { id:'dashboard',      version:'1.0',
    depends_on:['cashPosition','liquidity','forecast','payments','collections','fxExposure','workingCapital','health'],
    provider:new DashboardAggregationCapability(), enabled:true, priority:5, feature_flag:null,
    description:'Aggregate dashboard — primary Treasury Workspace endpoint' }
];

class TreasuryCapabilityRegistry {
  constructor(definitions) {
    this._capabilities = new Map(definitions.map(d=>[d.id, Object.freeze(d)]));
    this._validate();
  }

  getCapabilities()  { return [...this._capabilities.values()].filter(c=>c.enabled); }
  getCapability(id)  { return this._capabilities.get(id) || null; }
  getExecutionGraph(){
    return Object.fromEntries(this.getCapabilities().map(c=>[c.id,{depends_on:c.depends_on,version:c.version}]));
  }
  getHealthStatus()  {
    return Object.fromEntries(this.getCapabilities().map(c=>[c.id, c.provider?.health||'HEALTHY']));
  }

  resolveExecutionPlan() {
    const caps=this.getCapabilities(), visited=new Set(), inStack=new Set(), ordered=[];
    const visit = (id) => {
      if (inStack.has(id)) throw new Error(`[TreasuryRegistry] Circular dependency: ${id}`);
      if (visited.has(id)) return;
      inStack.add(id);
      const cap = this._capabilities.get(id);
      if (!cap) throw new Error(`[TreasuryRegistry] Unknown capability: ${id}`);
      for (const dep of cap.depends_on) visit(dep);
      inStack.delete(id); visited.add(id); ordered.push(cap);
    };
    for (const cap of caps) visit(cap.id);
    return ordered;
  }

  _validate() {
    const ids = new Set(this._capabilities.keys());
    for (const [id,cap] of this._capabilities)
      for (const dep of cap.depends_on)
        if (!ids.has(dep)) throw new Error(`[TreasuryRegistry] '${id}' depends on unknown '${dep}'`);
    this.resolveExecutionPlan(); // validates no cycles
  }
}

const registry = new TreasuryCapabilityRegistry(CAPABILITY_DEFINITIONS);
module.exports = registry;
