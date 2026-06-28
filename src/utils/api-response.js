'use strict';
/**
 * API Response Factory — Sprint 6.1C.1
 * Unified response envelope for ALL ERP API routes.
 * {success, data, meta} | {success:false, error:{code,message}}
 */
const { v4: uuidv4 } = require('uuid');

function success(res, data, meta = {}) {
  return res.json({
    success: true,
    data,
    meta: {
      request_id:     meta.request_id     || uuidv4(),
      correlation_id: meta.correlation_id || uuidv4(),
      generated_at:   new Date().toISOString(),
      execution_ms:   meta.execution_ms   ?? null,
      company_id:     meta.company_id     ?? null,
      filters:        meta.filters        ?? {},
      ...meta
    }
  });
}

function error(res, status, code, message, meta = {}) {
  return res.status(status).json({
    success: false,
    error: { code, message },
    meta: {
      request_id:     meta.request_id     || uuidv4(),
      correlation_id: meta.correlation_id || uuidv4(),
      generated_at:   new Date().toISOString()
    }
  });
}

module.exports = { success, error };
