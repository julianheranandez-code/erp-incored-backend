'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { writeAudit } = require('../../middleware/audit');

router.use(verifyToken);

// GET /api/time/schedules/:employee_uuid
router.get('/:employee_uuid', async (req, res, next) => {
  try {
    const emp = await query('SELECT id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT es.uuid, es.effective_date, es.end_date, es.is_current, es.notes,
        wc.uuid AS work_calendar_uuid, wc.name AS work_calendar_name,
        wc.country_code, wc.weekly_hours, wc.standard_hours, wc.fiscal_year
      FROM employee_schedules es
      JOIN work_calendars wc ON wc.id = es.work_calendar_id
      WHERE es.employee_id=$1
      ORDER BY es.effective_date DESC
    `, [emp.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/time/schedules/:employee_uuid
router.post('/:employee_uuid', async (req, res, next) => {
  try {
    const { work_calendar_uuid, effective_date, notes } = req.body;
    if (!work_calendar_uuid || !effective_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: work_calendar_uuid, effective_date' });

    const emp = await query('SELECT id, company_id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const wc = await query('SELECT id FROM work_calendars WHERE uuid=$1', [work_calendar_uuid]);
    if (!wc.rows[0]) return res.status(404).json({ success: false, error: 'work_calendar_not_found' });

    const { id: empId, company_id } = emp.rows[0];

    // Close previous current schedule
    await query(`
      UPDATE employee_schedules SET is_current=false, end_date=$1, updated_at=NOW()
      WHERE employee_id=$2 AND is_current=true
    `, [effective_date, empId]);

    const result = await query(`
      INSERT INTO employee_schedules
        (employee_id, company_id, work_calendar_id, effective_date, is_current, notes, created_by)
      VALUES ($1,$2,$3,$4,true,$5,$6)
      RETURNING uuid, effective_date
    `, [empId, company_id, wc.rows[0].id, effective_date, notes||null, req.user.id]);

    writeAudit({ userId: req.user.id, action: 'schedule_assigned',
      entityType: 'employee_schedules', entityId: result.rows[0].uuid,
      companyId: company_id, newValues: { effective_date, work_calendar_uuid },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    res.status(201).json({ success: true, data: result.rows[0], message: 'Schedule assigned.' });
  } catch(e) { next(e); }
});

module.exports = router;
