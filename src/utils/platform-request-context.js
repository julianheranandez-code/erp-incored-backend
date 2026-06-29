'use strict';
/**
 * Platform Request Context — Sprint P3.3A
 * ADR-062: Platform API Adapter Pattern
 * IAS-015: Platform Request Context
 * Reusable by Financial, Executive, Portfolio, Treasury APIs.
 */
const { v4: uuidv4 } = require('uuid');

function buildPlatformRequestContext(req) {
  return Object.freeze({
    requestId:      req.id || uuidv4(),
    correlationId:  req.headers['x-correlation-id'] || uuidv4(),
    userId:         req.user?.id    || null,
    companyId:      null,             // set after authorization
    permissions:    req.user?.permissions || [],
    locale:         req.headers['accept-language'] || 'es-MX',
    timezone:       req.headers['x-timezone'] || 'America/Mexico_City',
    featureFlags:   {},
    startTime:      Date.now(),
    platform:       'incored-erp',
    apiVersion:     'v1.0'
  });
}

module.exports = { buildPlatformRequestContext };
