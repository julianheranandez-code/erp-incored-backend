'use strict';
class PlatformApiMetrics {
  constructor(endpoint, ctx) {
    this.endpoint=endpoint; this.ctx=ctx;
    this.startTime=Date.now(); this.engineMs=null; this.validationMs=null;
  }
  recordValidation(ms) { this.validationMs=ms; return this; }
  recordEngine(ms)     { this.engineMs=ms;     return this; }
  finish(statusCode, logger) {
    const executionMs = Date.now()-this.startTime;
    if (logger) logger.info(`[PlatformAPI] ${this.endpoint}`, {
      endpoint: this.endpoint, company_id: this.ctx.companyId,
      user_id: this.ctx.userId, request_id: this.ctx.requestId,
      execution_ms: executionMs, engine_ms: this.engineMs,
      validation_ms: this.validationMs, http_status: statusCode
    });
    return { executionMs, engineMs: this.engineMs, validationMs: this.validationMs };
  }
}
module.exports = { PlatformApiMetrics };