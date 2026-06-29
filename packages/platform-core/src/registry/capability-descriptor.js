'use strict';
function buildCapabilityDescriptorDTO(cap) {
  return {
    id: cap.id, name: cap.id,
    category:           cap.category        || 'BUSINESS',
    provider:           cap.provider?.name  || cap.id,
    provider_version:   cap.version         || '1.0',
    capability_version: cap.version         || '1.0',
    depends_on:         cap.depends_on      || [],
    enabled:            cap.enabled         !== false,
    health:             cap.provider?.health|| 'HEALTHY',
    status:             cap.enabled ? 'ACTIVE' : 'DISABLED',
    description:        cap.description     || '',
    metadata:           { priority: cap.priority || 1 }
  };
}
module.exports = { buildCapabilityDescriptorDTO };