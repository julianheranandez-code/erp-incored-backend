'use strict';

/**
 * RBAC Enforcement Engine — Phase 1B
 * Centralizes all permission checks across ERP modules.
 *
 * ARCHITECTURE:
 *   Current: req.user.role (legacy single-role JWT)
 *   Future:  req.user.roles[] hydrated from DB by verifyToken
 *
 * COMPATIBILITY:
 *   - Legacy users without user_roles entries fall back to LEGACY_ROLE_PERMISSION_MAP
 *   - Multi-role users aggregate permissions from all active roles
 *   - super_admin always has all permissions
 */

const { query } = require('../config/database');
const { writeAudit } = require('./audit');
const logger = require('../utils/logger');

// ─── LEGACY ROLE → PERMISSION MAP ────────────────────────────
// Temporary compatibility layer while migrating from single-role JWT
// to DB-driven multi-role RBAC. DO NOT remove until migration complete.
const LEGACY_ROLE_PERMISSION_MAP = {
  super_admin: ['*'], // wildcard — all permissions
  admin: [
    'ar_invoices.view','ar_invoices.create','ar_invoices.edit',
    'ar_invoices.approve','ar_invoices.apply_payment','ar_invoices.revise',
    'ap_bills.view','ap_bills.create','ap_bills.edit',
    'ap_bills.approve','ap_bills.apply_payment','ap_bills.revise',
    'treasury.view','treasury.manage_accounts','treasury.reconcile',
    'treasury.approve_transfer','treasury.forecast',
    'workforce.view','workforce.manage','workforce.view_sensitive',
    'workforce.manage_payroll','workforce.compliance',
    'projects.view','projects.manage','projects.approve_milestone',
    'inventory.view','inventory.manage','inventory.approve_transfer',
    'finance.view','finance.export','finance.close_period',
    'crm.view','crm.manage',
    'users.view','users.manage','users.reset_password','users.assign_roles',
    'roles.view','roles.manage',
    'audit_logs.view','companies.manage'
  ],
  finance: [
    'ar_invoices.view','ar_invoices.create','ar_invoices.edit',
    'ar_invoices.approve','ar_invoices.apply_payment',
    'ap_bills.view','ap_bills.create','ap_bills.edit',
    'ap_bills.approve','ap_bills.apply_payment',
    'treasury.view','treasury.forecast','treasury.reconcile',
    'finance.view','finance.export',
    'workforce.view','workforce.view_sensitive','workforce.compliance',
    'crm.view','audit_logs.view'
  ],
  treasury: [
    'treasury.view','treasury.manage_accounts','treasury.reconcile',
    'treasury.approve_transfer','treasury.forecast',
    'ap_bills.view','ap_bills.approve',
    'ar_invoices.view','ar_invoices.apply_payment',
    'finance.view'
  ],
  hr: [
    'workforce.view','workforce.manage','workforce.view_sensitive',
    'workforce.manage_payroll','workforce.compliance',
    'users.view'
  ],
  payroll: [
    'workforce.view','workforce.manage_payroll','workforce.compliance',
    'finance.view'
  ],
  operations_manager: [
    'projects.view','projects.manage','projects.approve_milestone',
    'inventory.view','inventory.manage',
    'crm.view','crm.manage',
    'workforce.view','workforce.compliance',
    'finance.view'
  ],
  project_manager: [
    'projects.view','projects.manage',
    'inventory.view','inventory.manage',
    'crm.view','workforce.view'
  ],
  ap_specialist: [
    'ap_bills.view','ap_bills.create','ap_bills.edit',
    'ap_bills.apply_payment'
  ],
  ar_specialist: [
    'ar_invoices.view','ar_invoices.create','ar_invoices.edit',
    'ar_invoices.apply_payment'
  ],
  technician: [
    'projects.view','inventory.view','crm.view'
  ],
  operative: [
    'projects.view','inventory.view','crm.view'
  ],
  /**
   * CLIENT PORTAL GOVERNANCE BOUNDARIES
   * ─────────────────────────────────────
   * Client portal users have strictly limited, project-scoped visibility.
   *
   * ALLOWED:
   *   - client_portal.access    → view assigned project progress
   *   - client_portal.documents → download shared documents only
   *
   * NEVER ALLOWED (enforced by isolation, not just missing permissions):
   *   - treasury.* (no financial visibility)
   *   - workforce.* (no HR/payroll visibility)
   *   - payroll.* (no payroll data)
   *   - users.* (no user management)
   *   - audit_logs.* (no audit trail)
   *   - Cross-project document access
   *
   * Future client portal architecture:
   *   1. External portal gateway (separate Express app or subdomain)
   *   2. Customer MFA (TOTP or email OTP)
   *   3. Secure expiring document links (pre-signed S3 URLs)
   *   4. Project-milestone visibility rules
   *   5. Client-facing invoice approval workflow
   */
  client_portal: [
    'client_portal.access','client_portal.documents'
  ]
};

// ─── PERMISSION CACHE ─────────────────────────────────────────
/**
 * PERMISSION CACHE ARCHITECTURE
 * ──────────────────────────────
 * Model: Process-local in-memory Map with TTL
 * Scope: Worker-local (each PM2/cluster worker has its own cache)
 * TTL: 45 seconds per entry
 *
 * Why this is acceptable:
 *   - ERP is single-node or mid-scale deployment
 *   - 45s TTL limits stale permission windows
 *   - Manual invalidation available for immediate consistency
 *   - No distributed state required at current scale
 *
 * Future scalability path (when needed):
 *   1. Replace Map with Redis client
 *   2. Implement pub/sub invalidation across workers
 *   3. Use centralized permission service
 *   4. Consider distributed cache (Redis Cluster, Valkey)
 *
 * NOTE: In PM2 cluster mode, each worker maintains its own cache.
 * Permission changes may take up to TTL ms to propagate across workers.
 * For immediate consistency, call invalidateUserPermissionCache() from
 * all workers via IPC, or reduce TTL, or use Redis.
 */
const PERM_CACHE_TTL_MS = 45000; // 45 seconds
const _permCache = new Map();

function _getCached(userId) {
  const entry = _permCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > PERM_CACHE_TTL_MS) {
    _permCache.delete(userId);
    return null;
  }
  return entry.permissions;
}

function _setCache(userId, permissions) {
  _permCache.set(userId, { permissions, ts: Date.now() });
  // Cleanup stale entries periodically (every 100 sets)
  if (_permCache.size > 100) {
    const now = Date.now();
    for (const [key, val] of _permCache.entries()) {
      if (now - val.ts > PERM_CACHE_TTL_MS) _permCache.delete(key);
    }
  }
}

/**
 * CACHE INVALIDATION STRATEGY
 * ────────────────────────────
 * Current: Manual invalidation after mutating operations.
 *
 * CALL invalidateUserPermissionCache() after:
 *   - Role assignment (POST /api/iam/users/:id/roles)
 *   - Role revocation (DELETE /api/iam/users/:id/roles/:roleId)
 *   - Company access changes (POST /api/iam/users/:id/company-access)
 *   - Permission matrix updates (PUT /api/iam/roles/:id/permissions)
 *
 * Future auto-invalidation options:
 *   1. Redis pub/sub: publish 'permission:invalidate:{userId}' on role change
 *   2. Message queue: emit event → all workers invalidate
 *   3. WebSocket broadcast: server → all active sessions for user
 *   4. Middleware hooks: auto-invalidate in IAM mutation routes
 */
function invalidateUserPermissionCache(userId) {
  _permCache.delete(userId);
  logger.info(`[RBAC] permission cache invalidated for user=${userId}`);
}

// OBS 1: Periodic cleanup — 5 minute interval
function cleanupPermissionCache() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, val] of _permCache.entries()) {
    if (now - val.ts > PERM_CACHE_TTL_MS) { _permCache.delete(key); cleaned++; }
  }
  if (cleaned > 0) logger.info(`[RBAC] cache cleanup: removed ${cleaned} stale entries`);
}
setInterval(cleanupPermissionCache, 5 * 60 * 1000).unref();

/**
 * HIGH_RISK_GET_PATTERNS
 * ───────────────────────
 * Regex-based patterns for GET endpoints that are mutating or sensitive.
 * Readonly users (access_level='read_only') are blocked from these.
 *
 * Using regex instead of string.includes() for deterministic matching:
 *   - Matches '/export' and '/export/pdf' but not '/exporter'
 *   - The (/|$) suffix ensures word-boundary matching
 */
const HIGH_RISK_GET_PATTERNS = [
  /\/export(\/|$)/i,
  /\/close-period(\/|$)/i,
  /\/generate(\/|$)/i,
  /\/execute(\/|$)/i,
  /\/reconcile(\/|$)/i,
  /\/close(\/|$)/i,
  /\/finalize(\/|$)/i,
  /\/approve(\/|$)/i,
  /\/trigger(\/|$)/i
];

// ─── HELPERS ──────────────────────────────────────────────────

/**
 * Get effective roles from JWT (supports legacy + future multi-role)
 */
function getEffectiveRoles(user) {
  return user.roles?.length ? user.roles : user.role ? [user.role] : [];
}

/**
 * Get effective permissions for a user.
 * Priority: DB user_roles → legacy role fallback
 */
async function getEffectivePermissions(user) {
  // ISSUE 1: Use userId-based Map cache with TTL
  const cached = _getCached(user.id);
  if (cached) return cached;

  const roles = getEffectiveRoles(user);

  // super_admin wildcard — skip DB
  if (roles.includes('super_admin')) {
    const perms = new Set(['*']);
    _setCache(user.id, perms);
    return perms;
  }

  const perms = new Set();

  try {
    // DB-driven permissions from user_roles
    const dbPerms = await query(`
      SELECT DISTINCT CONCAT(p.resource, '.', p.action) AS permission
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1 AND ur.is_active = TRUE
    `, [user.id]);

    if (dbPerms.rows.length > 0) {
      dbPerms.rows.forEach(r => perms.add(r.permission));
    } else {
      // Legacy fallback — no user_roles in DB yet
      for (const role of roles) {
        const legacyPerms = LEGACY_ROLE_PERMISSION_MAP[role] || [];
        legacyPerms.forEach(p => perms.add(p));
      }
    }
  } catch (err) {
    // DB error — fall back to legacy map for availability
    logger.error(`[RBAC] DB permission query failed: ${err.message} — using legacy fallback`);
    for (const role of roles) {
      const legacyPerms = LEGACY_ROLE_PERMISSION_MAP[role] || [];
      legacyPerms.forEach(p => perms.add(p));
    }
  }

  _setCache(user.id, perms);
  return perms;
}

/**
 * PERMISSION PRECEDENCE ENGINE
 * ─────────────────────────────
 * Evaluation order (first match wins):
 *
 *   1. EXPLICIT DENY    (!resource.action)      → ALWAYS blocks
 *   2. NAMESPACE DENY   (!resource.*)           → blocks all resource.*
 *   3. EXACT ALLOW      (resource.action)       → grants specific action
 *   4. NAMESPACE ALLOW  (resource.*)            → grants all in namespace
 *   5. HIERARCHICAL     (parent.child.*)        → grants nested namespace
 *   6. GLOBAL           (*)                     → grants everything
 *
 * DENY ALWAYS WINS: An explicit deny cannot be overridden by any allow.
 * This enables governance exceptions: treasury.* BUT !treasury.manage_accounts
 *
 * Current limitations (acceptable for ERP scale):
 *   - No priority weights between deny rules
 *   - No role-level deny vs user-level deny distinction
 *   - No resource condition matching (ABAC)
 *
 * Future advanced policy engine options:
 *   - Hierarchical policy trees with inheritance
 *   - ABAC overlays (attribute-based conditions)
 *   - Scoped deny exceptions per resource instance
 *   - Policy version control and audit
 */
async function hasPermission(user, permission) {
  const perms = await getEffectivePermissions(user);

  // OBS 5: Check explicit denies FIRST — deny always wins
  // Deny format: '!resource.action' or '!resource.*'
  const denyKey = `!${permission}`;
  if (perms.has(denyKey)) return false;

  // Check namespace deny: !treasury.* denies all treasury.*
  const parts = permission.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const nsdeny = `!${parts.slice(0, i).join('.')}.*`;
    if (perms.has(nsdeny)) return false;
  }

  // Global wildcard allow
  if (perms.has('*')) return true;

  // Exact match allow
  if (perms.has(permission)) return true;

  // OBS 4: Hierarchical namespace wildcard matching
  // finance.treasury.view → check finance.treasury.* → finance.* → *
  for (let i = parts.length - 1; i > 0; i--) {
    const nsWildcard = `${parts.slice(0, i).join('.')}.*`;
    if (perms.has(nsWildcard)) return true;
  }

  return false;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────

/**
 * requirePermission(permission)
 * Express middleware — blocks request if user lacks permission.
 *
 * Usage:
 *   router.post('/bank-transfer', requirePermission('treasury.approve'), handler)
 */
function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const allowed = await hasPermission(req.user, permission);

      if (!allowed) {
        // PART 7: Audit permission denial
        writeAudit({
          userId: req.user.id,
          action: 'permission_denied',
          entityType: 'rbac',
          entityId: null,
          companyId: req.user.company_id || null,
          newValues: {
            attempted_permission: permission,
            route: `${req.method} ${req.originalUrl}`,
            user_role: req.user.role
          },
          ip: req.ip,
          userAgent: req.get('user-agent')
        }).catch(() => {});

        logger.warn(`[RBAC] DENIED user=${req.user.id} role=${req.user.role} permission=${permission} route=${req.method} ${req.originalUrl}`);

        return res.status(403).json({
          success: false,
          error: 'permission_denied',
          permission,
          message: `Access denied. Required permission: ${permission}`
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * requireAnyPermission(permissions[])
 * OBS 2: Uses hasPermission() for consistent wildcard support
 * Allows if user has AT LEAST ONE of the listed permissions.
 */
function requireAnyPermission(...permissions) {
  return async (req, res, next) => {
    try {
      // OBS 2: Use hasPermission() so namespace wildcards work consistently
      const results = await Promise.all(permissions.map(p => hasPermission(req.user, p)));
      const allowed = results.some(Boolean);

      if (!allowed) {
        writeAudit({
          userId: req.user.id, action: 'permission_denied',
          entityType: 'rbac', entityId: null,
          companyId: req.user.company_id || null,
          newValues: { attempted_permissions: permissions, route: `${req.method} ${req.originalUrl}` },
          ip: req.ip, userAgent: req.get('user-agent')
        }).catch(() => {});

        return res.status(403).json({
          success: false, error: 'permission_denied',
          permissions,
          message: `Access denied. Required one of: ${permissions.join(', ')}`
        });
      }
      next();
    } catch (err) { next(err); }
  };
}

/**
 * PART 2: Company-scoped access check with access_level enforcement
 * ISSUE 2: Respects access_level (global/full/readonly/restricted)
 */
async function hasCompanyAccess(user, companyId, method = 'GET') {
  const roles = getEffectiveRoles(user);

  // super_admin always has access
  if (roles.includes('super_admin')) return { allowed: true, access_level: 'global' };

  // admin: check user_company_access or fall back to user.company_id
  const isAdmin = roles.includes('admin');
  if (isAdmin && parseInt(user.company_id) === parseInt(companyId)) {
    return { allowed: true, access_level: 'full' };
  }

  try {
    const result = await query(`
      SELECT access_level FROM user_company_access
      WHERE user_id = $1 AND company_id = $2 AND is_active = TRUE
      LIMIT 1
    `, [user.id, parseInt(companyId)]);

    if (!result.rows[0]) return { allowed: false, access_level: null };

    const { access_level } = result.rows[0];

    // ISSUE 2: Enforce access_level semantics
    if (access_level === 'restricted') return { allowed: false, access_level };

    if (access_level === 'read_only') {
      const isWriteMethod = ['POST','PUT','PATCH','DELETE'].includes(method?.toUpperCase());
      if (isWriteMethod) return { allowed: false, access_level, reason: 'read_only_violation' };
    }

    return { allowed: true, access_level };
  } catch (err) {
    logger.error(`[RBAC] company access check failed: ${err.message}`);
    return { allowed: false, access_level: null };
  }
}

/**
 * requireCompanyAccess()
 * ISSUE 3: Supports route params, query params, and body params
 */
function requireCompanyAccess() {
  return async (req, res, next) => {
    // ISSUE 3: Extended companyId resolution order
    const companyId =
      req.params.companyId ||
      req.params.company_id ||
      req.query.company_id ||
      req.body.company_id;

    if (!companyId) return next();

    const { allowed, access_level, reason } = await hasCompanyAccess(req.user, companyId, req.method);

    // OBS 2: Block sensitive GET patterns for readonly users
    let effectiveReason = reason;
    let effectiveAllowed = allowed;
    if (allowed && access_level === 'read_only' && req.method === 'GET') {
      const path = req.path.toLowerCase();
      const isHighRisk = HIGH_RISK_GET_PATTERNS.some(pattern => pattern.test(path));
      if (isHighRisk) {
        effectiveAllowed = false;
        effectiveReason = 'read_only_sensitive_get';
      }
    }

    if (!effectiveAllowed) {
      const auditAction = access_level === 'restricted'
        ? 'company_access_restricted'
        : effectiveReason === 'read_only_violation' || effectiveReason === 'read_only_sensitive_get'
        ? 'company_access_readonly_violation'
        : 'company_access_denied';

      // OBS 3: Audit company access violations
      writeAudit({
        userId: req.user.id, action: auditAction,
        entityType: 'company_access', entityId: parseInt(companyId),
        companyId: parseInt(companyId),
        newValues: {
          requested_company_id: companyId,
          route: `${req.method} ${req.originalUrl}`,
          access_level: access_level || 'none',
          method: req.method
        },
        ip: req.ip, userAgent: req.get('user-agent')
      }).catch(() => {});

      logger.warn(`[RBAC] ${auditAction} user=${req.user.id} company=${companyId} method=${req.method}`);

      const message = access_level === 'restricted'
        ? 'Access to this company is restricted.'
        : effectiveReason === 'read_only_sensitive_get'
        ? 'Your company access is read-only. This operation is not permitted.'
        : effectiveReason === 'read_only_violation'
        ? 'Your company access is read-only. Write operations are not permitted.'
        : 'You do not have access to this company.';

      return res.status(403).json({
        success: false,
        error: access_level === 'restricted' ? 'company_access_restricted' : 'company_access_denied',
        access_level,
        message
      });
    }

    // Attach access_level for downstream use
    req.companyAccessLevel = access_level;
    next();
  };
}

module.exports = {
  getEffectiveRoles,
  getEffectivePermissions,
  hasPermission,
  hasCompanyAccess,
  requirePermission,
  requireAnyPermission,
  requireCompanyAccess,
  invalidateUserPermissionCache,
  LEGACY_ROLE_PERMISSION_MAP
};
