'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { iamSensitiveLimiter } = require('../middleware/iamRateLimit');
const { getEffectivePermissions, invalidateEffectivePermissions } = require('../lib/iam/effective-permissions');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const logger = require('../utils/logger');

router.use(verifyToken);

// Only admin/super_admin can manage IAM
const IAM_ADMIN_ROLES = ['admin', 'super_admin'];

/**
 * MULTI-ROLE MIGRATION ARCHITECTURE
 * ──────────────────────────────────
 * CURRENT STATE (Phase 1):
 *   - JWT embeds a single legacy role: { role: 'admin' }
 *   - users.role column is authoritative
 *   - user_roles table exists but is NOT yet used for auth decisions
 *
 * FUTURE STATE (Phase 2 — after IAM UI ships):
 *   - verifyToken middleware will hydrate roles from user_roles table
 *   - req.user.roles[] will become authoritative (array of role names)
 *   - users.role will become compatibility-only fallback
 *   - JWT payload will include roles[] array
 *
 * MIGRATION PATH:
 *   Step 1: Ship IAM UI → users assigned proper user_roles in DB ✅
 *   Step 2: Update verifyToken to hydrate user_roles → req.user.roles[]
 *   Step 3: Deprecate users.role column (keep for backward compat)
 *   Step 4: Remove legacy role from JWT payload
 *
 * TODO: Hydrate user_roles from DB into req.user.roles[] inside
 *       verifyToken middleware after frontend IAM migration is complete.
 *       Query: SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id
 *              WHERE ur.user_id=$1 AND ur.is_active=TRUE
 */

// OBS 3: Future multi-role JWT compatibility helper
// Supports both legacy single-role (user.role) and future multi-role (user.roles[])
function getEffectiveRoles(user) {
  return user.roles?.length
    ? user.roles
    : user.role
    ? [user.role]
    : [];
}

function assertIamAdmin(req, res) {
  if (!getEffectiveRoles(req.user).some(r => IAM_ADMIN_ROLES.includes(r))) {
    res.status(403).json({ success: false, error: 'forbidden', message: 'IAM management requires admin or super_admin role.' });
    return false;
  }
  return true;
}

// ISSUE 4A: Prevent removing the last active super_admin
async function assertNotLastSuperAdmin(userId) {
  const result = await query(`
    SELECT COUNT(*) AS cnt
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE r.name = 'super_admin'
      AND ur.is_active = TRUE
      AND ur.user_id != $1
  `, [userId]);
  if (parseInt(result.rows[0].cnt) === 0) {
    const err = new Error('Cannot remove the last active super_admin. Assign another super_admin first.');
    err.code = 'LAST_SUPER_ADMIN';
    throw err;
  }
}

// ISSUE 4B: Prevent user from orphaning their own admin access
async function assertNotLastAdminRole(userId, roleId) {
  // Check remaining active admin-capable roles after removal
  const remaining = await query(`
    SELECT COUNT(*) AS cnt
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = $1
      AND ur.role_id != $2
      AND ur.is_active = TRUE
      AND r.name = ANY($3)
  `, [userId, parseInt(roleId), IAM_ADMIN_ROLES]);

  if (parseInt(remaining.rows[0].cnt) === 0) {
    // Check if removing role would leave them with no admin roles
    const currentAdminRoles = await query(`
      SELECT COUNT(*) AS cnt
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
        AND ur.is_active = TRUE
        AND r.name = ANY($2)
    `, [userId, IAM_ADMIN_ROLES]);

    if (parseInt(currentAdminRoles.rows[0].cnt) <= 1) {
      const err = new Error('Cannot remove your only admin role. Assign another admin role first.');
      err.code = 'LAST_ADMIN_ROLE';
      throw err;
    }
  }
}

function getAuthorizedCompanyId(user, queryCompanyId) {
  const roles = getEffectiveRoles(user);
  // ONLY super_admin has global bypass — admins are strictly company-scoped
  if (roles.includes('super_admin')) return queryCompanyId ? parseInt(queryCompanyId) : null;
  // ALL other roles (including admin) are strictly company-scoped
  return parseInt(user.active_company_id || user.company_id || user.companyId);
}

// ─── GET /api/iam/roles ───────────────────────────────────────
router.get('/roles', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const result = await query(`
      SELECT r.*,
        COUNT(DISTINCT rp.permission_id) AS permission_count,
        COUNT(DISTINCT ur.user_id) AS user_count
      FROM roles r
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      LEFT JOIN user_roles ur ON ur.role_id = r.id AND ur.is_active = TRUE
      WHERE r.is_active = TRUE
      GROUP BY r.id
      ORDER BY r.risk_tier ASC, r.name ASC
    `);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/iam/roles/:id/permissions ──────────────────────
router.get('/roles/:id/permissions', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const result = await query(`
      SELECT p.id, p.resource, p.action, p.description
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1
      ORDER BY p.resource, p.action
    `, [parseInt(req.params.id)]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/iam/permissions ─────────────────────────────────
router.get('/permissions', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const result = await query(`
      SELECT id, resource, action, description
      FROM permissions
      ORDER BY resource, action
    `);

    // Group by resource for UI
    const grouped = {};
    for (const p of result.rows) {
      if (!grouped[p.resource]) grouped[p.resource] = [];
      grouped[p.resource].push(p);
    }

    res.json({ success: true, count: result.rows.length, data: result.rows, grouped });
  } catch (error) { next(error); }
});

// ─── PUT /api/iam/roles/:id/permissions ──────────────────────
router.put('/roles/:id/permissions', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const roleId = parseInt(req.params.id);
    const { permission_ids } = req.body;

    if (!Array.isArray(permission_ids)) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'permission_ids must be an array.' });
    }

    // Check not modifying super_admin system role without super_admin
    const role = await query(`SELECT name, is_system_role FROM roles WHERE id = $1`, [roleId]);
    if (!role.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    if (role.rows[0].name === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Only super_admin can modify super_admin permissions.' });
    }

    await withTransaction(async (client) => {
      await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
      if (permission_ids.length > 0) {
        const values = permission_ids.map((pid, i) => `($1, $${i + 2})`).join(',');
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES ${values} ON CONFLICT DO NOTHING`,
          [roleId, ...permission_ids]
        );
      }
    });

    writeAudit({
      userId: req.user.id, action: 'role_permissions_updated',
      entityType: 'roles', entityId: roleId,
      newValues: { permission_ids },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Role permissions updated.' });
  } catch (error) { next(error); }
});

// ─── GET /api/iam/users ───────────────────────────────────────
router.get('/users', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const { status, search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    const values = [];
    let idx = 1;

    // FIX: Include users that have company_id OR have company_access to authorized company
    if (authorizedCompanyId) {
      conditions.push(`(u.company_id = $${idx} OR EXISTS (
        SELECT 1 FROM user_company_access uca2
        WHERE uca2.user_id = u.id AND uca2.company_id = $${idx} AND uca2.is_active = TRUE
      ))`);
      values.push(authorizedCompanyId); idx++;
    }
    if (status) { conditions.push(`u.status = $${idx++}`); values.push(status); }
    if (search) {
      conditions.push(`(CONCAT(u.first_name,' ',u.last_name) ILIKE $${idx} OR u.email ILIKE $${idx})`);
      values.push(`%${search}%`); idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT u.id, u.email,
        u.first_name, u.last_name,
        CONCAT(u.first_name,' ',u.last_name) AS full_name,
        u.phone,
        u.role AS legacy_role, u.status, u.company_id, u.last_login_at,
        u.two_fa_enabled, u.created_at,
        c.name AS company_name,
        COALESCE(
          ARRAY_AGG(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL AND ur.is_active = TRUE),
          ARRAY[]::text[]
        ) AS roles,
        COUNT(DISTINCT uca.company_id) AS company_access_count
      FROM users u
      LEFT JOIN companies c ON c.id = u.company_id
      LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.is_active = TRUE
      LEFT JOIN roles r ON r.id = ur.role_id
      LEFT JOIN user_company_access uca ON uca.user_id = u.id AND uca.is_active = TRUE
      ${where}
      GROUP BY u.id, c.name
      ORDER BY u.created_at DESC
      LIMIT $${idx} OFFSET $${idx+1}
    `, [...values, parseInt(limit), offset]);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── PATCH /api/iam/users/:id ────────────────────────────────
router.patch('/users/:id', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const targetId = req.params.id;
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);

    // Fetch current user
    const current = await query(`SELECT id, email, status, company_id, role FROM users WHERE id = $1`, [targetId]);
    if (!current.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const target = current.rows[0];

    // Company isolation — non-super_admin cannot edit across companies
    if (authorizedCompanyId && target.company_id !== authorizedCompanyId) {
      return res.status(403).json({ success: false, error: 'forbidden',
        message: 'You can only edit users in your company.' });
    }

    const { first_name, last_name, phone, status, must_change_password, email } = req.body;

    // Allowed fields only
    const VALID_STATUSES = ['active','inactive'];
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    // Safety: prevent super_admin corruption
    if (target.role === 'super_admin' && !getEffectiveRoles(req.user).includes('super_admin')) {
      return res.status(403).json({ success: false, error: 'forbidden',
        message: 'Only super_admin can edit another super_admin.' });
    }

    // Email uniqueness check
    if (email && email.toLowerCase() !== target.email) {
      const emailCheck = await query(`SELECT id FROM users WHERE email = $1 AND id != $2`,
        [email.toLowerCase(), targetId]);
      if (emailCheck.rows[0]) {
        return res.status(409).json({ success: false, error: 'email_exists',
          message: 'Email already registered to another user.' });
      }
    }

    // Build dynamic update
    const setClauses = [];
    const values = [];
    let idx = 1;

    const allowed = { first_name, last_name, phone, status, must_change_password,
                      email: email ? email.toLowerCase() : undefined };

    for (const [field, val] of Object.entries(allowed)) {
      if (val !== undefined) {
        setClauses.push(`${field} = $${idx++}`);
        values.push(val);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, error: 'no_fields', message: 'No valid fields to update.' });
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(targetId);

    const result = await query(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING id, email, first_name, last_name, phone, status, role, company_id, updated_at`,
      values
    );

    writeAudit({
      userId: req.user.id, action: 'user_updated',
      entityType: 'users', entityId: targetId,
      companyId: authorizedCompanyId || target.company_id,
      oldValues: { email: target.email, status: target.status },
      newValues: req.body,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[IAM] user updated: ${targetId} by=${req.user.id}`);
    res.json({ success: true, message: 'User updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /api/iam/users ──────────────────────────────────────
router.post('/users', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const {
      email, password, first_name, last_name, phone,
      company_id, role = 'operative', role_ids = [],
      must_change_password = true
    } = req.body;

    if (!email || !password || !first_name || !last_name) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: email, password, first_name, last_name' });
    }

    // GOVERNANCE FIX: company_id required for ALL users including super_admin
    // super_admin bypasses SCOPE restrictions only — NOT data integrity
    if (!company_id) {
      return res.status(400).json({ success: false, error: 'company_required',
        message: 'company_id is required. All users including super_admin must belong to a company.' });
    }

    // Validate company exists
    if (company_id) {
      const companyCheck = await query(`SELECT id FROM companies WHERE id = $1`, [parseInt(company_id)]);
      if (!companyCheck.rows[0]) {
        return res.status(400).json({ success: false, error: 'company_not_found',
          message: `Company ${company_id} not found.` });
      }
    }

    // Check email unique
    const exists = await query(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
    if (exists.rows[0]) {
      return res.status(409).json({ success: false, error: 'email_exists', message: 'Email already registered.' });
    }

    const result = await withTransaction(async (client) => {
      const password_hash = await bcrypt.hash(password, 10);

      const user = await client.query(`
        INSERT INTO users (email, password_hash, first_name, last_name, phone,
          company_id, role, must_change_password, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active') RETURNING id, email, role, company_id, created_at
      `, [email.toLowerCase(), password_hash, first_name, last_name,
          phone||null, company_id ? parseInt(company_id) : null,
          role, must_change_password]);

      const userId = user.rows[0].id;

      // Assign roles — guaranteed atomic
      const allRoleIds = [...new Set(role_ids)];
      if (allRoleIds.length === 0) {
        const defaultRole = await client.query(`SELECT id FROM roles WHERE name = $1`, [role]);
        if (defaultRole.rows[0]) allRoleIds.push(defaultRole.rows[0].id);
      }

      for (const roleId of allRoleIds) {
        await client.query(`
          INSERT INTO user_roles (user_id, role_id, company_id, assigned_by)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
        `, [userId, parseInt(roleId), company_id ? parseInt(company_id) : null, req.user.id]);
      }

      // GOVERNANCE FIX: company access — MANDATORY, not optional
      // If this fails, the entire transaction rolls back
      if (company_id) {
        await client.query(`
          INSERT INTO user_company_access (user_id, company_id, access_level, assigned_by)
          VALUES ($1,$2,'full',$3)
          ON CONFLICT (user_id, company_id) DO UPDATE SET
            is_active = TRUE, revoked_at = NULL, access_level = 'full', assigned_by = $3
        `, [userId, parseInt(company_id), req.user.id]);
      }

      // Post-create verification — if any governance record missing, rollback
      const verifyUser = await client.query(`SELECT id FROM users WHERE id = $1`, [userId]);
      if (!verifyUser.rows[0]) throw new Error('User creation verification failed.');

      if (company_id) {
        const verifyAccess = await client.query(
          `SELECT id FROM user_company_access WHERE user_id = $1 AND company_id = $2 AND is_active = TRUE`,
          [userId, parseInt(company_id)]
        );
        if (!verifyAccess.rows[0]) throw new Error('Company access assignment failed — rolling back.');
      }

      return user.rows[0];
    });

    writeAudit({
      userId: req.user.id, action: 'user_created',
      entityType: 'users', entityId: result.id,
      companyId: company_id ? parseInt(company_id) : null,
      newValues: { email, role, role_ids, company_id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[IAM] user created: ${email} company=${company_id} by=${req.user.id}`);
    res.status(201).json({ success: true, message: 'User created.', data: result });
  } catch (error) { next(error); }
});

// ─── POST /api/iam/users/:id/roles ───────────────────────────
router.post('/users/:id/roles', iamSensitiveLimiter, async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const userId = req.params.id;
    const { role_id, company_id } = req.body;

    if (!role_id) return res.status(400).json({ success: false, error: 'validation_error', message: 'role_id required.' });

    await query(`
      INSERT INTO user_roles (user_id, role_id, company_id, assigned_by)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id, role_id, company_id) DO UPDATE SET
        is_active = TRUE, revoked_at = NULL, assigned_by = $4, assigned_at = NOW()
    `, [userId, parseInt(role_id), company_id ? parseInt(company_id) : null, req.user.id]);

    writeAudit({
      userId: req.user.id, action: 'role_assigned',
      entityType: 'user_roles', entityId: null,
      newValues: { user_id: userId, role_id, company_id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    invalidateEffectivePermissions(userId);
    res.json({ success: true, message: 'Role assigned.' });
  } catch (error) { next(error); }
});

// ─── DELETE /api/iam/users/:id/roles/:roleId ─────────────────
router.delete('/users/:id/roles/:roleId', iamSensitiveLimiter, async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const targetUserId = req.params.id;
    const roleId = parseInt(req.params.roleId);

    // ISSUE 4A: Prevent removing last super_admin
    const roleCheck = await query(`SELECT name FROM roles WHERE id = $1`, [roleId]);
    if (roleCheck.rows[0]?.name === 'super_admin') {
      try {
        await assertNotLastSuperAdmin(targetUserId);
      } catch (err) {
        if (err.code === 'LAST_SUPER_ADMIN') {
          return res.status(400).json({ success: false, error: 'last_super_admin', message: err.message });
        }
        throw err;
      }
    }

    // ISSUE 4B: Prevent self-lockout of admin access
    if (req.user.id === targetUserId && IAM_ADMIN_ROLES.includes(req.user.role)) {
      try {
        await assertNotLastAdminRole(targetUserId, roleId);
      } catch (err) {
        if (err.code === 'LAST_ADMIN_ROLE') {
          return res.status(400).json({ success: false, error: 'last_admin_role', message: err.message });
        }
        throw err;
      }
    }

    await query(`
      UPDATE user_roles SET is_active = FALSE, revoked_at = NOW()
      WHERE user_id = $1 AND role_id = $2
    `, [targetUserId, roleId]);

    writeAudit({
      userId: req.user.id, action: 'role_revoked',
      entityType: 'user_roles', entityId: null,
      newValues: { user_id: targetUserId, role_id: roleId },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Role revoked.' });
    invalidateEffectivePermissions(targetUserId);
  } catch (error) { next(error); }
});

// ─── GET /api/iam/users/:id/roles ────────────────────────────
router.get('/users/:id/roles', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const result = await query(`
      SELECT ur.*, r.name AS role_name, r.description, r.risk_tier,
        c.name AS company_name,
        CONCAT(u.first_name,' ',u.last_name) AS assigned_by_name
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      LEFT JOIN companies c ON c.id = ur.company_id
      LEFT JOIN users u ON u.id = ur.assigned_by
      WHERE ur.user_id = $1 AND ur.is_active = TRUE
      ORDER BY r.risk_tier ASC
    `, [req.params.id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/iam/users/:id/company-access ───────────────────
router.get('/users/:id/company-access', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const result = await query(`
      SELECT uca.id, uca.user_id, uca.company_id, uca.access_level,
        uca.created_at AS granted_at, uca.is_active,
        c.name AS company_name, c.country,
        CONCAT(u.first_name,' ',u.last_name) AS granted_by_name
      FROM user_company_access uca
      JOIN companies c ON c.id = uca.company_id
      LEFT JOIN users u ON u.id = uca.assigned_by
      WHERE uca.user_id = $1 AND uca.is_active = TRUE
      ORDER BY c.name ASC
    `, [req.params.id]);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── DELETE /api/iam/users/:id/company-access/:companyId ─────
router.delete('/users/:id/company-access/:companyId', iamSensitiveLimiter, async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const userId = req.params.id;
    const companyId = parseInt(req.params.companyId);

    // Verify record exists
    const check = await query(
      `SELECT id FROM user_company_access WHERE user_id = $1 AND company_id = $2 AND is_active = TRUE`,
      [userId, companyId]
    );
    if (!check.rows[0]) {
      return res.status(404).json({ success: false, error: 'not_found',
        message: 'Company access record not found.' });
    }

    await query(`
      UPDATE user_company_access SET is_active = FALSE, revoked_at = NOW()
      WHERE user_id = $1 AND company_id = $2
    `, [userId, companyId]);

    writeAudit({
      userId: req.user.id, action: 'company_access_revoked',
      entityType: 'user_company_access', entityId: check.rows[0].id,
      companyId,
      newValues: { user_id: userId, company_id: companyId },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[IAM] company access revoked: user=${userId} company=${companyId} by=${req.user.id}`);
    res.json({ success: true, message: 'Company access revoked.' });
  } catch (error) { next(error); }
});

// ─── POST /api/iam/users/:id/company-access ──────────────────
router.post('/users/:id/company-access', iamSensitiveLimiter, async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const userId = req.params.id;
    const { company_id, access_level = 'standard' } = req.body;

    if (!company_id) return res.status(400).json({ success: false, error: 'validation_error', message: 'company_id required.' });

    const VALID_LEVELS = ['read_only','standard','elevated','full'];
    if (!VALID_LEVELS.includes(access_level)) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: `access_level must be one of: ${VALID_LEVELS.join(', ')}` });
    }

    const companyCheck = await query(`SELECT id, name FROM companies WHERE id = $1`, [parseInt(company_id)]);
    if (!companyCheck.rows[0]) return res.status(404).json({ success: false, error: 'company_not_found' });

    const userCheck = await query(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (!userCheck.rows[0]) return res.status(404).json({ success: false, error: 'user_not_found' });

    const result = await query(`
      INSERT INTO user_company_access (user_id, company_id, access_level, assigned_by)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id, company_id) DO UPDATE SET
        access_level = $3, is_active = TRUE, revoked_at = NULL, assigned_by = $4
      RETURNING *
    `, [userId, parseInt(company_id), access_level, req.user.id]);

    writeAudit({
      userId: req.user.id, action: 'company_access_granted',
      entityType: 'user_company_access', entityId: result.rows[0].id,
      companyId: parseInt(company_id),
      newValues: { user_id: userId, company_id, access_level,
                   company_name: companyCheck.rows[0].name },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[IAM] company access granted: user=${userId} company=${company_id} level=${access_level} by=${req.user.id}`);
    res.status(201).json({
      success: true, message: 'Company access granted.',
      data: { ...result.rows[0], company_name: companyCheck.rows[0].name }
    });
  } catch (error) { next(error); }
});

// ─── POST /api/iam/users/:id/reset-password ──────────────────
router.post('/users/:id/reset-password', iamSensitiveLimiter, async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Password must be at least 8 characters.' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await query(`
      UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = NOW()
      WHERE id = $2
    `, [hash, req.params.id]);

    // Revoke all refresh tokens
    await query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [req.params.id]);

    // OBS 2: Also revoke all active user_sessions for full session consistency
    await query(`UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [req.params.id]);

    writeAudit({
      userId: req.user.id, action: 'password_reset',
      entityType: 'users', entityId: req.params.id,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[IAM] password reset for user=${req.params.id} by admin=${req.user.id}`);
    res.json({ success: true, message: 'Password reset. User must change on next login.' });
  } catch (error) { next(error); }
});

// ─── PATCH /api/iam/users/:id/deactivate ─────────────────────
router.patch('/users/:id/deactivate', iamSensitiveLimiter, async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ success: false, error: 'self_deactivation', message: 'Cannot deactivate your own account.' });
    }

    // ISSUE 4A: Block if target is last super_admin
    const isSuperAdmin = await query(`
      SELECT COUNT(*) AS cnt FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.name = 'super_admin' AND ur.is_active = TRUE
    `, [req.params.id]);

    if (parseInt(isSuperAdmin.rows[0].cnt) > 0) {
      try {
        await assertNotLastSuperAdmin(req.params.id);
      } catch (err) {
        if (err.code === 'LAST_SUPER_ADMIN') {
          return res.status(400).json({ success: false, error: 'last_super_admin', message: err.message });
        }
        throw err;
      }
    }

    await withTransaction(async (client) => {
      await client.query(`UPDATE users SET status = 'inactive', updated_at = NOW() WHERE id = $1`, [req.params.id]);
      await client.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [req.params.id]);

      const revokedRoles = await client.query(
        `UPDATE user_roles SET is_active = FALSE, revoked_at = NOW() WHERE user_id = $1 AND is_active = TRUE RETURNING id`,
        [req.params.id]
      );

      // ISSUE 3: Also revoke company access + approval authority
      const revokedAccess = await client.query(
        `UPDATE user_company_access SET is_active = FALSE, revoked_at = NOW() WHERE user_id = $1 AND is_active = TRUE RETURNING id`,
        [req.params.id]
      );
      const revokedApprovals = await client.query(
        `UPDATE approval_authority SET is_active = FALSE, updated_at = NOW() WHERE user_id = $1 AND is_active = TRUE RETURNING id`,
        [req.params.id]
      );

      writeAudit({
        userId: req.user.id, action: 'user_deactivated',
        entityType: 'users', entityId: req.params.id,
        companyId: req.user.company_id,
        newValues: {
          revoked_roles_count: revokedRoles.rows.length,
          revoked_company_access_count: revokedAccess.rows.length,
          revoked_approval_authority_count: revokedApprovals.rows.length
        },
        ip: req.ip, userAgent: req.get('user-agent')
      }).catch(() => {});
    });

    res.json({ success: true, message: 'User deactivated.' });
  } catch (error) { next(error); }
});

// ─── GET /api/iam/audit-logs ──────────────────────────────────
router.get('/audit-logs', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const { action, entity_type, user_id, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`al.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (action)      { conditions.push(`al.action = $${idx++}`); values.push(action); }
    if (entity_type) { conditions.push(`al.entity_type = $${idx++}`); values.push(entity_type); }
    if (user_id)     { conditions.push(`al.actor_user_id = $${idx++}`); values.push(user_id); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT al.*,
        CONCAT(u.first_name,' ',u.last_name) AS actor_name,
        u.email AS actor_email
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_user_id
      ${where}
      ORDER BY al.created_at DESC
      LIMIT $${idx} OFFSET $${idx+1}
    `, [...values, parseInt(limit), offset]);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/iam/approval-authority ─────────────────────────
router.get('/approval-authority', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = ['aa.is_active = TRUE'];
    const values = [];
    let idx = 1;
    if (authorizedCompanyId) { conditions.push(`aa.company_id = $${idx++}`); values.push(authorizedCompanyId); }

    const result = await query(`
      SELECT aa.*,
        CONCAT(u.first_name,' ',u.last_name) AS user_name,
        CONCAT(s.first_name,' ',s.last_name) AS secondary_approver_name
      FROM approval_authority aa
      JOIN users u ON u.id = aa.user_id
      LEFT JOIN users s ON s.id = aa.secondary_approver_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY aa.module, aa.approval_limit DESC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── POST /api/iam/approval-authority ────────────────────────
router.post('/approval-authority', iamSensitiveLimiter, async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const { user_id, company_id, module, approval_limit,
            requires_secondary_approval = false, secondary_approver_id } = req.body;

    if (!user_id || !company_id || !module) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: user_id, company_id, module' });
    }

    const result = await query(`
      INSERT INTO approval_authority (
        user_id, company_id, module, approval_limit,
        requires_secondary_approval, secondary_approver_id
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (user_id, company_id, module) DO UPDATE SET
        approval_limit = $4,
        requires_secondary_approval = $5,
        secondary_approver_id = $6,
        is_active = TRUE, updated_at = NOW()
      RETURNING *
    `, [user_id, parseInt(company_id), module,
        approval_limit ? parseFloat(approval_limit) : null,
        requires_secondary_approval,
        secondary_approver_id || null]);

    // OBS 1: Audit governance-critical approval authority changes
    writeAudit({
      userId: req.user.id, action: 'approval_authority_updated',
      entityType: 'approval_authority', entityId: result.rows[0].id,
      companyId: parseInt(company_id),
      newValues: {
        user_id, module,
        approval_limit: approval_limit || null,
        requires_secondary_approval,
        secondary_approver_id: secondary_approver_id || null
      },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[IAM] approval authority set: user=${user_id} module=${module} limit=${approval_limit} by=${req.user.id}`);

    res.status(201).json({ success: true, message: 'Approval authority set.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── PATCH /api/iam/users/:id/reactivate ─────────────────────
// ISSUE 4: Reactivate user — does NOT restore governance grants
router.patch('/users/:id/reactivate', iamSensitiveLimiter, async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const userId = req.params.id;

    const userCheck = await query(`SELECT id, status, role FROM users WHERE id = $1`, [userId]);
    if (!userCheck.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    if (userCheck.rows[0].status === 'active') {
      return res.status(400).json({ success: false, error: 'already_active', message: 'User is already active.' });
    }

    // Reactivate user status only
    // IMPORTANT: Do NOT restore roles, company access, or approval authority
    // Governance grants must be explicitly reassigned (least-privilege principle)
    await query(`UPDATE users SET status = 'active', updated_at = NOW() WHERE id = $1`, [userId]);

    writeAudit({
      userId: req.user.id, action: 'user_reactivated',
      entityType: 'users', entityId: userId,
      companyId: req.user.company_id,
      newValues: { previous_status: userCheck.rows[0].status },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[IAM] user reactivated: user=${userId} by=${req.user.id}`);
    res.json({
      success: true,
      message: 'User reactivated. Roles and company access must be reassigned manually.'
    });
  } catch (error) { next(error); }
});

// ─── GET /api/iam/sessions ────────────────────────────────────
// ISSUE 1: Company-scoped session visibility
router.get('/sessions', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const { user_id } = req.query;
    const conditions = ['us.revoked_at IS NULL'];
    const values = [];
    let idx = 1;

    if (user_id) { conditions.push(`us.user_id = $${idx++}`); values.push(user_id); }

    // ISSUE 1: Filter by company — super_admin sees all, company admin sees own
    if (authorizedCompanyId) {
      conditions.push(`u.company_id = $${idx++}`);
      values.push(authorizedCompanyId);
    }

    const result = await query(`
      SELECT us.*,
        CONCAT(u.first_name,' ',u.last_name) AS user_name,
        u.email, u.company_id
      FROM user_sessions us
      JOIN users u ON u.id = us.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY us.last_activity_at DESC
      LIMIT 100
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── DELETE /api/iam/sessions/:id ────────────────────────────
// ISSUE 2: Company-scoped session revocation + audit
router.delete('/sessions/:id', async (req, res, next) => {
  if (!assertIamAdmin(req, res)) return;
  try {
    const sessionId = parseInt(req.params.id);
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);

    // Fetch session + owner company
    const sessionCheck = await query(`
      SELECT us.id, us.user_id, u.company_id
      FROM user_sessions us
      JOIN users u ON u.id = us.user_id
      WHERE us.id = $1 AND us.revoked_at IS NULL
    `, [sessionId]);

    if (!sessionCheck.rows[0]) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Session not found or already revoked.' });
    }

    const session = sessionCheck.rows[0];

    // ISSUE 2: Company governance check
    if (authorizedCompanyId && session.company_id !== authorizedCompanyId) {
      return res.status(403).json({
        success: false, error: 'permission_denied',
        message: 'You can only revoke sessions belonging to users in your company.'
      });
    }

    await query(`UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1`, [sessionId]);

    writeAudit({
      userId: req.user.id, action: 'session_revoked',
      entityType: 'user_sessions', entityId: sessionId,
      companyId: session.company_id,
      newValues: { revoked_session_id: sessionId, target_user_id: session.user_id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[IAM] session revoked: session=${sessionId} user=${session.user_id} by=${req.user.id}`);
    res.json({ success: true, message: 'Session revoked.' });
  } catch (error) { next(error); }
});

// ─── GET /api/iam/users/:id/effective-permissions ────────────
router.get('/users/:id/effective-permissions', async (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'unauthorized' });
  try {
    const targetUserId = req.params.id;
    const roles = getEffectiveRoles(req.user);
    const isAdmin = roles.some(r => IAM_ADMIN_ROLES.includes(r));
    const isSelf = req.user.id === targetUserId;

    // Allow: admin/super_admin OR user viewing their own permissions
    if (!isAdmin && !isSelf) {
      return res.status(403).json({ success: false, error: 'permission_denied',
        message: 'You can only view your own permissions.' });
    }

    const authorizedCompanyId = isAdmin
      ? getAuthorizedCompanyId(req.user, req.query.company_id)
      : parseInt(req.user.active_company_id || req.user.company_id);

    // Defensive: regular users must have company context
    if (!authorizedCompanyId && !isAdmin) {
      return res.status(403).json({
        success: false, error: 'company_context_required',
        message: 'Active company context required.'
      });
    }

    // Company-scoped admins can only compute for users in their company
    // But users can always view their own permissions
    if (!isSelf && authorizedCompanyId) {
      const userCompany = await query(
        `SELECT company_id FROM users WHERE id = $1`, [targetUserId]
      );
      if (userCompany.rows[0]?.company_id !== authorizedCompanyId) {
        return res.status(403).json({
          success: false, error: 'permission_denied',
          message: 'You can only view permissions for users in your company.'
        });
      }
    }

    const effective = await getEffectivePermissions(targetUserId, authorizedCompanyId);

    // OBS 2: Compact mode — omit expanded_permissions for lightweight responses
    const compact = req.query.compact === 'true';
    const responseData = compact ? {
      user_id:            effective.user_id,
      company_id:         effective.company_id,
      is_super_admin:     effective.is_super_admin,
      roles:              effective.roles,
      effective_permissions: effective.effective_permissions,
      permission_summary: effective.permission_summary,
      permission_groups:  effective.permission_groups,
      denied_permissions: effective.denied_permissions,
      approval_authority: effective.approval_authority,
      computed_at:        effective.computed_at
    } : effective;

    // PART 8: Audit effective permission computation
    writeAudit({
      userId: req.user.id, action: 'effective_permissions_computed',
      entityType: 'users', entityId: targetUserId,
      companyId: authorizedCompanyId,
      newValues: {
        target_user_id: targetUserId,
        target_company_id: authorizedCompanyId,
        role_count: effective.roles?.length || 0,
        permission_count: effective.effective_permissions?.length || 0,
        deny_count: effective.denied_permissions?.length || 0,
        compact_mode: compact
      },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, data: responseData });
  } catch (error) { next(error); }
});

module.exports = router;
