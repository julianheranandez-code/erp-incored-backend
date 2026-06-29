'use strict';
/**
 * Portfolio Response Factory — Sprint P3.3
 * ADR-059: Portfolio Response Standard
 * Reuses Enterprise API response envelope pattern.
 */
const { v4: uuidv4 } = require('uuid');

module.exports = {
  success(res, data, ctx={}) {
    return res.json({
      success: true, data,
      metadata: {
        request_id:     ctx.requestId     || uuidv4(),
        correlation_id: ctx.correlationId || uuidv4(),
        company_id:     ctx.companyId     || null,
        generated_at:   new Date().toISOString(),
        execution_ms:   ctx.executionMs   ?? null,
        engine_ms:      ctx.engineMs      ?? null,
        validation_ms:  ctx.validationMs  ?? null,
        filters:        ctx.filters       || {}
      }
    });
  },
  error(res, status, code, message, ctx={}) {
    return res.status(status).json({
      success: false,
      error: { code, message },
      metadata: {
        request_id:     ctx.requestId     || uuidv4(),
        correlation_id: ctx.correlationId || uuidv4(),
        generated_at:   new Date().toISOString()
      }
    });
  }
};
