'use strict';
/**
 * IAS-017: SDK Module Boundaries
 * Validation abstraction — Business Platforms provide implementations.
 */
class PlatformValidator {
  validate(req) {
    throw new Error('PlatformValidator.validate() must be implemented by Business Platform');
  }
}
module.exports = { PlatformValidator };