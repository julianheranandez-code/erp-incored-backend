'use strict';
/**
 * Treasury CapabilityContext — Sprint P4.1B
 * ADR-041 pattern reused (Portfolio P3.2C): self-contained getters only.
 * IAS-056: Treasury Context
 */
const { v4: uuidv4 } = require('uuid');

class CapabilityMetrics {
  constructor(name) {
    this.name=name; this.start=Date.now(); this.execution_ms=0;
    this.records_generated=0; this.cache_hits=0; this.cache_misses=0;
    this.warnings=[]; this.health='HEALTHY'; this.lifecycle='REGISTERED';
  }
  finish(n=0){ this.execution_ms=Date.now()-this.start; this.records_generated=n;
    this.lifecycle='MEASURED'; if(this.execution_ms>2000)this.health='WARNING'; return this; }
  warn(m){ this.warnings.push(m); return this; }
}

class CapabilityResult {
  constructor(data, metrics, warnings=[]) {
    this.data=data; this.execution_ms=metrics.execution_ms;
    this.records_generated=metrics.records_generated;
    this.warnings=[...metrics.warnings,...warnings];
    this.metadata={ capability_name:metrics.name, cache_hits:metrics.cache_hits,
      cache_misses:metrics.cache_misses, health:metrics.health };
    Object.freeze(this);
  }
}

class TreasuryCapabilityContext {
  constructor({ treasuryContext, requestId, correlationId }) {
    this.treasury      = treasuryContext;
    this.requestId     = requestId || uuidv4();
    this.correlationId = correlationId || uuidv4();
    this.companyId     = treasuryContext.companyId;
    this.fiscalPeriod  = treasuryContext.fiscalPeriod;
    this._store        = new Map();
    Object.freeze(this);
  }
  _set(key, value) { this._store.set(key, value); }

  // IAS-056: self-contained getters — capabilities never receive raw params
  cashPosition()    { return this._store.get('cashPosition')    || null; }
  liquidity()       { return this._store.get('liquidity')       || null; }
  forecast()        { return this._store.get('forecast')        || null; }
  payments()        { return this._store.get('payments')        || null; }
  collections()     { return this._store.get('collections')     || null; }
  fxExposure()      { return this._store.get('fxExposure')      || null; }
  workingCapital()  { return this._store.get('workingCapital')  || null; }
  risk()            { return this._store.get('risk')            || null; }
  bankAccounts()    { return this.treasury.bankAccounts || []; }
  financialFacts()  { return this.treasury.raw; }
  executiveRisk()   { return this.treasury.executiveRisk; }

  createMetrics(name) { return new CapabilityMetrics(name); }
  buildMeta(ms=0)      { return this.treasury.buildMeta(ms); }
}

const TreasuryCapabilityContextFactory = {
  build(treasuryContext) {
    return new TreasuryCapabilityContext({
      treasuryContext,
      requestId: treasuryContext.requestId,
      correlationId: treasuryContext.correlationId
    });
  }
};

module.exports = { CapabilityMetrics, CapabilityResult,
  TreasuryCapabilityContext, TreasuryCapabilityContextFactory };
