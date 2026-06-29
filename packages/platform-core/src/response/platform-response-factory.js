'use strict';
const { v4: uuidv4 } = require('uuid');
const PlatformResponseFactory = {
  success(res, data, ctx = {}) {
    return res.json({ success: true, data, metadata: {
      request_id:     ctx.requestId     || uuidv4(),
      correlation_id: ctx.correlationId || uuidv4(),
      company_id:     ctx.companyId     || null,
      generated_at:   new Date().toISOString(),
      execution_ms:   ctx.executionMs   ?? null,
      engine_ms:      ctx.engineMs      ?? null,
      validation_ms:  ctx.validationMs  ?? null,
      api_version:    ctx.apiVersion    || 'v1.0',
      filters:        ctx.filters       || {}
    }});
  },
  error(res, status, code, message, ctx = {}) {
    return res.status(status).json({ success: false, error: { code, message },
      metadata: { request_id: ctx.requestId||uuidv4(),
        correlation_id: ctx.correlationId||uuidv4(),
        generated_at: new Date().toISOString(), api_version: 'v1.0' }});
  },
  validationError(res, e, ctx)    { return PlatformResponseFactory.error(res, 400, e.code||'VALIDATION_ERROR', e.message, ctx); },
  authorizationError(res, e, ctx) { return PlatformResponseFactory.error(res, 403, e.code||'AUTHORIZATION_ERROR', e.message, ctx); },
  internalError(res, ctx)         { return PlatformResponseFactory.error(res, 500, 'INTERNAL_ERROR', 'An internal error occurred.', ctx); },
  health(res, data)               { return res.json({ success: true, data }); },
  capabilities(res, data, ctx={}) { return res.json({ success: true, data,
    metadata: { generated_at: new Date().toISOString(), request_id: ctx.requestId||uuidv4() }}); }
};
module.exports = { PlatformResponseFactory };