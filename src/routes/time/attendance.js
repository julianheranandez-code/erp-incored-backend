'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { writeAudit } = require('../../middleware/audit');

router.use(verifyToken);

// GET /api/time/attendance?company_id=X&employee_uuid=Y&from=&to=
router.get('/', async (req, res, next) => {
  try {
    const { company_id, employee_uuid, from_date, to_date, page = 1, limit = 20 } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let conditions = ['ar.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (employee_uuid) {
      conditions.push(`e.uuid = $${idx++}`);
      values.push(employee_uuid);
    }
    if (from_date) { conditions.push(`ar.work_date >= $${idx++}`); values.push(from_date); }
    if (to_date)   { conditions.push(`ar.work_date <= $${idx++}`); values.push(to_date); }
    const countResult = await query(
      `SELECT COUNT(*) FROM attendance_records ar JOIN employees e ON e.id = ar.employee_id WHERE ${conditions.join(' AND ')}`,
      values
    );
    const total = parseInt(countResult.rows[0].count);
    values.push(parseInt(limit), offset);
    const result = await query(`
      SELECT ar.uuid, ar.work_date, ar.punch_in, ar.punch_out,
        ar.hours_worked, ar.attendance_source, ar.source_reference,
        ar.is_holiday, ar.is_day_off, ar.notes,
        e.uuid AS employee_uuid, e.employee_number,
        TRIM(CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal,e.last_name,''))) AS employee_name
      FROM attendance_records ar
      JOIN employees e ON e.id = ar.employee_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ar.work_date DESC, e.employee_number
      LIMIT $${idx++} OFFSET $${idx++}
    `, values);
    res.json({ success: true, count: result.rows.length, total,
      page: parseInt(page), total_pages: Math.ceil(total / parseInt(limit)),
      data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/time/attendance/:employee_uuid/today
router.get('/:employee_uuid/today', async (req, res, next) => {
  try {
    const emp = await query('SELECT id, company_id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(emp.rows[0].company_id))
      return res.status(403).json({ success: false, error: 'forbidden' });
    const today = new Date().toISOString().slice(0,10);
    const result = await query(`
      SELECT uuid, work_date, punch_in, punch_out, hours_worked,
        attendance_source, is_holiday, is_day_off, notes
      FROM attendance_records
      WHERE employee_id=$1 AND work_date=$2
    `, [emp.rows[0].id, today]);
    res.json({ success: true, data: result.rows[0] || null });
  } catch(e) { next(e); }
});

// GET /api/time/attendance/:employee_uuid/week?week_start=YYYY-MM-DD
router.get('/:employee_uuid/week', async (req, res, next) => {
  try {
    const { week_start } = req.query;
    if (!week_start) return res.status(400).json({ success: false, error: 'week_start required' });
    const emp = await query('SELECT id, company_id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(emp.rows[0].company_id))
      return res.status(403).json({ success: false, error: 'forbidden' });
    const weekEnd = new Date(week_start);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const result = await query(`
      SELECT uuid, work_date, punch_in, punch_out, hours_worked,
        attendance_source, is_holiday, is_day_off, notes
      FROM attendance_records
      WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3
      ORDER BY work_date
    `, [emp.rows[0].id, week_start, weekEnd.toISOString().slice(0,10)]);
    const totalHours = result.rows.reduce((sum, r) => sum + parseFloat(r.hours_worked || 0), 0);
    const daysWorked = result.rows.filter(r => r.punch_in && r.punch_out && !r.is_day_off).length;
    res.json({ success: true, week_start, week_end: weekEnd.toISOString().slice(0,10),
      total_hours: totalHours.toFixed(2), days_worked: daysWorked,
      data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/time/attendance/:employee_uuid/punch-in
router.post('/:employee_uuid/punch-in', async (req, res, next) => {
  try {
    const { notes, location, attendance_source = 'web', source_reference } = req.body;
    const emp = await query('SELECT id, company_id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const { id: empId, company_id } = emp.rows[0];
    const today = new Date().toISOString().slice(0,10);
    const now = new Date().toISOString();

    // Check not already punched in
    const existing = await query(
      'SELECT id, punch_in, punch_out FROM attendance_records WHERE employee_id=$1 AND work_date=$2',
      [empId, today]
    );
    if (existing.rows[0]?.punch_in && !existing.rows[0]?.punch_out)
      return res.status(409).json({ success: false, error: 'already_punched_in',
        message: 'Employee is already punched in for today.' });

    let record;
    if (existing.rows[0]) {
      // Update existing record (re-punch after punch-out correction)
      const upd = await query(`
        UPDATE attendance_records SET punch_in=$1, punch_out=null, hours_worked=null,
          punch_in_by=$2, location_in=$3, attendance_source=$4, source_reference=$5,
          notes=$6, updated_at=NOW()
        WHERE employee_id=$7 AND work_date=$8 RETURNING uuid
      `, [now, req.user.id, location||null, attendance_source, source_reference||null,
          notes||null, empId, today]);
      record = upd.rows[0];
    } else {
      const ins = await query(`
        INSERT INTO attendance_records
          (employee_id, company_id, work_date, punch_in, punch_in_by,
           location_in, attendance_source, source_reference, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING uuid
      `, [empId, company_id, today, now, req.user.id,
          location||null, attendance_source, source_reference||null, notes||null]);
      record = ins.rows[0];
    }

    writeAudit({ userId: req.user.id, action: 'punch_in',
      entityType: 'attendance_records', entityId: record.uuid,
      companyId: company_id, newValues: { work_date: today, punch_in: now },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    res.status(201).json({ success: true, data: { uuid: record.uuid, punch_in: now, work_date: today },
      message: 'Punch in recorded.' });
  } catch(e) { next(e); }
});

// POST /api/time/attendance/:employee_uuid/punch-out
router.post('/:employee_uuid/punch-out', async (req, res, next) => {
  try {
    const { notes, location, attendance_source = 'web', source_reference } = req.body;
    const emp = await query('SELECT id, company_id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const { id: empId, company_id } = emp.rows[0];
    const today = new Date().toISOString().slice(0,10);
    const now = new Date();

    const existing = await query(
      'SELECT id, uuid, punch_in FROM attendance_records WHERE employee_id=$1 AND work_date=$2',
      [empId, today]
    );
    if (!existing.rows[0]?.punch_in)
      return res.status(400).json({ success: false, error: 'not_punched_in',
        message: 'No punch-in found for today.' });

    const punchIn = new Date(existing.rows[0].punch_in);
    const hoursWorked = ((now - punchIn) / (1000 * 60 * 60)).toFixed(2);

    const result = await query(`
      UPDATE attendance_records SET punch_out=$1, punch_out_by=$2,
        location_out=$3, hours_worked=$4, updated_at=NOW(),
        notes=COALESCE($5, notes)
      WHERE employee_id=$6 AND work_date=$7
      RETURNING uuid, punch_in, punch_out, hours_worked
    `, [now.toISOString(), req.user.id, location||null, hoursWorked,
        notes||null, empId, today]);

    writeAudit({ userId: req.user.id, action: 'punch_out',
      entityType: 'attendance_records', entityId: result.rows[0].uuid,
      companyId: company_id, newValues: { hours_worked: hoursWorked },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    res.json({ success: true, data: result.rows[0], message: `Punch out recorded. Hours worked: ${hoursWorked}` });
  } catch(e) { next(e); }
});

// PATCH /api/time/attendance/:uuid/correct
router.patch('/:uuid/correct', async (req, res, next) => {
  try {
    const { punch_in, punch_out, notes, reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, error: 'reason required' });

    // Fetch record + employee company
    const recResult = await query(
      `SELECT ar.id, ar.uuid, ar.employee_id, ar.company_id,
              ar.punch_in, ar.punch_out, ar.hours_worked,
              ar.attendance_source, ar.source_reference, ar.notes
       FROM attendance_records ar
       WHERE ar.uuid = $1`,
      [req.params.uuid]
    );
    if (!recResult.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const rec = recResult.rows[0];

    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(rec.company_id))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const oldValues = {
      punch_in: rec.punch_in, punch_out: rec.punch_out,
      hours_worked: rec.hours_worked, notes: rec.notes,
      attendance_source: rec.attendance_source
    };

    // Recalculate hours if both times provided
    const newPunchIn  = punch_in  !== undefined ? punch_in  : rec.punch_in;
    const newPunchOut = punch_out !== undefined ? punch_out : rec.punch_out;
    let hoursWorked = rec.hours_worked;
    if (newPunchIn && newPunchOut) {
      const ms = new Date(newPunchOut) - new Date(newPunchIn);
      hoursWorked = ms > 0 ? (ms / 3600000).toFixed(2) : 0;
    }

    await query(
      `UPDATE attendance_records
       SET punch_in=$1, punch_out=$2, hours_worked=$3,
           notes=$4, attendance_source='manual'
       WHERE id=$5`,
      [newPunchIn, newPunchOut, hoursWorked,
       notes !== undefined ? notes : rec.notes, rec.id]
    );

    writeAudit({
      userId: req.user.id, action: 'attendance_corrected',
      entityType: 'attendance_records', entityId: rec.uuid,
      companyId: rec.company_id,
      oldValues,
      newValues: { punch_in: newPunchIn, punch_out: newPunchOut,
                   hours_worked: hoursWorked, notes, reason,
                   corrected_by: req.user.id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    // Auto-recalculate timesheet for the affected week
    try {
      const workDate = rec.work_date
        ? rec.work_date.toISOString ? rec.work_date.toISOString().slice(0,10) : String(rec.work_date).slice(0,10)
        : newPunchIn ? new Date(newPunchIn).toISOString().slice(0,10) : null;
      if (workDate) {
        const d = new Date(workDate);
        const day = d.getDay(); // 0=Sun
        const diffToMon = (day === 0 ? -6 : 1 - day);
        d.setDate(d.getDate() + diffToMon);
        const weekStart = d.toISOString().slice(0,10);
        const weekEnd = new Date(d);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const weekEndStr = weekEnd.toISOString().slice(0,10);

        const records = await query(`
          SELECT work_date, punch_in, punch_out, hours_worked, is_holiday, is_day_off
          FROM attendance_records
          WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3
        `, [rec.employee_id, weekStart, weekEndStr]);

        const policy = await query(`
          SELECT policy_value FROM company_policies
          WHERE company_id=$1 AND policy_domain='attendance' AND policy_key='weekly_hours'
        `, [rec.company_id]);
        const weeklyThreshold = parseFloat(policy.rows[0]?.policy_value || 40);
        const dailyThreshold = weeklyThreshold / 5;

        let regularHours = 0, overtimeHours = 0, holidayHours = 0, absenceHours = 0;
        let daysWorked = 0, daysAbsent = 0;

        for (const r of records.rows) {
          const hours = parseFloat(r.hours_worked || 0);
          if (r.is_holiday && hours > 0) {
            holidayHours += hours; daysWorked++;
          } else if (r.is_day_off) {
            daysAbsent++;
          } else if (r.punch_in && r.punch_out) {
            if (hours > dailyThreshold) {
              regularHours += dailyThreshold;
              overtimeHours += (hours - dailyThreshold);
            } else { regularHours += hours; }
            daysWorked++;
          } else if (r.punch_in && !r.punch_out) {
            // half-punch: flag as exception, do not count hours or absence
          } else if (!r.punch_in) {
            daysAbsent++; absenceHours += dailyThreshold;
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
        `, [rec.employee_id, rec.company_id, weekStart, weekEndStr,
            regularHours.toFixed(2), overtimeHours.toFixed(2),
            holidayHours.toFixed(2), absenceHours.toFixed(2),
            totalHours.toFixed(2), daysWorked, daysAbsent]);
      }
    } catch(tsErr) {
      // Non-fatal: timesheet recalculation failed, log but do not fail correction
      console.error('Auto-recalculate timesheet failed after correction:', tsErr.message);
    }

    res.json({ success: true,
      data: { uuid: rec.uuid, punch_in: newPunchIn, punch_out: newPunchOut,
              hours_worked: hoursWorked, attendance_source: 'manual' },
      message: 'Attendance record corrected.' });
  } catch(e) { next(e); }
});

module.exports = router;
