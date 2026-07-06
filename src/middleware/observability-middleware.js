'use strict';
/**
 * Observability Middleware — Sprint P4.3B RC1
 * ADR-128: Enterprise Operations Model
 * Adds: correlation IDs, request timing, structured access logs.
 * Works on top of existing Winston logger.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ─── REQUEST CONTEXT ─────────────────────────────────────────
// Attaches request_id + correlation_id to every request
function requestContext(req, res, next) {
  req.id             = req.headers['x-request-id']     || uuidv4();
  req.correlationId  = req.headers['x-correlation-id'] || uuidv4();
  req.startTime      = Date.now();

  // Propagate IDs to response headers
  res.setHeader('X-Request-ID',    req.id);
  res.setHeader('X-Correlation-ID', req.correlationId);

  next();
}

// ─── PERFORMANCE LOGGER ──────────────────────────────────────
// Logs every request with timing after response
function performanceLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const ms       = Date.now() - start;
    const level    = res.statusCode >= 500 ? 'error'
                   : res.statusCode >= 400 ? 'warn' : 'info';

    // Skip health checks from logs to reduce noise
    if (req.path === '/health' || req.path === '/health/db') return;

    logger[level]('[HTTP]', {
      method:         req.method,
      path:           req.path,
      status:         res.statusCode,
      execution_ms:   ms,
      request_id:     req.id,
      correlation_id: req.correlationId,
      user_id:        req.user?.id     ?? null,
      company_id:     req.user?.company_id ?? null,
      ip:             req.ip,
      user_agent:     req.get('user-agent')?.slice(0, 100) ?? null,
      // Performance grade
      grade: ms <= 200 ? 'A' : ms <= 500 ? 'B' : ms <= 1000 ? 'C' : ms <= 3000 ? 'D' : 'F'
    });

    // Alert on slow requests
    if (ms > 3000) {
      logger.warn('[SLOW_REQUEST]', {
        path: req.path, execution_ms: ms,
        request_id: req.id, threshold_ms: 3000
      });
    }
  });

  next();
}

// ─── READINESS ENDPOINT ──────────────────────────────────────
// GET /ready — Kubernetes/Render readiness probe
async function readinessHandler(req, res) {
  try {
    const { testConnection } = require('../config/database');
    const dbOk = await testConnection().catch(() => false);
    if (!dbOk) return res.status(503).json({ status:'not_ready', database:'disconnected' });
    return res.json({
      status:      'ready',
      database:    'connected',
      uptime:      process.uptime(),
      memory_mb:   Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      timestamp:   new Date().toISOString()
    });
  } catch(e) {
    return res.status(503).json({ status:'not_ready', error: e.message });
  }
}

// ─── LIVENESS ENDPOINT ───────────────────────────────────────
// GET /live — Kubernetes/Render liveness probe
function livenessHandler(req, res) {
  return res.json({
    status:    'alive',
    uptime:    process.uptime(),
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    timestamp: new Date().toISOString()
  });
}

module.exports = { requestContext, performanceLogger, readinessHandler, livenessHandler };
