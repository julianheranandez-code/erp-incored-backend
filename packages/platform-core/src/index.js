'use strict';
/**
 * @incored/platform-core v1.0.0
 * ADR-066: Platform Core SDK
 * IAS-016: Platform Core SDK
 * Zero business logic. Pure platform infrastructure.
 */
module.exports = {
  ...require('./context/platform-request-context'),
  ...require('./response/platform-response-factory'),
  ...require('./errors/platform-errors'),
  ...require('./adapter/platform-api-adapter'),
  ...require('./health/platform-health'),
  ...require('./metrics/platform-api-metrics'),
  ...require('./registry/capability-descriptor'),
  ...require('./feature-flags/feature-flag-manager'),
  ...require('./manifest/platform-manifest'),
  ...require('./version/platform-version'),
  ...require('./authorization/platform-authorization'),
  ...require('./validation/platform-validator'),
};