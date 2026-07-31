'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../../config/database');
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

const MONTH_NAMES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const MONTH_NAMES_EN = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

// GET /api/admin/fiscal-calendars?company_id=X
router.get('/', async (req, res, next) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const result = await query(`
      SELECT uuid, fiscal_year, name, start_date, end_date,
        period_type, is_active, is_closed, created_at
      FROM fiscal_calendars
      WHERE company_id = $1 ORDER BY fiscal_year DESC
    `, [parseInt(company_id)]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/admin/fiscal-calendars/:uuid
router.get('/:uuid', async (req, res, next) => {
  try {
    const cal = await query(
      'SELECT * FROM fiscal_calendars WHERE uuid=$1', [req.params.uuid]);
    if (!cal.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const periods = await query(
      'SELECT uuid, period_number, name, name_en, start_date, end_date, is_closed, closed_at FROM fiscal_periods WHERE fiscal_calendar_id=$1 ORDER BY period_number',
      [cal.rows[0].id]);
    res.json({ success: true, data: { ...cal.rows[0], periods: periods.rows } });
  } catch(e) { next(e); }
});

// POST /api/admin/fiscal-calendars
router.post('/', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { company_id, fiscal_year, start_date, end_date, period_type = 'monthly' } = req.body;
    if (!company_id || !fiscal_year || !start_date || !end_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, fiscal_year, start_date, end_date' });

    const now = new Date();
    let calId, calUuid;

    await withTransaction(async (client) => {
      const calResult = await client.query(`
        INSERT INTO fiscal_calendars (company_id, fiscal_year, name, start_date, end_date, period_type)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, uuid
      `, [parseInt(company_id), parseInt(fiscal_year),
          `FY${fiscal_year}`, start_date, end_date, period_type]);
      calId = calResult.rows[0].id;
      calUuid = calResult.rows[0].uuid;

      // Auto-generate 12 monthly periods
      for (let m = 0; m < 12; m++) {
        const pStart = new Date(fiscal_year, m, 1);
        const pEnd = new Date(fiscal_year, m + 1, 0);
        const isClosed = pEnd < now;
        await client.query(`
          INSERT INTO fiscal_periods
            (fiscal_calendar_id, company_id, period_number, name, name_en, start_date, end_date, is_closed)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [calId, parseInt(company_id), m+1,
            MONTH_NAMES_ES[m] + ' ' + fiscal_year,
            MONTH_NAMES_EN[m] + ' ' + fiscal_year,
            pStart.toISOString().slice(0,10),
            pEnd.toISOString().slice(0,10),
            isClosed]);
      }
    });

    writeAudit({ userId: req.user.id, action: 'fiscal_calendar_created',
      entityType: 'fiscal_calendars', entityId: calUuid,
      companyId: parseInt(company_id), newValues: { fiscal_year },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.status(201).json({ success: true, data: { uuid: calUuid, fiscal_year, periods_created: 12 } });
  } catch(e) { next(e); }
});

// POST /api/admin/fiscal-calendars/:uuid/close-period
router.post('/:uuid/close-period', async (req, res, next) => {
  if (!['super_admin'].includes(req.user.role))
    return res.status(403).json({ success: false, error: 'forbidden', message: 'Only super_admin can close fiscal periods.' });
  try {
    const { period_number } = req.body;
    const cal = await query('SELECT id FROM fiscal_calendars WHERE uuid=$1', [req.params.uuid]);
    if (!cal.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      UPDATE fiscal_periods SET is_closed=true, closed_at=NOW(), closed_by=$1
      WHERE fiscal_calendar_id=$2 AND period_number=$3 AND is_closed=false
      RETURNING uuid, period_number, name
    `, [req.user.id, cal.rows[0].id, parseInt(period_number)]);
    if (!result.rows[0]) return res.status(400).json({ success: false, error: 'already_closed_or_not_found' });
    writeAudit({ userId: req.user.id, action: 'fiscal_period_closed',
      entityType: 'fiscal_periods', entityId: result.rows[0].uuid,
      newValues: { period_number }, ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.json({ success: true, data: result.rows[0], message: `Period ${period_number} closed.` });
  } catch(e) { next(e); }
});

module.exports = router;
