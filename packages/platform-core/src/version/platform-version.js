'use strict';
function buildPlatformVersionDescriptor(overrides={}) {
  return Object.freeze({
    platform_version:     overrides.platform_version  || 'v3.9',
    sdk_version:          '1.0.0',
    architecture_version: 'v3.9',
    api_version:          overrides.api_version       || 'v1.0',
    schema_version:       overrides.schema_version    || 'v1.0',
    engine_version:       overrides.engine_version    || 'unknown',
    registry_version:     overrides.registry_version  || 'unknown',
    pipeline_version:     overrides.pipeline_version  || 'unknown',
    generated_at:         new Date().toISOString()
  });
}
module.exports = { buildPlatformVersionDescriptor };