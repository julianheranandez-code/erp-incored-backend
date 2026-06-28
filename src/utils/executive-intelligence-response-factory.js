'use strict';
/**
 * Executive Response Factory — Sprint 6.4C
 * ADR-030: Enterprise API Response Standard
 * Never duplicated. Every executive endpoint uses this.
 */
const { v4: uuidv4 } = require('uuid');

const ExecutiveResponseFactory = {
  success(res, data, ctx) {
    return res.json({
      success:        true,
      data,
      metadata: {
        request_id:     ctx.requestId,
        correlation_id: ctx.correlationId,
        company_id:     ctx.companyId,
        generated_at:   new Date().toISOString(),
        execution_ms:   ctx.executionMs,
        engine_ms:      ctx.engineMs    || null,
        validation_ms:  ctx.validationMs|| null,
        filters:        ctx.filters     || {}
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

module.exports = ExecutiveResponseFactory;
