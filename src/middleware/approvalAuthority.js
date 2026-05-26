'use strict';

/**
 * Approval Authority Enforcement Middleware — Phase 1B
 * Enforces treasury/AP/payroll approval limits from DB.
 */

const { query } = require('../config/database');
const { writeAudit } = require('./audit');
const logger = require('../utils/logger');

/**
 * APPROVAL AUTHORITY CACHE ARCHITECTURE
 * ──────────────────────────────────────
 * Model: Process-local Map with TTL — aligned with RBAC cache
 * Scope: Worker-local (each PM2/cluster worker has its own cache)
 * TTL: 45 seconds — matches permission cache TTL for consistency
 *
 * CALL invalidateApprovalAuthorityCache() after:
 *   - POST /api/iam/approval-authority (create/update approval authority)
 *   - User role revocation (roles affect fallback limits)
 *
 * Future scalability: same Redis/pub-sub path as permission cache.
 * In cluster mode, approval limit changes may take up to TTL ms to
 * propagate across workers without distributed cache.
 */
const APPROVAL_CACHE_TTL_MS = 45000;
const _approvalCache = new Map();

function _getApprovalCached(key) {
  const entry = _approvalCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > APPROVAL_CACHE_TTL_MS) {
    _approvalCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function _setApprovalCache(key, value) {
  _approvalCache.set(key, { value, ts: Date.now() });
}

// OBS 4: Explicit invalidation — call after approval_authority changes
function invalidateApprovalAuthorityCache(userId) {
  for (const key of _approvalCache.keys()) {
    if (key.startsWith(`${userId}:`)) _approvalCache.delete(key);
  }
  logger.info(`[APPROVAL] cache invalidated for user=${userId}`);
}

// OBS 3: Periodic cleanup — 5 minute interval
function cleanupApprovalCache() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, val] of _approvalCache.entries()) {
    if (now - val.ts > APPROVAL_CACHE_TTL_MS) { _approvalCache.delete(key); cleaned++; }
  }
  if (cleaned > 0) logger.info(`[APPROVAL] cache cleanup: removed ${cleaned} stale entries`);
}
setInterval(cleanupApprovalCache, 5 * 60 * 1000).unref();

/**
 * Get approval authority for user+company+module
 */
async function getApprovalAuthority(user, companyId, module) {
  const cacheKey = `${user.id}:${companyId}:${module}`;

  // OBS 4: Use Map-based cache
  const cached = _getApprovalCached(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const result = await query(`
      SELECT aa.*
      FROM approval_authority aa
      WHERE aa.user_id = $1
        AND aa.company_id = $2
        AND aa.module = $3
        AND aa.is_active = TRUE
      LIMIT 1
    `, [user.id, parseInt(companyId), module]);

    const authority = result.rows[0] || null;
    _setApprovalCache(cacheKey, authority);
    return authority;
  } catch (err) {
    logger.error(`[APPROVAL] DB query failed: ${err.message}`);
    return null;
  }
}

/**
 * requireApprovalAuthority(module, amountField)
 * Blocks request if amount exceeds user's approval limit.
 *
 * Usage:
 *   router.post('/payments', requireApprovalAuthority('ap_bills', 'amount_paid'), handler)
 */
function requireApprovalAuthority(module, amountField = 'amount') {
  return async (req, res, next) => {
    try {
      const companyId = req.body.company_id || req.query.company_id || req.user.company_id;
      const amount = parseFloat(req.body[amountField] || 0);

      if (!companyId || isNaN(amount)) return next();

      // super_admin bypasses approval limits
      const roles = req.user.roles?.length ? req.user.roles : req.user.role ? [req.user.role] : [];
      if (roles.includes('super_admin')) return next();

      const authority = await getApprovalAuthority(req.user, companyId, module);

      // No authority record found — check role-level limit
      if (!authority) {
      // ISSUE 4: Correct fallback — MAX(role.approval_limit) across all active roles
      // DO NOT join on r.name = module (role names ≠ module names)
      const roleLimit = await query(`
        SELECT MAX(r.approval_limit) AS limit
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1
          AND ur.is_active = TRUE
          AND r.approval_limit IS NOT NULL
      `, [req.user.id]);

        const limit = parseFloat(roleLimit.rows[0]?.limit || 0);
        if (limit > 0 && amount > limit) {
          writeAudit({
            userId: req.user.id, action: 'approval_denied',
            entityType: 'approval_authority', entityId: null,
            companyId: parseInt(companyId),
            newValues: { module, amount, limit, route: `${req.method} ${req.originalUrl}` },
            ip: req.ip, userAgent: req.get('user-agent')
          }).catch(() => {});

          logger.warn(`[APPROVAL] DENIED user=${req.user.id} module=${module} amount=${amount} role_limit=${limit}`);
          return res.status(403).json({
            success: false, error: 'approval_limit_exceeded',
            module, amount, limit,
            message: `Amount $${amount} exceeds your approval limit of $${limit} for ${module}.`
          });
        }
        return next();
      }

      // Check explicit approval limit
      if (authority.approval_limit !== null && amount > parseFloat(authority.approval_limit)) {
        writeAudit({
          userId: req.user.id, action: 'approval_denied',
          entityType: 'approval_authority', entityId: authority.id,
          companyId: parseInt(companyId),
          newValues: { module, amount, limit: authority.approval_limit,
                       requires_secondary: authority.requires_secondary_approval,
                       route: `${req.method} ${req.originalUrl}` },
          ip: req.ip, userAgent: req.get('user-agent')
        }).catch(() => {});

        logger.warn(`[APPROVAL] DENIED user=${req.user.id} module=${module} amount=${amount} limit=${authority.approval_limit}`);
        return res.status(403).json({
          success: false, error: 'approval_limit_exceeded',
          module, amount,
          limit: parseFloat(authority.approval_limit),
          requires_secondary_approval: authority.requires_secondary_approval,
          secondary_approver_id: authority.secondary_approver_id,
          message: `Amount $${amount} exceeds your approval limit of $${authority.approval_limit} for ${module}.`
        });
      }

      // Check secondary approval requirement
      if (authority.requires_secondary_approval && !req.body.secondary_approval_token) {
        return res.status(403).json({
          success: false, error: 'secondary_approval_required',
          module, amount,
          secondary_approver_id: authority.secondary_approver_id,
          message: `This operation requires secondary approval from an authorized approver.`
        });
      }

      next();
    } catch (err) { next(err); }
  };
}

module.exports = {
  getApprovalAuthority,
  requireApprovalAuthority,
  invalidateApprovalAuthorityCache
};
