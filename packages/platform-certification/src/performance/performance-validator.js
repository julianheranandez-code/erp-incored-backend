'use strict';
/**
 * Performance Validator — Sprint P4.0Q.1
 * MODULE 3: Measures and validates platform performance.
 */
const THRESHOLDS = {
  api_response_ms: 3000, dashboard_ms: 5000, capability_ms: 1000,
  pipeline_ms: 4000, context_build_ms: 2000, p95_target_ms: 2000,
};
const PerformanceValidator = {
  name: 'PerformanceValidator',
  validateExecutionTime(ms, thresholdType = 'api_response_ms') {
    const threshold = THRESHOLDS[thresholdType] ?? THRESHOLDS.api_response_ms;
    const passed = ms <= threshold;
    return {
      passed, execution_ms: ms, threshold_ms: threshold, threshold_type: thresholdType,
      delta_ms: ms - threshold,
      grade: ms <= threshold*0.5 ? 'A' : ms <= threshold*0.75 ? 'B' : ms <= threshold ? 'C' : 'F'
    };
  },
  validateCapabilityTimings(timings = {}) {
    const results = Object.fromEntries(Object.entries(timings).map(([c,ms]) =>
      [c, PerformanceValidator.validateExecutionTime(ms, 'capability_ms')]));
    const failed = Object.entries(results).filter(([,r])=>!r.passed).map(([c])=>c);
    return { passed: failed.length === 0, results, failed_capabilities: failed,
      slowest: Object.entries(timings).sort(([,a],[,b])=>b-a)[0]?.[0] || null };
  },
  validatePipelineHealth(pipelineResult) {
    const errors = [];
    if (!pipelineResult.health_summary?.overall)
      errors.push({ rule:'PIPELINE', field:'health_summary.overall', message:'Pipeline health not reported' });
    if (pipelineResult.health_summary?.overall === 'DEGRADED')
      errors.push({ rule:'PIPELINE', field:'health_summary.overall', message:'Pipeline DEGRADED' });
    const timingResult = PerformanceValidator.validateCapabilityTimings(pipelineResult.capability_timings || {});
    return { passed: errors.length === 0 && timingResult.passed, errors,
      timing_results: timingResult, execution_ms: pipelineResult.execution_ms,
      execution_order: pipelineResult.execution_order || [] };
  },
  getThresholds() { return { ...THRESHOLDS }; }
};
module.exports = { PerformanceValidator, PERFORMANCE_THRESHOLDS: THRESHOLDS };