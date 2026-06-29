'use strict';
/**
 * Platform API Adapter — Sprint P3.3A
 * ADR-062: Platform API Adapter Pattern
 * ADR-065: Enterprise API Standardization
 * IAS-013: Enterprise API Adapter
 *
 * Centralizes: RequestContext, ResponseFactory, ErrorMapping, Observability.
 * Controllers: Controller → PlatformApiAdapter → Validator → Engine → Response
 *
 * Future @incored/platform-core SDK extracts this file.
 */
const { v4: uuidv4 } = require('uuid');
const { buildPlatformRequestContext } = require('./platform-request-context');
const { authorizeCompanyAccess, AuthorizationError } = require('../services/financial-authorization-service');
const logger = require('../utils/logger');

// ─── ERROR MAPPING (CHANGE 6) ────────────────────────────────
// IAS-014: Platform Response Standard
const ERROR_STATUS_MAP = {
  ValidationError:             400,
  InvalidFiscalPeriod:         400,
  InvalidAllocationType:       400,
  InvalidRankingMetric:        400,
  COMPANY_REQUIRED:            400,
  AuthorizationError:          403,
  UnauthorizedCompanyAccess:   403,
  PortfolioNotFound:           404,
  ProjectNotFound:             404,
  ExecutiveInsightNotFound:    404,
  InsufficientPortfolioData:   422,
  InsufficientFinancialData:   422,
  CapabilityUnavailable:       503,
  DependencyResolutionFailed:  500,
};

function mapErrorStatus(e) {
  return ERROR_STATUS_MAP[e.name] || ERROR_STATUS_MAP[e.code] || 500;
}

// ─── RESPONSE FACTORY (CHANGE 4) ────────────────────────────
// IAS-014: Platform Response Standard
const PlatformResponseFactory = {
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
        api_version:    ctx.apiVersion    || 'v1.0',
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
        generated_at:   new Date().toISOString(),
        api_version:    'v1.0'
      }
    });
  },
  validationError(res, e, ctx)     { return PlatformResponseFactory.error(res, 400, e.code||'VALIDATION_ERROR', e.message, ctx); },
  authorizationError(res, e, ctx)  { return PlatformResponseFactory.error(res, 403, e.code||'AUTHORIZATION_ERROR', e.message, ctx); },
  internalError(res, ctx)          { return PlatformResponseFactory.error(res, 500, 'INTERNAL_ERROR', 'An internal error occurred.', ctx); },
  health(res, data)                { return res.json({ success:true, data }); },
  capabilities(res, data, ctx={})  { return res.json({ success:true, data,
    metadata: { generated_at: new Date().toISOString(), request_id: ctx.requestId||uuidv4() } }); }
};

// ─── OBSERVABILITY (CHANGE 7) ────────────────────────────────
// IAS-011: Platform Health Standard — metrics collector
class PlatformApiMetrics {
  constructor(endpoint, ctx) {
    this.endpoint   = endpoint;
    this.ctx        = ctx;
    this.startTime  = Date.now();
    this.engineMs   = null;
    this.validationMs = null;
  }
  recordValidation(ms) { this.validationMs = ms; return this; }
  recordEngine(ms)     { this.engineMs     = ms; return this; }
  finish(statusCode) {
    const executionMs = Date.now() - this.startTime;
    logger.info(`[PlatformAPI] ${this.endpoint}`, {
      endpoint:        this.endpoint,
      company_id:      this.ctx.companyId,
      user_id:         this.ctx.userId,
      request_id:      this.ctx.requestId,
      correlation_id:  this.ctx.correlationId,
      execution_ms:    executionMs,
      engine_ms:       this.engineMs,
      validation_ms:   this.validationMs,
      http_status:     statusCode,
      api_version:     this.ctx.apiVersion || 'v1.0'
      // NOTE: Never log financial amounts
    });
    return { executionMs, engineMs: this.engineMs, validationMs: this.validationMs };
  }
}

// ─── ADAPTER (CHANGE 3) ──────────────────────────────────────
// ADR-062: Platform API Adapter Pattern
// Controller → withPlatformAuth → Validator → Engine → Response
function withPlatformAuth(endpoint, validateFn, engineFn) {
  return async (req, res, next) => {
    const reqCtx  = buildPlatformRequestContext(req);
    const metrics = new PlatformApiMetrics(endpoint, reqCtx);

    try {
      // 1. Validate
      const valStart    = Date.now();
      const { companyId, filters } = await validateFn(req);
      metrics.recordValidation(Date.now() - valStart);

      // 2. Authorize (reuse Enterprise Authorization Service)
      await authorizeCompanyAccess(req.user, companyId);
      const authorizedCtx = { ...reqCtx, companyId };

      // 3. Call Engine
      const engineStart = Date.now();
      const data        = await engineFn(companyId, filters, req, authorizedCtx);
      metrics.recordEngine(Date.now() - engineStart);

      // 4. Respond
      const { executionMs, engineMs, validationMs } = metrics.finish(200);
      return PlatformResponseFactory.success(res, data, {
        ...authorizedCtx, filters, executionMs, engineMs, validationMs
      });

    } catch(e) {
      const status = mapErrorStatus(e);
      const { executionMs } = metrics.finish(status);
      logger.warn(`[PlatformAPI] ${endpoint} ${e.name}`, {
        endpoint, user_id: reqCtx.userId,
        request_id: reqCtx.requestId, code: e.code||'ERROR',
        execution_ms: executionMs, http_status: status
      });
      if (status === 500) return next(e);
      if (e.name === 'AuthorizationError') return PlatformResponseFactory.authorizationError(res, e, reqCtx);
      if (e.name === 'ValidationError')    return PlatformResponseFactory.validationError(res, e, reqCtx);
      return PlatformResponseFactory.error(res, status, e.code||'ERROR', e.message, reqCtx);
    }
  };
}

// ─── PLATFORM HEALTH DTO (CHANGE 1) ─────────────────────────
// ADR-063: Platform Health DTO — IAS-011
function buildPlatformHealthDTO(platformConfig={}) {
  return {
    platform:              platformConfig.platform       || 'incored-erp',
    platform_version:      platformConfig.platform_version || 'v3.9',
    schema_version:        platformConfig.schema_version  || 'v1.0',
    engine_version:        platformConfig.engine_version  || 'unknown',
    pipeline_version:      platformConfig.pipeline_version|| 'unknown',
    registry_version:      platformConfig.registry_version|| 'unknown',
    sdk_version:           null,                          // future @incored/platform-core
    execution_model:       platformConfig.execution_model || 'DYNAMIC_TOPOLOGICAL_SORT',
    dependency_graph_version: platformConfig.dep_graph_version || '1.0',
    registered_capabilities: platformConfig.capabilities || [],
    capability_health:     platformConfig.capability_health || {},
    dependencies: {
      financial_platform:     'v1.0',
      executive_intelligence: 'v1.0',
      portfolio_engine:       'P3.2C-v1.0'
    },
    status:                platformConfig.status || 'healthy',
    uptime:                process.uptime ? Math.round(process.uptime()) : null,
    generated_at:          new Date().toISOString()
  };
}

// ─── CAPABILITY DESCRIPTOR DTO (CHANGE 2) ───────────────────
// ADR-064: Capability Descriptor DTO — IAS-012
function buildCapabilityDescriptorDTO(cap) {
  return {
    id:               cap.id,
    name:             cap.id,
    category:         cap.category || 'PORTFOLIO',
    provider:         cap.provider?.name || cap.id,
    provider_version: cap.version || '1.0',
    capability_version: cap.version || '1.0',
    depends_on:       cap.depends_on || [],
    enabled:          cap.enabled !== false,
    health:           cap.provider?.health || 'HEALTHY',
    status:           cap.enabled ? 'ACTIVE' : 'DISABLED',
    description:      cap.description || '',
    metadata:         { priority: cap.priority || 1 }
  };
}

module.exports = {
  buildPlatformRequestContext,
  PlatformResponseFactory,
  PlatformApiMetrics,
  withPlatformAuth,
  buildPlatformHealthDTO,
  buildCapabilityDescriptorDTO,
  mapErrorStatus
};
