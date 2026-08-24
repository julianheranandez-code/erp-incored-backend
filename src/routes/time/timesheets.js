'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');

router.use(verifyToken);

// GET /api/time/timesheets/:employee_uuid?week_start=YYYY-MM-DD
router.get('/:employee_uuid', async (req, res, next) => {
  try {
    const { week_start } = req.query;
    const emp = await query('SELECT id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    let conditions = ['ts.employee_id = $1'];
    let values = [emp.rows[0].id];
    let idx = 2;
    if (week_start) { conditions.push(`ts.week_start = $${idx++}`); values.push(week_start); }
    const result = await query(`
      SELECT ts.uuid, ts.week_start, ts.week_end,
        ts.regular_hours, ts.overtime_hours, ts.holiday_hours,
        ts.absence_hours, ts.total_hours, ts.days_worked, ts.days_absent,
        ts.status, ts.approved_at, ts.created_at
      FROM timesheet_summaries ts
      WHERE ${conditions.join(' AND ')}
      ORDER BY ts.week_start DESC
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/time/timesheets/:employee_uuid/recalculate
router.post('/:employee_uuid/recalculate', async (req, res, next) => {
  try {
    const { week_start } = req.body;
    if (!week_start) return res.status(400).json({ success: false, error: 'week_start required' });
    const emp = await query('SELECT id, company_id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const { id: empId, company_id } = emp.rows[0];
    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(company_id))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const weekEnd = new Date(week_start);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const weekEndStr = weekEnd.toISOString().slice(0,10);

    // Get all attendance records for the week
    const records = await query(`
      SELECT work_date, punch_in, punch_out, hours_worked, is_holiday, is_day_off
      FROM attendance_records
      WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3
    `, [empId, week_start, weekEndStr]);

    let regularHours = 0, overtimeHours = 0, holidayHours = 0, absenceHours = 0;
    let daysWorked = 0, daysAbsent = 0;

    // Get weekly hours threshold from company policies
    const policy = await query(`
      SELECT policy_value FROM company_policies
      WHERE company_id=$1 AND policy_domain='attendance' AND policy_key='weekly_hours'
    `, [company_id]);
    const weeklyThreshold = parseFloat(policy.rows[0]?.policy_value || 40);
    const dailyThreshold = weeklyThreshold / 5;

    for (const r of records.rows) {
      const hours = parseFloat(r.hours_worked || 0);
      if (r.is_holiday && hours > 0) {
        holidayHours += hours;
        daysWorked++;
      } else if (r.is_day_off) {
        daysAbsent++;
      } else if (r.punch_in && r.punch_out) {
        if (hours > dailyThreshold) {
          regularHours += dailyThreshold;
          overtimeHours += (hours - dailyThreshold);
        } else {
          regularHours += hours;
        }
        daysWorked++;
      } else if (r.punch_in && !r.punch_out) {
        // Half-punch: punch_in exists but no punch_out
        // Do NOT count as worked, do NOT count as absent
        // Silently excluded — correction required via PATCH /attendance/:uuid/correct
      } else if (!r.punch_in) {
        daysAbsent++;
        absenceHours += dailyThreshold;
      }
    }

    const totalHours = regularHours + overtimeHours + holidayHours;

    await query(`
      INSERT INTO timesheet_summaries
        (employee_id, company_id, week_start, week_end,
         regular_hours, overtime_hours, holiday_hours, absence_hours,
         total_hours, days_worked, days_absent, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open')
      ON CONFLICT (employee_id, week_start) DO UPDATE SET
        regular_hours=$5, overtime_hours=$6, holiday_hours=$7,
        absence_hours=$8, total_hours=$9, days_worked=$10,
        days_absent=$11, updated_at=NOW()
    `, [empId, company_id, week_start, weekEndStr,
        regularHours.toFixed(2), overtimeHours.toFixed(2),
        holidayHours.toFixed(2), absenceHours.toFixed(2),
        totalHours.toFixed(2), daysWorked, daysAbsent]);

    res.json({ success: true,
      data: { week_start, week_end: weekEndStr,
        regular_hours: regularHours.toFixed(2),
        overtime_hours: overtimeHours.toFixed(2),
        total_hours: totalHours.toFixed(2),
        days_worked: daysWorked, days_absent: daysAbsent },
      message: 'Timesheet recalculated.' });
  } catch(e) { next(e); }
});

module.exports = router;
