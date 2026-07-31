'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { writeAudit } = require('../../middleware/audit');

router.use(verifyToken);

function assertAdmin(req, res) {
  if (!['super_admin','admin'].includes(req.user.role)) {
    res.status(403).json({ success: false, error: 'forbidden' });
    return false;
  }
  return true;
}

// GET /api/admin/business-units?company_id=X
router.get('/', async (req, res, next) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const result = await query(`
      SELECT bu.uuid, bu.code, bu.name, bu.description, bu.is_active,
        bu.created_at, bu.updated_at,
        CONCAT(u.first_name,' ',u.last_name) AS manager_name
      FROM business_units bu
      LEFT JOIN users u ON u.id = bu.manager_id
      WHERE bu.company_id = $1
      ORDER BY bu.code
    `, [parseInt(company_id)]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/admin/business-units/:uuid
router.get('/:uuid', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT bu.uuid, bu.code, bu.name, bu.description, bu.is_active,
        bu.created_at, bu.updated_at,
        CONCAT(u.first_name,' ',u.last_name) AS manager_name
      FROM business_units bu
      LEFT JOIN users u ON u.id = bu.manager_id
      WHERE bu.uuid = $1
    `, [req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// POST /api/admin/business-units
router.post('/', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { company_id, code, name, description, manager_id } = req.body;
    if (!company_id || !code || !name)
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, code, name' });
    const result = await query(`
      INSERT INTO business_units (company_id, code, name, description, manager_id)
      VALUES ($1,$2,$3,$4,$5) RETURNING uuid, code, name
    `, [parseInt(company_id), code.toUpperCase(), name, description||null, manager_id||null]);
    writeAudit({ userId: req.user.id, action: 'business_unit_created',
      entityType: 'business_units', entityId: result.rows[0].uuid,
      companyId: parseInt(company_id), newValues: { code, name },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// PUT /api/admin/business-units/:uuid
router.put('/:uuid', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { name, description, manager_id, is_active } = req.body;
    const result = await query(`
      UPDATE business_units SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        manager_id = COALESCE($3, manager_id),
        is_active = COALESCE($4, is_active),
        updated_at = NOW()
      WHERE uuid = $5
      RETURNING uuid, code, name, is_active
    `, [name||null, description||null, manager_id||null, is_active??null, req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    writeAudit({ userId: req.user.id, action: 'business_unit_updated',
      entityType: 'business_units', entityId: req.params.uuid,
      newValues: req.body, ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

module.exports = router;
