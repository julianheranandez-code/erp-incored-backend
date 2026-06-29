'use strict';
/**
 * ADR-070: SDK Dependency Injection
 * Authorization abstraction — Business Platforms inject implementation.
 * SDK never contains business authorization logic.
 */
class PlatformAuthorizationProvider {
  async authorize(user, companyId) {
    throw new Error('PlatformAuthorizationProvider.authorize() must be implemented by Business Platform');
  }
}
module.exports = { PlatformAuthorizationProvider };