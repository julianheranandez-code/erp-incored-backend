'use strict';
const PLATFORM_MANIFEST = Object.freeze({
  name: '@incored/platform-core', version: '1.0.0',
  architecture_version: 'v3.9', api_version: 'v1.0', schema_version: 'v1.0',
  supported_patterns: ['Provider','Strategy','Pipeline','Registry','Context','Facade','Adapter'],
  supported_ias: ['IAS-011','IAS-012','IAS-013','IAS-014','IAS-015','IAS-016','IAS-017','IAS-018','IAS-019','IAS-020'],
  supported_adrs: ['ADR-061','ADR-062','ADR-063','ADR-064','ADR-065','ADR-066','ADR-067','ADR-068','ADR-069','ADR-070'],
  platforms: { financial:'v1.0', executive:'v1.0', portfolio:'v1.0', treasury:'planned', forecast:'planned', ai:'planned' },
  created_at: '2026-06-29'
});
module.exports = { PLATFORM_MANIFEST };