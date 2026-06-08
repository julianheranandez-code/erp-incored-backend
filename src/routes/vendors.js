'use strict';

/**
 * Vendor Master Routes — Sprint 4C.0
 * ====================================
 * GET /api/vendors — list vendors for company (Lovable frontend)
 * GET /api/vendors/:id — single vendor detail
 * POST /api/vendors — create vendor
 * PUT /api/vendors/:id — update vendor
 *
 * RBAC: all authenticated users can read
 * Company scoping enforced on all queries
 */

const express = require('express');
const router  = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

// FIX 1: Vendor Master restricted to financial roles only
const ALLOWED_ROLES = new Set([
  'super_admin','admin','finance','accounting_manager',
  'procurement','operations_manager'
]);

function requireVendorAccess(req, res, next) {
  const roles = req.user.roles?.length ? req.user.roles : [req.user.role];
  if (roles.some(r => ALLOWED_ROLES.has(r))) return next();
  return res.status(403).json({ success: false, error: 'forbidden',
    message: 'Vendor Master access requires a financial role.' });
}

router.use(requireVendorAccess);

// ─── GET /api/vendors ─────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      company_id, search, status = 'active',
      sort = 'name', order = 'ASC',
      page = 1, limit = 25
    } = req.query;

    const roles = req.user.roles?.length ? req.user.roles : [req.user.role];
    const companyId = roles.includes('super_admin') && company_id
      ? parseInt(company_id)
      : parseInt(req.user.active_company_id || req.user.company_id);

    const conditions = [`company_id = $1`];
    const values = [companyId];
    let idx = 2;

    if (status) {
      conditions.push(`status = $${idx++}`);
      values.push(status);
    }

    if (search) {
      conditions.push(`(
        name ILIKE $${idx} OR
        vendor_code ILIKE $${idx} OR
        legal_name ILIKE $${idx} OR
        tax_id ILIKE $${idx}
      )`);
      values.push(`%${search}%`);
      idx++;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const validSorts = { name: 'name', vendor_code: 'vendor_code', created_at: 'created_at' };
    const sortCol = validSorts[sort] || 'name';
    const sortDir = order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const offset  = (parseInt(page) - 1) * parseInt(limit);

    const [rows, countResult] = await Promise.all([
      query(`
        SELECT
          id, vendor_code, name, legal_name, tax_id,
          email, phone, city, state, country,
          status, notes, created_at, updated_at
        FROM vendors
        ${where}
        ORDER BY ${sortCol} ${sortDir}
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, parseInt(limit), offset]),
      query(`SELECT COUNT(*) AS total FROM vendors ${where}`, values)
    ]);

    // FIX 5: Dropdown mode — minimal payload for Lovable selectors
    if (req.query.dropdown === 'true') {
      return res.json({
        success: true,
        data: rows.rows.map(v => ({ id: v.id, vendor_code: v.vendor_code, name: v.name }))
      });
    }

    res.json({
      success: true,
      count:  rows.rows.length,
      data:   rows.rows,
      pagination: {
        page:  parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].total)
      }
    });
  } catch(error) { next(error); }
});

// ─── GET /api/vendors/:id ─────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const roles = req.user.roles?.length ? req.user.roles : [req.user.role];
    const companyId = parseInt(req.user.active_company_id || req.user.company_id);

    const result = await query(`
      SELECT
        id, vendor_code, name, legal_name, tax_id,
        email, phone, address, city, state, country,
        status, notes, company_id, created_at, updated_at
      FROM vendors
      WHERE id = $1
        AND (company_id = $2 OR $3 = true)
    `, [parseInt(req.params.id), companyId, roles.includes('super_admin')]);

    if (!result.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    res.json({ success: true, data: result.rows[0] });
  } catch(error) { next(error); }
});

// ─── POST /api/vendors ────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      company_id, vendor_code, name, legal_name, tax_id,
      email, phone, address, city, state, country = 'Mexico', notes
    } = req.body;

    if (!name)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: name' });

    // FIX 2: company_id from session — prevent privilege escalation
    const roles = req.user.roles?.length ? req.user.roles : [req.user.role];
    const companyId = roles.includes('super_admin') && company_id
      ? parseInt(company_id)
      : parseInt(req.user.active_company_id || req.user.company_id);

    // FIX 4: DB-backed atomic sequence (race-condition safe)
    // Uses next_vendor_code() function — no two requests can get same code
    let code = vendor_code;
    if (!code) {
      const seqResult = await query(
        `SELECT next_vendor_code($1) AS code`, [companyId]
      );
      code = seqResult.rows[0].code;
    }

    const result = await query(`
      INSERT INTO vendors (
        company_id, vendor_code, name, legal_name, tax_id,
        email, phone, address, city, state, country, notes, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')
      RETURNING *
    `, [companyId, code, name, legal_name||null, tax_id||null,
        email||null, phone||null, address||null, city||null,
        state||null, country, notes||null]);

    res.status(201).json({ success: true, message: 'Vendor created.', data: result.rows[0] });
  } catch(error) {
    if (error.code === '23505')
      return res.status(409).json({ success: false, error: 'duplicate_vendor_code',
        message: 'Vendor code already exists for this company.' });
    next(error);
  }
});

// ─── PUT /api/vendors/:id ─────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { name, legal_name, tax_id, email, phone,
            address, city, state, country, notes, status } = req.body;

    const allowed = { name, legal_name, tax_id, email, phone,
                      address, city, state, country, notes, status };
    const fields = [], params = [];
    let idx = 1;

    for (const [k, v] of Object.entries(allowed)) {
      if (v !== undefined) { fields.push(`${k} = $${idx++}`); params.push(v); }
    }
    if (!fields.length)
      return res.status(400).json({ success: false, error: 'no_fields' });

    // FIX 3: Enforce company scoping on UPDATE
    const putRoles = req.user.roles?.length ? req.user.roles : [req.user.role];
    const putCompanyId = parseInt(req.user.active_company_id || req.user.company_id);
    const isSuperAdmin = putRoles.includes('super_admin');

    params.push(parseInt(req.params.id));
    params.push(putCompanyId);
    const result = await query(`
      UPDATE vendors SET ${fields.join(', ')}, updated_at=NOW()
      WHERE id = $${idx}
        AND (company_id = $${idx+1} OR $${idx+2} = true)
      RETURNING *
    `, [...params, isSuperAdmin]);

    if (!result.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    res.json({ success: true, message: 'Vendor updated.', data: result.rows[0] });
  } catch(error) { next(error); }
});

module.exports = router;
