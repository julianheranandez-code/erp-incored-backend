'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { query, withTransaction } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { writeAudit } = require('../../middleware/audit');

router.use(verifyToken);

async function getAsset(uuid) {
  const result = await query('SELECT id, company_id FROM assets WHERE uuid=$1', [uuid]);
  return result.rows[0] || null;
}

// GET /api/assets/:uuid/vehicle
router.get('/', async (req, res, next) => {
  try {
    const asset = await getAsset(req.params.uuid);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });
    const result = await query(`
      SELECT uuid, plates, vin, engine_number, fuel_type, transmission, passengers,
        odometer_current, odometer_unit, odometer_last_update,
        verification_expiry, verification_number, tenencia_year, tenencia_paid, tenencia_amount,
        state_registration, registration_expiry
      FROM vehicle_details WHERE asset_id=$1
    `, [asset.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'vehicle_details_not_found' });
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// POST /api/assets/:uuid/vehicle
router.post('/', async (req, res, next) => {
  try {
    const asset = await getAsset(req.params.uuid);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });
    const { plates, vin, engine_number, fuel_type = 'gasoline', transmission = 'automatic',
            passengers, odometer_current = 0, odometer_unit = 'km',
            verification_expiry, verification_number, tenencia_year, tenencia_amount,
            state_registration, registration_expiry } = req.body;
    const result = await query(`
      INSERT INTO vehicle_details
        (asset_id, company_id, plates, vin, engine_number, fuel_type, transmission,
         passengers, odometer_current, odometer_unit,
         verification_expiry, verification_number, tenencia_year, tenencia_amount,
         state_registration, registration_expiry)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING uuid, plates, vin, odometer_current
    `, [asset.id, asset.company_id, plates||null, vin||null, engine_number||null,
        fuel_type, transmission, passengers||null, odometer_current, odometer_unit,
        verification_expiry||null, verification_number||null, tenencia_year||null,
        tenencia_amount||null, state_registration||null, registration_expiry||null]);
    res.status(201).json({ success: true, data: result.rows[0], message: 'Vehicle details created.' });
  } catch(e) { next(e); }
});

// PUT /api/assets/:uuid/vehicle
router.put('/', async (req, res, next) => {
  try {
    const asset = await getAsset(req.params.uuid);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });
    const allowed = ['plates','vin','engine_number','fuel_type','transmission','passengers',
      'verification_expiry','verification_number','tenencia_year','tenencia_paid','tenencia_amount',
      'state_registration','registration_expiry'];
    const fields = [];
    const params = [];
    let idx = 1;
    for (const key of allowed) {
      if (key in req.body) { fields.push(`${key} = $${idx++}`); params.push(req.body[key]); }
    }
    if (!fields.length) return res.status(400).json({ success: false, error: 'no_fields' });
    params.push(asset.id);
    const result = await query(
      `UPDATE vehicle_details SET ${fields.join(', ')}, updated_at=NOW() WHERE asset_id=$${idx} RETURNING uuid`,
      params);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, message: 'Vehicle details updated.' });
  } catch(e) { next(e); }
});

// GET /api/assets/:uuid/odometer
router.get('/odometer', async (req, res, next) => {
  try {
    const asset = await getAsset(req.params.uuid);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });
    const result = await query(`
      SELECT uuid, log_date, odometer_reading, notes, created_at
      FROM odometer_logs WHERE asset_id=$1 ORDER BY log_date DESC
    `, [asset.id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/assets/:uuid/odometer
router.post('/odometer', async (req, res, next) => {
  try {
    const { log_date, odometer_reading, notes } = req.body;
    if (!log_date || odometer_reading === undefined)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: log_date, odometer_reading' });
    const asset = await getAsset(req.params.uuid);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });

    // Validate reading >= current
    const vd = await query('SELECT odometer_current FROM vehicle_details WHERE asset_id=$1', [asset.id]);
    if (vd.rows[0] && parseFloat(odometer_reading) < parseFloat(vd.rows[0].odometer_current))
      return res.status(422).json({ success: false, error: 'odometer_decrease',
        message: `New reading (${odometer_reading}) cannot be less than current (${vd.rows[0].odometer_current}).` });

    await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO odometer_logs (asset_id, company_id, log_date, odometer_reading, recorded_by, notes)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [asset.id, asset.company_id, log_date, odometer_reading, req.user.id, notes||null]);
      await client.query(`
        UPDATE vehicle_details SET odometer_current=$1, odometer_last_update=$2, updated_at=NOW()
        WHERE asset_id=$3
      `, [odometer_reading, log_date, asset.id]);
    });

    res.status(201).json({ success: true,
      data: { odometer_reading, log_date }, message: 'Odometer logged.' });
  } catch(e) { next(e); }
});

// GET /api/assets/:uuid/rental
router.get('/rental', async (req, res, next) => {
  try {
    const asset = await getAsset(req.params.uuid);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });
    const result = await query(`
      SELECT uuid, provider_name, contract_number, monthly_cost, currency,
        start_date, end_date, is_active, auto_renewal, notes
      FROM rental_contracts WHERE asset_id=$1 ORDER BY start_date DESC
    `, [asset.id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/assets/:uuid/rental
router.post('/rental', async (req, res, next) => {
  try {
    const { provider_name, contract_number, monthly_cost, currency = 'USD',
            start_date, end_date, auto_renewal = false, notes } = req.body;
    if (!provider_name || !start_date || !end_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: provider_name, start_date, end_date' });
    const asset = await getAsset(req.params.uuid);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });
    const result = await query(`
      INSERT INTO rental_contracts
        (asset_id, company_id, provider_name, contract_number, monthly_cost,
         currency, start_date, end_date, auto_renewal, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING uuid, provider_name, start_date, end_date
    `, [asset.id, asset.company_id, provider_name, contract_number||null,
        monthly_cost||null, currency, start_date, end_date, auto_renewal, notes||null, req.user.id]);
    res.status(201).json({ success: true, data: result.rows[0], message: 'Rental contract created.' });
  } catch(e) { next(e); }
});

// GET /api/assets/:uuid/violations
router.get('/violations', async (req, res, next) => {
  try {
    const asset = await getAsset(req.params.uuid);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });
    const result = await query(`
      SELECT tv.uuid, tv.violation_date, tv.violation_type, tv.amount, tv.currency,
        tv.authority, tv.folio, tv.status, tv.paid_date, tv.notes,
        CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal,e.last_name,'')) AS driver_name
      FROM traffic_violations tv
      LEFT JOIN employees e ON e.id = tv.driver_id
      WHERE tv.asset_id=$1 ORDER BY tv.violation_date DESC
    `, [asset.id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/assets/:uuid/violations
router.post('/violations', async (req, res, next) => {
  try {
    const { violation_date, violation_type, amount, currency = 'MXN',
            authority, folio, driver_uuid, notes } = req.body;
    if (!violation_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: violation_date' });
    const asset = await getAsset(req.params.uuid);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });
    let driverId = null;
    if (driver_uuid) {
      const d = await query('SELECT id FROM employees WHERE uuid=$1', [driver_uuid]);
      driverId = d.rows[0]?.id || null;
    }
    const result = await query(`
      INSERT INTO traffic_violations
        (asset_id, company_id, violation_date, violation_type, amount, currency,
         authority, folio, driver_id, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING uuid, violation_date, status
    `, [asset.id, asset.company_id, violation_date, violation_type||null,
        amount||null, currency, authority||null, folio||null,
        driverId, notes||null, req.user.id]);
    res.status(201).json({ success: true, data: result.rows[0], message: 'Violation recorded.' });
  } catch(e) { next(e); }
});

// GET /api/assets/:uuid/compliance
router.get('/compliance', async (req, res, next) => {
  try {
    const asset = await getAsset(req.params.uuid);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });
    const result = await query(`
      SELECT uuid, compliance_type, period, due_date, paid_date,
        amount, currency, status, folio, notes
      FROM compliance_records WHERE asset_id=$1 ORDER BY due_date DESC
    `, [asset.id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/assets/:uuid/compliance
router.post('/compliance', async (req, res, next) => {
  try {
    const { compliance_type, period, due_date, amount, currency = 'MXN', notes } = req.body;
    if (!compliance_type || !due_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: compliance_type, due_date' });
    const asset = await getAsset(req.params.uuid);
    if (!asset) return res.status(404).json({ success: false, error: 'asset_not_found' });
    const result = await query(`
      INSERT INTO compliance_records
        (asset_id, company_id, compliance_type, period, due_date, amount, currency, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING uuid, compliance_type, due_date, status
    `, [asset.id, asset.company_id, compliance_type, period||null,
        due_date, amount||null, currency, notes||null, req.user.id]);
    res.status(201).json({ success: true, data: result.rows[0], message: 'Compliance record created.' });
  } catch(e) { next(e); }
});

// PATCH /api/assets/:uuid/compliance/:comp_uuid/pay
router.patch('/compliance/:comp_uuid/pay', async (req, res, next) => {
  try {
    const { paid_date, paid_amount, folio } = req.body;
    const result = await query(`
      UPDATE compliance_records SET status='paid', paid_date=$1, amount=COALESCE($2,amount),
        folio=COALESCE($3,folio), updated_at=NOW()
      WHERE uuid=$4 RETURNING uuid, compliance_type, status
    `, [paid_date||new Date().toISOString().slice(0,10), paid_amount||null,
        folio||null, req.params.comp_uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0], message: 'Compliance marked as paid.' });
  } catch(e) { next(e); }
});

module.exports = router;
