'use strict';

const { query, withTransaction } = require('../config/database');
const bcrypt = require('bcryptjs');
const { encrypt, decrypt } = require('../utils/encryption');

const SALT_ROUNDS = 10;

class User {
  /**
   * Find user by email (with password hash for auth)
   */
  static async findByEmail(email) {
    const result = await query(
      `SELECT id, email, password_hash, CONCAT(first_name, ' ', last_name) AS name, phone, company_id, role, status,
              must_change_password, last_login_at, login_attempts, locked_until,
              two_fa_enabled, two_fa_secret, created_at
       FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );
    return result.rows[0] || null;
  }

  /**
   * Find user by ID (no password hash)
   */
  static async findById(id) {
    const result = await query(
      `SELECT u.id, u.email, CONCAT(u.first_name, ' ', u.last_name) AS name, u.phone, u.company_id, u.role, u.status,
              u.must_change_password, u.last_login_at, u.two_fa_enabled, u.avatar_url,
              u.created_at, u.updated_at,
              c.name AS company_name, c.id AS company_code
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * List users with filters and pagination
   */
  static async findAll({ companyId, role, status, search, page = 1, limit = 20, userRole, userCompanyId }) {
    const conditions = [];
    const params = [];
    let idx = 1;

    // Non-admin sees only their company
    if (userRole !== 'admin') {
      conditions.push(`u.company_id = $${idx++}`);
      params.push(userCompanyId);
    } else if (companyId) {
      conditions.push(`u.company_id = $${idx++}`);
      params.push(companyId);
    }

    if (role) {
      conditions.push(`u.role = $${idx++}`);
      params.push(role);
    }

    if (status) {
      conditions.push(`u.status = $${idx++}`);
      params.push(status);
    }

    if (search) {
      conditions.push(`(CONCAT(u.first_name, ' ', u.last_name) ILIKE $${idx} OR u.email ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT u.id, u.email, CONCAT(u.first_name, ' ', u.last_name) AS name, u.phone, u.role, u.status, u.company_id,
                u.last_login_at, u.two_fa_enabled, u.created_at, u.updated_at,
                c.name AS company_name
         FROM users u
         LEFT JOIN companies c ON c.id = u.company_id
         ${where}
         ORDER BY u.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*) AS total FROM users u ${where}`,
        params
      ),
    ]);

    return {
      data: rows.rows,
      total: parseInt(countResult.rows[0].total),
    };
  }

  /**
   * Create a new user
   */
  static async create({ email, password, name, phone, company_id, role, must_change_password = false }) {
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    
    // Split name into first_name and last_name
    const [first_name, ...lastNameParts] = (name || '').split(' ');
    const last_name = lastNameParts.join(' ') || '';
    
    const result = await query(
      `INSERT INTO users (email, password_hash, first_name, last_name, phone, company_id, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, email, CONCAT(first_name, ' ', last_name) AS name, role, company_id, status, created_at`,
      [email.toLowerCase(), password_hash, first_name, last_name, phone || null, company_id, role, must_change_password]
    );
    return result.rows[0];
  }

  /**
   * Update user
   */
  static async update(id, updates) {
    const allowed = ['first_name', 'last_name', 'phone', 'company_id', 'role', 'status', 'avatar_url', 'job_title', 'department'];
    const fields = [];
    const params = [];
    let idx = 1;

    // Handle 'name' field by splitting into first_name and last_name
    if ('name' in updates) {
      const [first_name, ...lastNameParts] = (updates.name || '').split(' ');
      updates.first_name = first_name;
      updates.last_name = lastNameParts.join(' ') || '';
    }

    for (const key of allowed) {
      if (key in updates) {
        fields.push(`${key} = $${idx++}`);
        params.push(updates[key]);
      }
    }

    if (!fields.length) return null;

    params.push(id);
    const result = await query(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx}
       RETURNING id, email, CONCAT(first_name, ' ', last_name) AS name, role, company_id, status, updated_at`,
      params
    );
    return result.rows[0] || null;
  }

  /**
   * Verify password
   */
  static async verifyPassword(plainPassword, hash) {
    return bcrypt.compare(plainPassword, hash);
  }

  /**
   * Hash password
   */
  static async hashPassword(password) {
    return bcrypt.hash(password, SALT_ROUNDS);
  }

  /**
   * Update password
   */
  static async updatePassword(id, newPassword) {
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await query(
      `UPDATE users SET password_hash = $1, must_change_password = false, updated_at = NOW()
       WHERE id = $2`,
      [hash, id]
    );
  }

  /**
   * Update last login and reset failed attempts
   */
  static async recordLogin(id) {
    await query(
      `UPDATE users SET last_login_at = NOW(), login_attempts = 0, locked_until = NULL
       WHERE id = $1`,
      [id]
    );
  }

  /**
   * Increment failed login attempts (lock after 5)
   */
  static async incrementLoginAttempts(email) {
    await query(
      `UPDATE users
       SET login_attempts = login_attempts + 1,
           locked_until = CASE WHEN login_attempts + 1 >= 5
             THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END
       WHERE email = $1`,
      [email.toLowerCase()]
    );
  }

  /**
   * Soft delete (deactivate)
   */
  static async deactivate(id) {
    const result = await query(
      `UPDATE users SET status = 'inactive', updated_at = NOW()
       WHERE id = $1 RETURNING id, email, status`,
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Enable 2FA: store encrypted secret
   */
  static async enable2FA(id, secret) {
    const encrypted = encrypt(secret);
    await query(
      `UPDATE users SET two_fa_enabled = true, two_fa_secret = $1, updated_at = NOW()
       WHERE id = $2`,
      [encrypted, id]
    );
  }

  /**
   * Get 2FA secret (decrypted)
   */
  static async get2FASecret(id) {
    const result = await query(
      `SELECT two_fa_secret FROM users WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row || !row.two_fa_secret) return null;
    return decrypt(row.two_fa_secret);
  }

  /**
   * Check if email is unique
   */
  static async emailExists(email) {
    const result = await query(
      `SELECT id FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );
    return result.rows.length > 0;
  }
}

module.exports = User;
