'use strict';

/**
 * CapabilityContext v2 — Sprint P3.2C
 * =====================================
 * ADR-055: Self-contained Capability Pattern
 * CHANGE 1+2: Capabilities access all intermediate results
 * via CapabilityContext getters. No raw objects injected.
 */

const { v4: uuidv4 } = require('uuid');

class CapabilityMetrics {
  constructor(name) {
    this.name=name; this.start=Date.now(); this.execution_ms=0;
    this.records_generated=0; this.cache_hits=0; this.cache_misses=0;
    this.warnings=[]; this.health='HEALTHY'; this.lifecycle='REGISTERED';
  }
  ready()    { this.lifecycle='READY';     return this; }
  executing(){ this.lifecycle='EXECUTING'; return this; }
  finish(n=0){ this.execution_ms=Date.now()-this.start; this.records_generated=n;
    this.lifecycle='MEASURED'; if(this.execution_ms>2000)this.health='WARNING'; return this; }
  warn(m)    { this.warnings.push(m); return this; }
}

class CapabilityResult {
  constructor(data, metrics, warnings=[]) {
    this.data=data; this.execution_ms=metrics.execution_ms;
    this.records_generated=metrics.records_generated;
    this.warnings=[...metrics.warnings,...warnings];
    this.metadata={ capability_name:metrics.name, cache_hits:metrics.cache_hits,
      cache_misses:metrics.cache_misses, health:metrics.health, lifecycle:metrics.lifecycle };
    Object.freeze(this);
  }
}

// ─── CAPABILITY CONTEXT v2 ────────────────────────────────────
// CHANGE 2: Immutable getters for all intermediate pipeline results
class CapabilityContext {
  constructor({ portfolioContext, capabilityConfig={}, featureFlags={}, requestId, correlationId }) {
    this.portfolio     = portfolioContext;
    this.config        = Object.freeze(capabilityConfig);
    this.flags         = Object.freeze(featureFlags);
    this.requestId     = requestId  || uuidv4();
    this.correlationId = correlationId || uuidv4();
    this.companyId     = portfolioContext.companyId;
    this.fiscalPeriod  = portfolioContext.fiscalPeriod;
    this.filters       = portfolioContext.filters;
    this._store        = new Map();  // pipeline enrichment store
    Object.freeze(this);
  }

  // Pipeline enriches store (called only by Pipeline, not capabilities)
  _set(key, value) { this._store.set(key, value); }

  // CHANGE 2: Self-contained getters — capabilities use these
  projects()        { return this._store.get('projects')        || []; }
  summary()         { return this._store.get('summary')         || null; }
  comparison()      { return this._store.get('comparison')      || null; }
  allocations()     { return this._store.get('allocations')     || []; }
  health()          { return this._store.get('health_signals')  || null; }
  recommendations() { return this._store.get('recommendations') || []; }
  rankings()        { return this._store.get('rankings')        || null; }
  company()         { return { id: this.companyId, fiscal_period: this.fiscalPeriod }; }
  request()         { return { id: this.requestId, correlation_id: this.correlationId }; }

  createMetrics(name) { return new CapabilityMetrics(name); }
  isFeatureEnabled(flag) { return this.flags[flag] === true; }
}

const CapabilityContextFactory = {
  build(portfolioContext, options={}) {
    return new CapabilityContext({
      portfolioContext,
      capabilityConfig: options.config || {},
      featureFlags:     options.flags  || {},
      requestId:        portfolioContext.requestId,
      correlationId:    portfolioContext.correlationId
    });
  }
};

function buildRecommendationDTO(o) {
  return Object.freeze({
    recommendation_id: require('uuid').v4(),
    category: o.category||'GENERAL', priority: o.priority||50,
    severity: o.severity||'MEDIUM', title: o.title||'',
    description: o.description||'', recommended_action: o.action||'',
    expected_business_impact: o.impact||'', confidence: o.confidence||1.0,
    source: o.source||'RULES', metadata: o.metadata||{}
  });
}

module.exports = { CapabilityMetrics, CapabilityResult, CapabilityContext,
  CapabilityContextFactory, buildRecommendationDTO };
