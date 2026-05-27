'use strict';

/**
 * Effective Permissions Engine v2 — IAM Phase 2B
 * ─────────────────────────────────────────────────
 * Changes from v1:
 *   - expanded_permissions: wildcard permissions expanded against DB catalog
 *   - effect='deny' column support in role_permissions (OBS 3)
 *   - Legacy !permission string fallback preserved
 *   - policy-context.js integration stub (OBS 4)
 *   - allPermissionsCatalog loaded at runtime
 */

const { query } = require('../../config/database');
const { evaluatePolicyContext } = require('./policy-context');
const { groupPermissionsByResource, buildPermissionSummary, buildPermissionTree, parsePermission } = require('./permission-parser');
const cache = require('./cache-provider'); // OBS 1: abstraction layer
const logger = require('../../utils/logger');

// ─── CACHE KEYS ───────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
const CATALOG_KEY  = '__permissions_catalog__';

function _cacheKey(userId, companyId) {
  return `${userId}:${companyId || 'global'}`;
}

function invalidateEffectivePermissions(userId) {
  const count = cache.clearByPrefix(`${userId}:`);
  cache.delete(CATALOG_KEY); // refresh catalog too
  logger.info(`[PERM-ENGINE] cache invalidated for user=${userId} (${count} entries)`);
}

// ─── PERMISSIONS CATALOG ──────────────────────────────────────
// OBS 2: Load all permissions from DB for wildcard expansion

async function loadPermissionsCatalog() {
  const cached = cache.get(CATALOG_KEY);
  if (cached) return cached;
  const result = await query(
    `SELECT CONCAT(resource, '.', action) AS permission FROM permissions ORDER BY resource, action`
  );
  const catalog = result.rows.map(r => r.permission);
  cache.set(CATALOG_KEY, catalog, CACHE_TTL_MS);
  return catalog;
}

// ─── WILDCARD HELPERS ─────────────────────────────────────────

function isWildcard(perm) {
  return perm.endsWith('.*') || perm === '*';
}

function wildcardCovers(wildcard, specific) {
  if (wildcard === '*') return true;
  if (!wildcard.endsWith('.*')) return false;
  const prefix = wildcard.slice(0, -2);
  return specific === prefix || specific.startsWith(`${prefix}.`);
}

/**
 * OBS 1: Expand wildcard permissions against the permissions catalog
 */
function expandWildcards(wildcardPerms, catalog) {
  const expanded = new Set();
  for (const wp of wildcardPerms) {
    if (wp === '*') {
      catalog.forEach(p => expanded.add(p));
    } else {
      catalog.filter(p => wildcardCovers(wp, p)).forEach(p => expanded.add(p));
    }
  }
  return [...expanded];
}

/**
 * OBS 3: Check if a permission is denied
 * Supports BOTH: effect='deny' column AND legacy !permission strings
 */
function isDenied(denyRules, permission) {
  for (const deny of denyRules) {
    const denyTarget = deny.startsWith('!') ? deny.slice(1) : deny;
    if (denyTarget === permission) return true;
    if (wildcardCovers(denyTarget, permission)) return true;
  }
  return false;
}

// ─── CORE ENGINE ──────────────────────────────────────────────

async function getEffectivePermissions(userId, companyId = null) {
  const cached = cache.get(_cacheKey(userId, companyId));
  if (cached) return cached;

  const startMs = Date.now();

  // ── Step 1: User roles ────────────────────────────────────
  const rolesResult = await query(`
    SELECT r.id, r.name, r.risk_tier, r.approval_limit,
           ur.company_id AS role_company_id
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = $1
      AND ur.is_active = TRUE
      AND (ur.company_id IS NULL OR ur.company_id = $2 OR $2::integer IS NULL)
    ORDER BY r.risk_tier ASC
  `, [userId, companyId ? parseInt(companyId) : null]);

  const roles = rolesResult.rows;
  const roleNames = roles.map(r => r.name);

  // ── Step 2: super_admin bypass ────────────────────────────
  if (roleNames.includes('super_admin')) {
    const catalog = await loadPermissionsCatalog();
    const result = {
      user_id: userId, company_id: companyId,
      is_super_admin: true, roles: roleNames,
      permissions: ['*'], denied_permissions: [],
      wildcard_permissions: ['*'],
      effective_permissions: ['*'],
      expanded_permissions: catalog,
      permission_groups: { '*': catalog },
      permission_tree: { '*': true },
      permission_summary: buildPermissionSummary(catalog, [], ['*']),
      approval_authority: [],
      computed_at: new Date().toISOString(),
      computation_ms: Date.now() - startMs
    };
    cache.set(_cacheKey(userId, companyId), result, CACHE_TTL_MS);
    return result;
  }

  // ── Step 3: Load permissions from DB ─────────────────────
  const roleIds = roles.map(r => r.id);
  const allowPerms = new Set();
  const denyPerms = new Set();
  const wildcardPerms = new Set();

  if (roleIds.length > 0) {
    // OBS 3: Support effect='deny' column + legacy !permission strings
    const permResult = await query(`
      SELECT DISTINCT CONCAT(p.resource, '.', p.action) AS permission,
             COALESCE(rp.effect, 'allow') AS effect
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ANY($1)
    `, [roleIds]);

    permResult.rows.forEach(r => {
      const perm = r.permission;
      const isDenyRule = r.effect === 'deny' || perm.startsWith('!');
      const cleanPerm = perm.startsWith('!') ? perm.slice(1) : perm;

      if (isDenyRule) {
        denyPerms.add(cleanPerm); // store without ! prefix
      } else if (isWildcard(cleanPerm)) {
        wildcardPerms.add(cleanPerm);
        allowPerms.add(cleanPerm);
      } else {
        allowPerms.add(cleanPerm);
      }
    });
  }

  // ── Step 4: Company access check ─────────────────────────
  let hasCompanyAccess = true;
  let companyAccessLevel = null;

  if (companyId) {
    const accessResult = await query(`
      SELECT access_level FROM user_company_access
      WHERE user_id = $1 AND company_id = $2 AND is_active = TRUE LIMIT 1
    `, [userId, parseInt(companyId)]);

    if (!accessResult.rows[0]) {
      hasCompanyAccess = false;
    } else {
      companyAccessLevel = accessResult.rows[0].access_level;
      if (companyAccessLevel === 'restricted') {
        const result = {
          user_id: userId, company_id: companyId,
          is_super_admin: false, roles: roleNames,
          permissions: [], denied_permissions: [...denyPerms],
          wildcard_permissions: [], effective_permissions: [],
          expanded_permissions: [],
          company_access_level: 'restricted',
          approval_authority: [],
          computed_at: new Date().toISOString(),
          computation_ms: Date.now() - startMs
        };
        cache.set(_cacheKey(userId, companyId), result, CACHE_TTL_MS);
        return result;
      }
    }
  }

  // ── Step 5: DENY WINS — build effective set ───────────────
  const effectiveSet = new Set();
  const deniedList = [];

  for (const perm of allowPerms) {
    if (isDenied(denyPerms, perm)) {
      deniedList.push(perm);
    } else {
      effectiveSet.add(perm);
    }
  }

  // ── Step 6: OBS 1 — Expand wildcards against catalog ─────
  const catalog = await loadPermissionsCatalog();
  const expandedSet = new Set();

  for (const perm of effectiveSet) {
    if (isWildcard(perm)) {
      const expanded = expandWildcards([perm], catalog);
      // Only add expanded if not denied
      expanded.forEach(ep => {
        if (!isDenied(denyPerms, ep)) expandedSet.add(ep);
      });
    }
  }
  // Also add non-wildcard effective permissions to expanded
  for (const perm of effectiveSet) {
    if (!isWildcard(perm)) expandedSet.add(perm);
  }

  // ── Step 7: Approval authority ────────────────────────────
  const approvalResult = companyId ? await query(`
    SELECT module, approval_limit, requires_secondary_approval, secondary_approver_id
    FROM approval_authority
    WHERE user_id = $1 AND company_id = $2 AND is_active = TRUE
    ORDER BY module ASC
  `, [userId, parseInt(companyId)]) : { rows: [] };

  const expandedList = [...expandedSet].sort();
  const permissionGroups = groupPermissionsByResource(expandedList);
  const permissionSummary = buildPermissionSummary(
    [...effectiveSet], [...denyPerms], [...wildcardPerms]
  );

  const result = {
    user_id: userId,
    company_id: companyId,
    is_super_admin: false,
    has_company_access: hasCompanyAccess,
    company_access_level: companyAccessLevel,
    roles: roleNames,
    permissions: [...allowPerms],
    denied_permissions: [...denyPerms],
    wildcard_permissions: [...wildcardPerms],
    effective_permissions: [...effectiveSet],
    expanded_permissions: expandedList,         // OBS 1: full expansion
    permission_groups: permissionGroups,
    permission_tree: buildPermissionTree(expandedList),   // OBS 2: tree for matrix UI
    permission_summary: permissionSummary,
    approval_authority: approvalResult.rows,
    computed_at: new Date().toISOString(),
    computation_ms: Date.now() - startMs
  };

  cache.set(_cacheKey(userId, companyId), result, CACHE_TTL_MS);
  return result;
}

/**
 * Check if user has a specific permission (with policy context hook)
 */
async function checkPermission(userId, companyId, permission) {
  const effective = await getEffectivePermissions(userId, companyId);

  if (effective.is_super_admin) return true;
  if (!effective.has_company_access) return false;

  const perms = effective.effective_permissions;

  // Global wildcard
  if (perms.includes('*')) return true;

  // Exact match
  if (perms.includes(permission)) return true;

  // Wildcard match
  for (const p of perms) {
    if (isWildcard(p) && wildcardCovers(p, permission)) return true;
  }

  // Use parsePermission for semantic consistency (centralized parsing)
  const parsed = parsePermission(permission);

  const policyResult = await evaluatePolicyContext({
    user: { id: userId }, permission,
    resource: parsed.resource,
    action: parsed.action || parsed.domain,
    scope: parsed.scope,
    companyId, metadata: {}
  });

  // Authoritative check — when ABAC is ready, policy can override RBAC
  if (policyResult.authoritative === true) {
    return policyResult.allowed;
  }

  return false;
}

module.exports = {
  getEffectivePermissions,
  checkPermission,
  invalidateEffectivePermissions,
  isDenied,
  wildcardCovers,
  isWildcard,
  expandWildcards
};
