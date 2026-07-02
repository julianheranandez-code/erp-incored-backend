'use strict';
/**
 * @incored/platform-certification v1.0.0
 * Sprint P4.0Q.1 — Enterprise Certification Kit
 * Reusable by every Business Platform.
 */
module.exports = {
  ...require('./contract/contract-validator'),
  ...require('./api/api-validator'),
  ...require('./performance/performance-validator'),
  ...require('./architecture/architecture-validator'),
  ...require('./capability/capability-validator'),
  ...require('./reporting/certification-report'),
};