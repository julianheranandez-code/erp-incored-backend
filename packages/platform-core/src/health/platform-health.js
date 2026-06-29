'use strict';
function buildPlatformHealthDTO(cfg={}) {
  return {
    platform:              cfg.platform         || 'incored-erp',
    platform_version:      cfg.platform_version || 'v3.9',
    schema_version:        cfg.schema_version   || 'v1.0',
    sdk_version:           '1.0.0',
    engine_version:        cfg.engine_version   || 'unknown',
    pipeline_version:      cfg.pipeline_version || 'unknown',
    registry_version:      cfg.registry_version || 'unknown',
    execution_model:       cfg.execution_model  || 'DYNAMIC_TOPOLOGICAL_SORT',
    dependency_graph_version: cfg.dep_graph_version || '1.0',
    registered_capabilities: cfg.capabilities  || [],
    capability_health:     cfg.capability_health|| {},
    dependencies:          cfg.dependencies     || {},
    status:                cfg.status           || 'healthy',
    uptime:                process.uptime ? Math.round(process.uptime()) : null,
    generated_at:          new Date().toISOString()
  };
}
module.exports = { buildPlatformHealthDTO };