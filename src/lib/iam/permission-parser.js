'use strict';

/**
 * Permission Parser — IAM Phase 2B
 * ──────────────────────────────────
 * Semantic normalization of permission strings.
 * Handles current 2-segment and future 3-4 segment formats.
 *
 * CURRENT FORMAT:    resource.action
 *   finance.view → { resource: 'finance', domain: 'view', action: null, scope: null }
 *
 * FUTURE FORMAT:     resource.domain.action.scope
 *   finance.approvals.execute.high_value →
 *     { resource: 'finance', domain: 'approvals', action: 'execute', scope: 'high_value' }
 *
 * WILDCARD SUPPORT:
 *   finance.*  → { resource: 'finance', domain: '*', action: null, scope: null, isWildcard: true }
 *   *          → { resource: '*', isGlobalWildcard: true }
 */

/**
 * Parse a permission string into semantic segments.
 *
 * @param {string} permission
 * @returns {{ raw, resource, domain, action, scope, segments,
 *             isWildcard, isGlobalWildcard, isDeny }}
 */
function parsePermission(permission) {
  if (!permission || typeof permission !== 'string') {
    return { raw: permission, resource: null, domain: null, action: null, scope: null,
             segments: [], isWildcard: false, isGlobalWildcard: false, isDeny: false };
  }

  // Detect deny prefix
  const isDeny = permission.startsWith('!');
  const clean = isDeny ? permission.slice(1) : permission;

  // Global wildcard
  if (clean === '*') {
    return { raw: permission, resource: '*', domain: null, action: null, scope: null,
             segments: ['*'], isWildcard: true, isGlobalWildcard: true, isDeny };
  }

  const segments = clean.split('.');

  const resource = segments[0] || null;
  const domain   = segments[1] || null;
  const action   = segments[2] || null;
  // Everything beyond index 2 is "scope" (joined for readability)
  const scope    = segments.length > 3 ? segments.slice(3).join('.') : null;

  // Detect namespace wildcard: finance.* or finance.treasury.*
  const isWildcard = domain === '*' || action === '*' ||
                     (segments.length >= 2 && segments[segments.length - 1] === '*');

  return {
    raw:             permission,
    clean,
    resource,
    domain,
    action,
    scope,
    segments,
    isWildcard,
    isGlobalWildcard: false,
    isDeny
  };
}

/**
 * Get the namespace prefix for wildcard matching.
 * finance.* → 'finance'
 * finance.treasury.* → 'finance.treasury'
 */
function getWildcardPrefix(permission) {
  const parsed = parsePermission(permission);
  if (parsed.isGlobalWildcard) return null;
  if (!parsed.isWildcard) return null;
  // Remove trailing .*
  return parsed.clean.endsWith('.*') ? parsed.clean.slice(0, -2) : null;
}

/**
 * Group a flat list of permissions by resource
 * e.g. ['finance.view', 'finance.export', 'treasury.view']
 * → { finance: ['finance.view', 'finance.export'], treasury: ['treasury.view'] }
 */
function groupPermissionsByResource(permissions) {
  const groups = {};
  for (const perm of permissions) {
    const { resource } = parsePermission(perm);
    if (!resource) continue;
    if (!groups[resource]) groups[resource] = [];
    groups[resource].push(perm);
  }
  return groups;
}

/**
 * Generate a compact permission summary
 */
function buildPermissionSummary(effectivePermissions, deniedPermissions, wildcardPermissions) {
  const groups = groupPermissionsByResource(effectivePermissions);
  return {
    total_permissions: effectivePermissions.length,
    wildcard_count:    wildcardPermissions.length,
    deny_count:        deniedPermissions.length,
    resources:         Object.keys(groups).length,
    resource_names:    Object.keys(groups).sort()
  };
}

/**
 * OBS 2: Build nested permission tree from flat permission list.
 * Optimized for matrix UI rendering — avoids repeated string parsing.
 *
 * Input:  ['finance.view', 'finance.export', 'treasury.approve_transfer']
 * Output: { finance: { view: true, export: true }, treasury: { approve_transfer: true } }
 *
 * Supports up to 4 segments: resource.domain.action.scope
 */
function buildPermissionTree(permissions) {
  const tree = {};
  for (const perm of permissions) {
    if (!perm || perm === '*') {
      tree['*'] = true;
      continue;
    }
    const segments = perm.replace(/^!/, '').split('.');
    let node = tree;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (i === segments.length - 1) {
        node[seg] = true;
      } else {
        if (!node[seg] || node[seg] === true) node[seg] = {};
        node = node[seg];
      }
    }
  }
  return tree;
}

module.exports = {
  parsePermission,
  getWildcardPrefix,
  groupPermissionsByResource,
  buildPermissionSummary,
  buildPermissionTree
};
