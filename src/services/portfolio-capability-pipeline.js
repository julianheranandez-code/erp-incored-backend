'use strict';

/**
 * Portfolio Capability Pipeline v2 — Sprint P3.2C
 * =================================================
 * ADR-048: Capability Pipeline Pattern
 * ADR-054: Topological Execution Planning
 *
 * CHANGE 4+5: Dynamic pipeline — no PIPELINE_STAGES static array.
 * Execution order resolved from Registry dependency graph.
 * Pipeline knows NOTHING about business logic or capability order.
 */

const logger = require('../utils/logger');

class PipelineResult {
  constructor(results, metrics) {
    this.results                 = results;
    this.execution_ms            = metrics.total_ms;
    this.execution_order         = metrics.order;
    this.resolved_execution_plan = metrics.plan;
    this.capability_timings      = metrics.timings;
    this.capability_versions     = metrics.versions;
    this.warnings                = metrics.warnings;
    this.health_summary          = metrics.health;
    this.execution_trace         = metrics.trace;
    Object.freeze(this);
  }
  get(capability) { return this.results[capability]?.data ?? null; }
}

const DynamicCapabilityPipeline = {
  /**
   * CHANGE 4: Execute capabilities in dependency-resolved order.
   * Pipeline asks Registry for execution plan.
   * Pipeline never knows capability names or order.
   */
  execute(registry, capCtx) {
    const pipelineStart = Date.now();

    // CHANGE 4: Resolve execution order from dependency graph
    const graphStart     = Date.now();
    const executionPlan  = registry.resolveExecutionPlan();
    const graphResolveMs = Date.now() - graphStart;

    const results  = {};
    const timings  = {};
    const versions = {};
    const warnings = [];
    const health   = {};
    const trace    = [];
    const order    = [];

    logger.info('[DynamicPipeline] Resolved execution plan', {
      plan:           executionPlan.map(c=>c.id),
      graph_resolve_ms: graphResolveMs,
      request_id:     capCtx.requestId
    });

    // CHANGE 5: Execute in resolved order — pipeline controls, not engine
    for (const capDef of executionPlan) {
      const stageStart = Date.now();
      const traceEntry = { id: capDef.id, lifecycle: 'EXECUTING', start_ms: stageStart };

      try {
        // CHANGE 1: Capability receives ONLY CapabilityContext (self-contained)
        const result = capDef.provider.execute(capCtx);

        // Pipeline enriches context for downstream capabilities
        // (via _set — only pipeline can write, capabilities only read)
        const key = capDef.id;
        const data = result.data;

        if (key === 'aggregation') {
          capCtx._set('projects', data?.projects || []);
          capCtx._set('summary',  data?.summary  || null);
        } else {
          capCtx._set(key, data);
        }

        results[capDef.id]  = result;
        timings[capDef.id]  = result.execution_ms;
        versions[capDef.id] = capDef.version;
        health[capDef.id]   = result.metadata?.health || 'HEALTHY';
        warnings.push(...(result.warnings || []));
        order.push(capDef.id);
        traceEntry.lifecycle  = 'COMPLETED';
        traceEntry.execution_ms = Date.now()-stageStart;
        trace.push(traceEntry);

        logger.info(`[DynamicPipeline] ${capDef.id} ✅`, {
          version:      capDef.version,
          execution_ms: result.execution_ms,
          records:      result.records_generated,
          request_id:   capCtx.requestId
        });

      } catch(err) {
        health[capDef.id] = 'DEGRADED';
        warnings.push(`${capDef.id} v${capDef.version}: ${err.message}`);
        results[capDef.id] = {
          data: null, execution_ms: Date.now()-stageStart,
          records_generated:0, warnings:[err.message], metadata:{ health:'DEGRADED' }
        };
        traceEntry.lifecycle    = 'FAILED';
        traceEntry.error        = err.message;
        traceEntry.execution_ms = Date.now()-stageStart;
        trace.push(traceEntry);
        logger.error(`[DynamicPipeline] ${capDef.id} ❌`, {
          error: err.message, request_id: capCtx.requestId
        });
      }
    }

    const totalMs = Date.now()-pipelineStart;
    const healthValues = Object.values(health);
    const overallHealth = healthValues.includes('DEGRADED') ? 'DEGRADED'
                        : healthValues.includes('WARNING')  ? 'WARNING' : 'HEALTHY';

    logger.info('[DynamicPipeline] Complete', {
      total_ms: totalMs, stages: order.length, health: overallHealth,
      graph_resolve_ms: graphResolveMs, request_id: capCtx.requestId
    });

    return new PipelineResult(results, {
      total_ms: totalMs, order, plan: order,
      timings, versions, warnings,
      health: { ...health, overall: overallHealth },
      trace
    });
  }
};

module.exports = { DynamicCapabilityPipeline, PipelineResult };
