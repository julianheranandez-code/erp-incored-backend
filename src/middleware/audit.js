'use strict';

const { query } = require('../config/database');
const logger = require('../utils/logger');

// Map HTTP methods to audit action names
const METHOD_ACTION_MAP = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
  GET: 'read',
};

// Extract entity type from URL path
const getEntityType = (path) => {
  const segments = path.replace(/^\/api\//, '').split('/');
  return segments[0] || 'unknown';
};

// Extract entity ID from URL
const getEntityId = (req) => {
  const id = req.params?.id;
  return id ? parseInt(id) || null : null;
};

/**
 * Audit log middleware
 * Logs all non-GET actions to audit_logs table
 * Also logs read access for sensitive endpoints
 */
const auditLog = (req, res, next) => {
  // Only log if user is authenticated
  if (!req.user) return next();

  const action = METHOD_ACTION_MAP[req.method] || req.method.toLowerCase();
  const entityType = getEntityType(req.path);
  const entityId = getEntityId(req);

  // Capture request body safely (remove sensitive fields)
  const sanitizeBody = (body) => {
    if (!body) return null;
    const sanitized = { ...body };
    delete sanitized.password;
    delete sanitized.password_hash;
    delete sanitized.newPassword;
    delete sanitized.currentPassword;
    delete sanitized.two_fa_secret;
    delete sanitized.refreshToken;
    return sanitized;
  };

  const originalBody = sanitizeBody(req.body);

  res.on('finish', async () => {
    // Only log mutating actions or sensitive reads
    const shouldLog = req.method !== 'GET' ||
      ['users', 'auth', 'transactions', 'employees', 'payroll'].includes(entityType);

    if (!shouldLog) return;
    if (res.statusCode >= 500) return; // Server errors don't need audit (logged elsewhere)

    try {
      await query(
        `INSERT INTO audit_logs
           (user_id, action, entity_type, entity_id, changes, ip_address, user_agent, status_code)
         VALUES ($1, $2, $3, $4, $5, $6::inet, $7, $8)`,
        [
          req.user.id,
          action,
          entityType,
          entityId,
          originalBody ? JSON.stringify(originalBody) : null,
          req.ip || '0.0.0.0',
          req.get('user-agent') || '',
          res.statusCode,
        ]
      );
    } catch (err) {
      // Never let audit failures break the app
      logger.error('Audit log write failed:', err.message);
    }
  });

  next();
};

/**
 * Write a manual audit entry
 */
const writeAudit = async ({ userId, action, entityType, entityId, changes, ip, userAgent }) => {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6::inet, $7)`,
      [userId, action, entityType, entityId, changes ? JSON.stringify(changes) : null, ip || '0.0.0.0', userAgent || '']
    );
  } catch (err) {
    logger.error('Manual audit write failed:', err.message);
  }
};

module.exports = { auditLog, writeAudit };
