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

// GET /api/admin/departments?company_id=X&business_unit_id=Y
router.get('/', async (req, res, next) => {
  try {
    const { company_id, business_unit_id } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    let conditions = ['d.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (business_unit_id) {
      conditions.push(`bu.uuid = $${idx++}`);
      values.push(business_unit_id);
    }
    const result = await query(`
      SELECT d.uuid, d.code, d.name, d.name_en, d.description, d.is_active,
        bu.uuid AS business_unit_uuid, bu.name AS business_unit_name,
        pd.uuid AS parent_dept_uuid, pd.name AS parent_dept_name,
        CONCAT(u.first_name,' ',u.last_name) AS head_name
      FROM departments d
      LEFT JOIN business_units bu ON bu.id = d.business_unit_id
      LEFT JOIN departments pd ON pd.id = d.parent_dept_id
      LEFT JOIN users u ON u.id = d.head_user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.code
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/admin/departments/:uuid
router.get('/:uuid', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT d.uuid, d.code, d.name, d.name_en, d.description, d.is_active,
        bu.uuid AS business_unit_uuid, bu.name AS business_unit_name,
        pd.uuid AS parent_dept_uuid, pd.name AS parent_dept_name,
        CONCAT(u.first_name,' ',u.last_name) AS head_name
      FROM departments d
      LEFT JOIN business_units bu ON bu.id = d.business_unit_id
      LEFT JOIN departments pd ON pd.id = d.parent_dept_id
      LEFT JOIN users u ON u.id = d.head_user_id
      WHERE d.uuid = $1
    `, [req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// POST /api/admin/departments
router.post('/', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { company_id, business_unit_uuid, code, name, name_en,
            description, parent_dept_uuid, head_user_id } = req.body;
    if (!company_id || !code || !name)
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, code, name' });

    let bu_id = null;
    if (business_unit_uuid) {
      const bu = await query('SELECT id FROM business_units WHERE uuid=$1', [business_unit_uuid]);
      bu_id = bu.rows[0]?.id || null;
    }
    let parent_id = null;
    if (parent_dept_uuid) {
      const pd = await query('SELECT id FROM departments WHERE uuid=$1', [parent_dept_uuid]);
      parent_id = pd.rows[0]?.id || null;
    }
    const result = await query(`
      INSERT INTO departments (company_id, business_unit_id, code, name, name_en,
        description, parent_dept_id, head_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING uuid, code, name
    `, [parseInt(company_id), bu_id, code.toUpperCase(), name, name_en||null,
        description||null, parent_id, head_user_id||null]);
    writeAudit({ userId: req.user.id, action: 'department_created',
      entityType: 'departments', entityId: result.rows[0].uuid,
      companyId: parseInt(company_id), newValues: { code, name },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// PUT /api/admin/departments/:uuid
router.put('/:uuid', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { name, name_en, description, head_user_id, is_active } = req.body;
    const result = await query(`
      UPDATE departments SET
        name = COALESCE($1, name),
        name_en = COALESCE($2, name_en),
        description = COALESCE($3, description),
        head_user_id = COALESCE($4, head_user_id),
        is_active = COALESCE($5, is_active),
        updated_at = NOW()
      WHERE uuid = $6
      RETURNING uuid, code, name, is_active
    `, [name||null, name_en||null, description||null, head_user_id||null, is_active??null, req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    writeAudit({ userId: req.user.id, action: 'department_updated',
      entityType: 'departments', entityId: req.params.uuid,
      newValues: req.body, ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

module.exports = router;
