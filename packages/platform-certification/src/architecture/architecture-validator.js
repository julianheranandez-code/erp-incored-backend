'use strict';
/**
 * Architecture Validator — Sprint P4.0Q.1
 * MODULE 4: Verifies architectural rules.
 * IAS-067: Architecture Rules Standard
 */
const ARCHITECTURE_RULES = [
  { id:'ARCH_001', description:'Controller contains no SQL' },
  { id:'ARCH_002', description:'Controller contains no business logic' },
  { id:'ARCH_003', description:'Engine contains no SQL' },
  { id:'ARCH_004', description:'Engine contains no HTTP/Express imports' },
  { id:'ARCH_005', description:'Capabilities receive only CapabilityContext' },
  { id:'ARCH_006', description:'Platform Core reused, not duplicated' },
  { id:'ARCH_007', description:'Financial Platform called once per request (via context)' },
  { id:'ARCH_008', description:'Registry owns dependency graph' },
  { id:'ARCH_009', description:'Pipeline owns execution order' },
  { id:'ARCH_010', description:'DTOs are immutable' },
];
const FORBIDDEN_IN_CONTROLLER = ['SELECT ','INSERT ','UPDATE ','DELETE ','FROM ','WHERE ','JOIN ','knex(','pool.query','db.query'];
const FORBIDDEN_IN_ENGINE = ['express','req.body','res.json','router.','app.use','SELECT ','INSERT '];
const ArchitectureValidator = {
  name: 'ArchitectureValidator',
  validateController(fileContent) {
    const violations = FORBIDDEN_IN_CONTROLLER.filter(p => fileContent.includes(p)).map(p => ({ pattern: p }));
    return { rule_id:'ARCH_001_002', passed: violations.length === 0, violations,
      recommendation: violations.length > 0 ? 'Move SQL/business logic to Engine or Service layer' : null };
  },
  validateEngine(fileContent) {
    const violations = FORBIDDEN_IN_ENGINE.filter(p => fileContent.includes(p)).map(p => ({ pattern: p }));
    return { rule_id:'ARCH_003_004', passed: violations.length === 0, violations,
      recommendation: violations.length > 0 ? 'Engine must not contain HTTP/Express imports or SQL' : null };
  },
  getRules() { return [...ARCHITECTURE_RULES]; }
};
module.exports = { ArchitectureValidator, ARCHITECTURE_RULES };