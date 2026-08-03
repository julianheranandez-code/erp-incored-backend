'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { writeAudit } = require('../../middleware/audit');

router.use(verifyToken);

async function generateAssetNumber() {
  const result = await query("SELECT 'AST-' || LPAD(nextval('asset_number_seq')::text, 6, '0') AS asset_number");
  return result.rows[0].asset_number;
}

// GET /api/assets?company_id=X&asset_type=VEH&status=active
router.get('/', async (req, res, next) => {
  try {
    const { company_id, asset_type, status, search, page = 1, limit = 20 } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let conditions = ['a.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (asset_type) { conditions.push(`at.code = $${idx++}`); values.push(asset_type); }
    if (status)     { conditions.push(`a.status = $${idx++}`); values.push(status); }
    if (search)     {
      conditions.push(`(a.name ILIKE $${idx} OR a.asset_number ILIKE $${idx} OR a.brand ILIKE $${idx} OR a.serial_number ILIKE $${idx})`);
      values.push('%' + search + '%'); idx++;
    }
    const countResult = await query(
      `SELECT COUNT(*) FROM assets a JOIN asset_types at ON at.id = a.asset_type_id WHERE ${conditions.join(' AND ')}`,
      values
    );
    const total = parseInt(countResult.rows[0].count);
    values.push(parseInt(limit), offset);
    const result = await query(`
      SELECT a.uuid, a.asset_number, a.name, a.brand, a.model, a.year,
        a.status, a.is_owned, a.is_active, a.purchase_date, a.purchase_price,
        a.purchase_currency, a.asset_source,
        at.code AS asset_type_code, at.name AS asset_type_name, at.is_vehicle,
        CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal,e.last_name,'')) AS assigned_to_name,
        vd.plates, vd.odometer_current
      FROM assets a
      JOIN asset_types at ON at.id = a.asset_type_id
      LEFT JOIN employees e ON e.id = a.assigned_employee_id
      LEFT JOIN vehicle_details vd ON vd.asset_id = a.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.asset_number
      LIMIT $${idx++} OFFSET $${idx++}
    `, values);
    res.json({ success: true, count: result.rows.length, total,
      page: parseInt(page), total_pages: Math.ceil(total / parseInt(limit)),
      data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/assets/:uuid
router.get('/:uuid', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT a.uuid, a.asset_number, a.name, a.description, a.brand, a.model,
        a.year, a.serial_number, a.color, a.purchase_date, a.purchase_price,
        a.purchase_currency, a.current_value, a.is_owned, a.status,
        a.acquisition_date, a.disposal_date, a.disposal_reason,
        a.asset_source, a.source_reference, a.is_active, a.created_at,
        at.code AS asset_type_code, at.name AS asset_type_name, at.is_vehicle,
        c.name AS company_name,
        d.name AS department_name, cc.name AS cost_center_name,
        CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal,e.last_name,'')) AS assigned_to_name
      FROM assets a
      JOIN asset_types at ON at.id = a.asset_type_id
      JOIN companies c ON c.id = a.company_id
      LEFT JOIN departments d ON d.id = a.department_id
      LEFT JOIN cost_centers cc ON cc.id = a.cost_center_id
      LEFT JOIN employees e ON e.id = a.assigned_employee_id
      WHERE a.uuid = $1
    `, [req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// POST /api/assets
router.post('/', async (req, res, next) => {
  try {
    const {
      company_id, asset_type_code, name, description, brand, model, year,
      serial_number, color, purchase_date, purchase_price, purchase_currency = 'MXN',
      is_owned = true, department_uuid, cost_center_uuid, project_id,
      asset_source = 'web', source_reference, acquisition_date
    } = req.body;
    if (!company_id || !asset_type_code || !name)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, asset_type_code, name' });

    const at = await query('SELECT id FROM asset_types WHERE code=$1', [asset_type_code]);
    if (!at.rows[0]) return res.status(400).json({ success: false, error: 'invalid_asset_type' });

    let deptId = null, ccId = null;
    if (department_uuid) {
      const d = await query('SELECT id FROM departments WHERE uuid=$1', [department_uuid]);
      deptId = d.rows[0]?.id || null;
    }
    if (cost_center_uuid) {
      const cc = await query('SELECT id FROM cost_centers WHERE uuid=$1', [cost_center_uuid]);
      ccId = cc.rows[0]?.id || null;
    }

    const assetNumber = await generateAssetNumber();
    const result = await query(`
      INSERT INTO assets (
        company_id, asset_type_id, asset_number, name, description,
        brand, model, year, serial_number, color,
        purchase_date, purchase_price, purchase_currency, is_owned,
        department_id, cost_center_id, project_id,
        asset_source, source_reference, acquisition_date, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING uuid, asset_number, name
    `, [parseInt(company_id), at.rows[0].id, assetNumber, name, description||null,
        brand||null, model||null, year||null, serial_number||null, color||null,
        purchase_date||null, purchase_price||null, purchase_currency, is_owned,
        deptId, ccId, project_id||null,
        asset_source, source_reference||null, acquisition_date||null, req.user.id]);

    writeAudit({ userId: req.user.id, action: 'asset_created',
      entityType: 'assets', entityId: result.rows[0].uuid,
      companyId: parseInt(company_id), newValues: { asset_number: assetNumber, name },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    res.status(201).json({ success: true, data: result.rows[0],
      message: `Asset ${assetNumber} created.` });
  } catch(e) { next(e); }
});

// PUT /api/assets/:uuid
router.put('/:uuid', async (req, res, next) => {
  try {
    const allowed = ['name','description','brand','model','year','serial_number',
      'color','purchase_date','purchase_price','purchase_currency','current_value',
      'is_owned','acquisition_date','disposal_date','disposal_reason'];
    const fields = [];
    const params = [];
    let idx = 1;
    for (const key of allowed) {
      if (key in req.body) { fields.push(`${key} = $${idx++}`); params.push(req.body[key]); }
    }
    if (!fields.length) return res.status(400).json({ success: false, error: 'no_fields' });
    params.push(req.params.uuid);
    const result = await query(
      `UPDATE assets SET ${fields.join(', ')}, updated_at=NOW() WHERE uuid=$${idx} RETURNING uuid, asset_number, name`,
      params);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    writeAudit({ userId: req.user.id, action: 'asset_updated',
      entityType: 'assets', entityId: req.params.uuid,
      newValues: req.body, ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// PATCH /api/assets/:uuid/status
router.patch('/:uuid/status', async (req, res, next) => {
  try {
    const { status, reason } = req.body;
    const valid = ['active','maintenance','retired','disposed','lost','stolen'];
    if (!valid.includes(status))
      return res.status(400).json({ success: false, error: 'invalid_status' });
    const result = await query(`
      UPDATE assets SET status=$1, disposal_reason=$2, updated_at=NOW()
      WHERE uuid=$3 RETURNING uuid, asset_number, status
    `, [status, reason||null, req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    writeAudit({ userId: req.user.id, action: 'asset_status_changed',
      entityType: 'assets', entityId: req.params.uuid,
      newValues: { status, reason }, ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// GET /api/assets/:uuid/assignments
router.get('/:uuid/assignments', async (req, res, next) => {
  try {
    const asset = await query('SELECT id FROM assets WHERE uuid=$1', [req.params.uuid]);
    if (!asset.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT aa.uuid, aa.assigned_to, aa.start_date, aa.end_date, aa.is_current, aa.notes,
        CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal,e.last_name,'')) AS employee_name,
        p.name AS project_name, cc.name AS cost_center_name
      FROM asset_assignments aa
      LEFT JOIN employees e ON e.id = aa.employee_id
      LEFT JOIN projects p ON p.id = aa.project_id
      LEFT JOIN cost_centers cc ON cc.id = aa.cost_center_id
      WHERE aa.asset_id = $1 ORDER BY aa.start_date DESC
    `, [asset.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/assets/:uuid/assign
router.post('/:uuid/assign', async (req, res, next) => {
  try {
    const { assigned_to, employee_uuid, project_id, cost_center_uuid, start_date, notes } = req.body;
    if (!assigned_to || !start_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: assigned_to, start_date' });
    const asset = await query('SELECT id, company_id FROM assets WHERE uuid=$1', [req.params.uuid]);
    if (!asset.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const { id: assetId, company_id } = asset.rows[0];

    let empId = null, ccId = null;
    if (employee_uuid) {
      const e = await query('SELECT id FROM employees WHERE uuid=$1', [employee_uuid]);
      empId = e.rows[0]?.id || null;
    }
    if (cost_center_uuid) {
      const cc = await query('SELECT id FROM cost_centers WHERE uuid=$1', [cost_center_uuid]);
      ccId = cc.rows[0]?.id || null;
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE asset_assignments SET is_current=false, end_date=$1 WHERE asset_id=$2 AND is_current=true`,
        [start_date, assetId]
      );
      await client.query(`
        INSERT INTO asset_assignments
          (asset_id, company_id, assigned_to, employee_id, project_id, cost_center_id, start_date, notes, assigned_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [assetId, company_id, assigned_to, empId, project_id||null, ccId, start_date, notes||null, req.user.id]);

      // Update assigned_employee_id on asset
      if (empId) {
        await client.query(`UPDATE assets SET assigned_employee_id=$1, updated_at=NOW() WHERE id=$2`, [empId, assetId]);
      }
    });

    writeAudit({ userId: req.user.id, action: 'asset_assigned',
      entityType: 'assets', entityId: req.params.uuid,
      newValues: { assigned_to, employee_uuid, start_date },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    res.status(201).json({ success: true, message: 'Asset assigned.' });
  } catch(e) { next(e); }
});

// GET /api/assets/:uuid/maintenance
router.get('/:uuid/maintenance', async (req, res, next) => {
  try {
    const asset = await query('SELECT id FROM assets WHERE uuid=$1', [req.params.uuid]);
    if (!asset.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT uuid, maintenance_type, description, maintenance_date,
        cost, currency, odometer_km, next_service_km, next_service_date,
        performed_by, invoice_ref, notes, created_at
      FROM asset_maintenance WHERE asset_id=$1 ORDER BY maintenance_date DESC
    `, [asset.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/assets/:uuid/maintenance
router.post('/:uuid/maintenance', async (req, res, next) => {
  try {
    const { maintenance_type, description, maintenance_date, cost, currency = 'MXN',
            odometer_km, next_service_km, next_service_date, performed_by, invoice_ref, notes } = req.body;
    if (!maintenance_type || !maintenance_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: maintenance_type, maintenance_date' });
    const asset = await query('SELECT id, company_id FROM assets WHERE uuid=$1', [req.params.uuid]);
    if (!asset.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      INSERT INTO asset_maintenance
        (asset_id, company_id, maintenance_type, description, maintenance_date,
         cost, currency, odometer_km, next_service_km, next_service_date,
         performed_by, invoice_ref, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING uuid, maintenance_type, maintenance_date
    `, [asset.rows[0].id, asset.rows[0].company_id, maintenance_type, description||null,
        maintenance_date, cost||null, currency, odometer_km||null,
        next_service_km||null, next_service_date||null,
        performed_by||null, invoice_ref||null, notes||null, req.user.id]);
    res.status(201).json({ success: true, data: result.rows[0], message: 'Maintenance record created.' });
  } catch(e) { next(e); }
});

// GET /api/assets/:uuid/insurance
router.get('/:uuid/insurance', async (req, res, next) => {
  try {
    const asset = await query('SELECT id FROM assets WHERE uuid=$1', [req.params.uuid]);
    if (!asset.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT uuid, insurer_name, policy_number, coverage_type,
        premium_amount, premium_currency, start_date, expiry_date, is_current, notes
      FROM asset_insurance WHERE asset_id=$1 ORDER BY start_date DESC
    `, [asset.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/assets/:uuid/insurance
router.post('/:uuid/insurance', async (req, res, next) => {
  try {
    const { insurer_name, policy_number, coverage_type, premium_amount,
            premium_currency = 'MXN', start_date, expiry_date, notes } = req.body;
    if (!insurer_name || !start_date || !expiry_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: insurer_name, start_date, expiry_date' });
    const asset = await query('SELECT id, company_id FROM assets WHERE uuid=$1', [req.params.uuid]);
    if (!asset.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    await withTransaction(async (client) => {
      await client.query(`UPDATE asset_insurance SET is_current=false WHERE asset_id=$1`, [asset.rows[0].id]);
      await client.query(`
        INSERT INTO asset_insurance
          (asset_id, company_id, insurer_name, policy_number, coverage_type,
           premium_amount, premium_currency, start_date, expiry_date, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [asset.rows[0].id, asset.rows[0].company_id, insurer_name, policy_number||null,
          coverage_type||null, premium_amount||null, premium_currency, start_date, expiry_date,
          notes||null, req.user.id]);
    });
    res.status(201).json({ success: true, message: 'Insurance policy created.' });
  } catch(e) { next(e); }
});

// GET /api/assets/alerts?company_id=X&days=30
router.get('/alerts/upcoming', async (req, res, next) => {
  try {
    const { company_id, days = 30 } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + parseInt(days));
    const result = await query(`
      SELECT ama.uuid, ama.alert_type, ama.trigger_date, ama.trigger_km, ama.description,
        a.uuid AS asset_uuid, a.asset_number, a.name AS asset_name,
        at.code AS asset_type_code, at.is_vehicle
      FROM asset_maintenance_alerts ama
      JOIN assets a ON a.id = ama.asset_id
      JOIN asset_types at ON at.id = a.asset_type_id
      WHERE a.company_id=$1 AND ama.is_active=true
        AND (ama.trigger_date <= $2 OR ama.trigger_km IS NOT NULL)
      ORDER BY ama.trigger_date ASC NULLS LAST
    `, [parseInt(company_id), futureDate.toISOString().slice(0,10)]);
    res.json({ success: true, count: result.rows.length, days: parseInt(days), data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/assets/fleet/summary?company_id=X
router.get('/fleet/summary', async (req, res, next) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const vehicles = await query(`
      SELECT a.status, a.is_owned, COUNT(*) as count
      FROM assets a
      JOIN asset_types at ON at.id = a.asset_type_id
      WHERE a.company_id=$1 AND at.is_vehicle=true AND a.is_active=true
      GROUP BY a.status, a.is_owned
    `, [parseInt(company_id)]);
    const overdue = await query(`
      SELECT COUNT(*) FROM compliance_records cr
      JOIN assets a ON a.id = cr.asset_id
      WHERE a.company_id=$1 AND cr.status='overdue'
    `, [parseInt(company_id)]);
    res.json({ success: true, data: {
      vehicles: vehicles.rows,
      overdue_compliance: parseInt(overdue.rows[0].count)
    }});
  } catch(e) { next(e); }
});

module.exports = router;
