'use strict';
/**
 * Treasury Capability Pipeline — Sprint P4.1B
 * ADR-107: Dynamic Capability Pipeline
 * IAS-058: Dynamic Capability Pipeline
 * Topological sort. No hardcoded order. Cycle detection (in Registry).
 */
const logger = require('../utils/logger');

class PipelineResult {
  constructor(results, metrics) {
    this.results=results; this.execution_ms=metrics.total_ms;
    this.execution_order=metrics.order; this.resolved_execution_plan=metrics.plan;
    this.capability_timings=metrics.timings; this.capability_versions=metrics.versions;
    this.warnings=metrics.warnings; this.health_summary=metrics.health;
    this.execution_trace=metrics.trace;
    Object.freeze(this);
  }
  get(capability) { return this.results[capability]?.data ?? null; }
}

// Maps capability id → context store key for enrichment
const ENRICHMENT_KEY = {
  cashPosition:'cashPosition', liquidity:'liquidity', forecast:'forecast',
  payments:'payments', collections:'collections', fxExposure:'fxExposure',
  workingCapital:'workingCapital', risk:'risk', health:'health', dashboard:'dashboard'
};

const TreasuryDynamicPipeline = {
  execute(registry, capCtx) {
    const pipelineStart = Date.now();
    const graphStart = Date.now();
    const executionPlan = registry.resolveExecutionPlan();
    const graphResolveMs = Date.now()-graphStart;

    const results={}, timings={}, versions={}, warnings=[], health={}, trace=[], order=[];

    logger.info('[TreasuryPipeline] Resolved plan', {
      plan: executionPlan.map(c=>c.id), graph_resolve_ms: graphResolveMs, request_id: capCtx.requestId
    });

    for (const capDef of executionPlan) {
      const stageStart = Date.now();
      const traceEntry = { id:capDef.id, lifecycle:'EXECUTING', start_ms:stageStart };
      try {
        const result = capDef.provider.execute(capCtx);
        const key = ENRICHMENT_KEY[capDef.id];
        if (key) capCtx._set(key, result.data);

        // Special case: dashboard needs treasury_health set after health capability runs
        if (capDef.id === 'dashboard' && result.data) {
          result.data.treasury_health = capCtx._store.get('health');
        }

        results[capDef.id]=result; timings[capDef.id]=result.execution_ms;
        versions[capDef.id]=capDef.version; health[capDef.id]=result.metadata?.health||'HEALTHY';
        warnings.push(...(result.warnings||[])); order.push(capDef.id);
        traceEntry.lifecycle='COMPLETED'; traceEntry.execution_ms=Date.now()-stageStart;
        trace.push(traceEntry);

        logger.info(`[TreasuryPipeline] ${capDef.id} ✅`, {
          version:capDef.version, execution_ms:result.execution_ms, request_id:capCtx.requestId
        });
      } catch(err) {
        health[capDef.id]='DEGRADED';
        warnings.push(`${capDef.id} v${capDef.version}: ${err.message}`);
        results[capDef.id]={ data:null, execution_ms:Date.now()-stageStart,
          records_generated:0, warnings:[err.message], metadata:{health:'DEGRADED'} };
        traceEntry.lifecycle='FAILED'; traceEntry.error=err.message;
        traceEntry.execution_ms=Date.now()-stageStart; trace.push(traceEntry);
        logger.error(`[TreasuryPipeline] ${capDef.id} ❌`, { error:err.message, request_id:capCtx.requestId });
      }
    }

    const totalMs = Date.now()-pipelineStart;
    const healthValues = Object.values(health);
    const overallHealth = healthValues.includes('DEGRADED')?'DEGRADED':healthValues.includes('WARNING')?'WARNING':'HEALTHY';

    logger.info('[TreasuryPipeline] Complete', {
      total_ms:totalMs, stages:order.length, health:overallHealth, request_id:capCtx.requestId
    });

    return new PipelineResult(results, {
      total_ms:totalMs, order, plan:order, timings, versions, warnings,
      health:{...health, overall:overallHealth}, trace
    });
  }
};

module.exports = { TreasuryDynamicPipeline, PipelineResult };
