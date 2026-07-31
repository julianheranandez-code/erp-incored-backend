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

// GET /api/admin/cost-centers?company_id=X
router.get('/', async (req, res, next) => {
  try {
    const { company_id, department_uuid } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    let conditions = ['cc.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (department_uuid) {
      conditions.push(`d.uuid = $${idx++}`);
      values.push(department_uuid);
    }
    const result = await query(`
      SELECT cc.uuid, cc.code, cc.name, cc.name_en, cc.description,
        cc.cost_center_type, cc.is_active, cc.created_at,
        d.uuid AS department_uuid, d.name AS department_name
      FROM cost_centers cc
      LEFT JOIN departments d ON d.id = cc.department_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY cc.code
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/admin/cost-centers/:uuid
router.get('/:uuid', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT cc.uuid, cc.code, cc.name, cc.name_en, cc.description,
        cc.cost_center_type, cc.is_active, cc.created_at,
        d.uuid AS department_uuid, d.name AS department_name
      FROM cost_centers cc
      LEFT JOIN departments d ON d.id = cc.department_id
      WHERE cc.uuid = $1
    `, [req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// POST /api/admin/cost-centers
router.post('/', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { company_id, department_uuid, code, name, name_en,
            description, cost_center_type } = req.body;
    if (!company_id || !code || !name)
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, code, name' });

    let dept_id = null;
    if (department_uuid) {
      const d = await query('SELECT id FROM departments WHERE uuid=$1', [department_uuid]);
      dept_id = d.rows[0]?.id || null;
    }
    const result = await query(`
      INSERT INTO cost_centers (company_id, department_id, code, name, name_en,
        description, cost_center_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING uuid, code, name
    `, [parseInt(company_id), dept_id, code.toUpperCase(), name, name_en||null,
        description||null, cost_center_type||'operational']);
    writeAudit({ userId: req.user.id, action: 'cost_center_created',
      entityType: 'cost_centers', entityId: result.rows[0].uuid,
      companyId: parseInt(company_id), newValues: { code, name },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// PUT /api/admin/cost-centers/:uuid
router.put('/:uuid', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { name, name_en, description, cost_center_type, is_active } = req.body;
    const result = await query(`
      UPDATE cost_centers SET
        name = COALESCE($1, name),
        name_en = COALESCE($2, name_en),
        description = COALESCE($3, description),
        cost_center_type = COALESCE($4, cost_center_type),
        is_active = COALESCE($5, is_active),
        updated_at = NOW()
      WHERE uuid = $6
      RETURNING uuid, code, name, is_active
    `, [name||null, name_en||null, description||null, cost_center_type||null, is_active??null, req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    writeAudit({ userId: req.user.id, action: 'cost_center_updated',
      entityType: 'cost_centers', entityId: req.params.uuid,
      newValues: req.body, ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

module.exports = router;
