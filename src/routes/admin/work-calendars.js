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

// GET /api/admin/work-calendars?company_id=X
router.get('/', async (req, res, next) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const result = await query(`
      SELECT uuid, country_code, name, fiscal_year, work_days,
        standard_hours, weekly_hours, is_active, created_at
      FROM work_calendars WHERE company_id=$1 ORDER BY fiscal_year DESC, country_code
    `, [parseInt(company_id)]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/admin/work-calendars/:uuid
router.get('/:uuid', async (req, res, next) => {
  try {
    const cal = await query('SELECT * FROM work_calendars WHERE uuid=$1', [req.params.uuid]);
    if (!cal.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const holidays = await query(`
      SELECT id, holiday_date, name, name_en, holiday_type, holiday_scope, state_code, is_paid, country_code
      FROM work_calendar_holidays WHERE work_calendar_id=$1 ORDER BY holiday_date
    `, [cal.rows[0].id]);
    res.json({ success: true, data: { ...cal.rows[0], holidays: holidays.rows } });
  } catch(e) { next(e); }
});

// POST /api/admin/work-calendars
router.post('/', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { company_id, country_code, name, fiscal_year, work_days, standard_hours, weekly_hours } = req.body;
    if (!company_id || !country_code || !name || !fiscal_year)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, country_code, name, fiscal_year' });
    const result = await query(`
      INSERT INTO work_calendars (company_id, country_code, name, fiscal_year,
        work_days, standard_hours, weekly_hours)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING uuid, name, fiscal_year
    `, [parseInt(company_id), country_code.toUpperCase(), name, parseInt(fiscal_year),
        work_days||[1,2,3,4,5], standard_hours||null, weekly_hours||null]);
    writeAudit({ userId: req.user.id, action: 'work_calendar_created',
      entityType: 'work_calendars', entityId: result.rows[0].uuid,
      companyId: parseInt(company_id), newValues: { country_code, fiscal_year },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// POST /api/admin/work-calendars/:uuid/holidays
router.post('/:uuid/holidays', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { holiday_date, name, name_en, holiday_type, holiday_scope, state_code, is_paid, country_code } = req.body;
    if (!holiday_date || !name)
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: holiday_date, name' });
    const cal = await query('SELECT id, company_id FROM work_calendars WHERE uuid=$1', [req.params.uuid]);
    if (!cal.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      INSERT INTO work_calendar_holidays
        (work_calendar_id, company_id, holiday_date, name, name_en,
         holiday_type, holiday_scope, state_code, is_paid, country_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, holiday_date, name
    `, [cal.rows[0].id, cal.rows[0].company_id, holiday_date, name, name_en||null,
        holiday_type||'official', holiday_scope||'federal', state_code||null,
        is_paid??true, country_code||null]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// DELETE /api/admin/work-calendars/:uuid/holidays/:holidayId
router.delete('/:uuid/holidays/:holidayId', async (req, res, next) => {
  if (!assertAdmin(req, res)) return;
  try {
    await query('DELETE FROM work_calendar_holidays WHERE id=$1', [parseInt(req.params.holidayId)]);
    res.json({ success: true, message: 'Holiday removed.' });
  } catch(e) { next(e); }
});

module.exports = router;
