'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { writeAudit } = require('../../middleware/audit');

router.use(verifyToken);

// GET /api/time/leave/types?country_code=MX
router.get('/types', async (req, res, next) => {
  try {
    const { country_code, company_id } = req.query;
    let conditions = ['is_active = true'];
    let values = [];
    let idx = 1;
    if (country_code) { conditions.push(`(country_code = $${idx++} OR country_code IS NULL)`); values.push(country_code); }
    const result = await query(`
      SELECT uuid, code, name, name_en, country_code,
        affects_payroll, requires_approval, max_days_per_year, is_paid
      FROM leave_types WHERE ${conditions.join(' AND ')}
      ORDER BY country_code NULLS LAST, name
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/time/leave/balances/:employee_uuid?fiscal_year=2026
router.get('/balances/:employee_uuid', async (req, res, next) => {
  try {
    const { fiscal_year = new Date().getFullYear() } = req.query;
    const emp = await query('SELECT id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT lb.uuid, lt.code, lt.name, lt.name_en, lt.is_paid,
        lb.fiscal_year, lb.accrued_days, lb.used_days, lb.pending_days,
        lb.carried_over,
        (lb.accrued_days + lb.carried_over - lb.used_days - lb.pending_days) AS available_days
      FROM leave_balances lb
      JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE lb.employee_id=$1 AND lb.fiscal_year=$2
      ORDER BY lt.name
    `, [emp.rows[0].id, parseInt(fiscal_year)]);
    res.json({ success: true, count: result.rows.length, fiscal_year: parseInt(fiscal_year), data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/time/leave/requests?company_id=X&status=pending&employee_uuid=Y
router.get('/requests', async (req, res, next) => {
  try {
    const { company_id, status, employee_uuid, page = 1, limit = 20 } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let conditions = ['lr.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (status) { conditions.push(`lr.status = $${idx++}`); values.push(status); }
    if (employee_uuid) { conditions.push(`e.uuid = $${idx++}`); values.push(employee_uuid); }
    values.push(parseInt(limit), offset);
    const result = await query(`
      SELECT lr.uuid, lr.start_date, lr.end_date, lr.days_requested,
        lr.reason, lr.status, lr.created_at,
        lt.name AS leave_type_name, lt.code AS leave_type_code,
        e.uuid AS employee_uuid, e.employee_number,
        TRIM(CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal,e.last_name,''))) AS employee_name
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN employees e ON e.id = lr.employee_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY lr.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/time/leave/requests
router.post('/requests', async (req, res, next) => {
  try {
    const { employee_uuid, leave_type_uuid, start_date, end_date, reason } = req.body;
    if (!employee_uuid || !leave_type_uuid || !start_date || !end_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: employee_uuid, leave_type_uuid, start_date, end_date' });

    const emp = await query('SELECT id, company_id FROM employees WHERE uuid=$1', [employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'employee_not_found' });

    const lt = await query('SELECT id, name, requires_approval, max_days_per_year FROM leave_types WHERE uuid=$1', [leave_type_uuid]);
    if (!lt.rows[0]) return res.status(404).json({ success: false, error: 'leave_type_not_found' });

    const { id: empId, company_id } = emp.rows[0];
    const { id: ltId, requires_approval } = lt.rows[0];

    // Calculate business days (simple: count weekdays between dates)
    const start = new Date(start_date);
    const end = new Date(end_date);
    let daysRequested = 0;
    const current = new Date(start);
    while (current <= end) {
      const day = current.getDay();
      if (day !== 0 && day !== 6) daysRequested++;
      current.setDate(current.getDate() + 1);
    }

    // Check balance
    const balance = await query(`
      SELECT accrued_days + carried_over - used_days - pending_days AS available
      FROM leave_balances
      WHERE employee_id=$1 AND leave_type_id=$2 AND fiscal_year=$3
    `, [empId, ltId, new Date().getFullYear()]);

    if (balance.rows[0] && parseFloat(balance.rows[0].available) < daysRequested)
      return res.status(422).json({ success: false, error: 'insufficient_balance',
        message: `Available: ${balance.rows[0].available} days. Requested: ${daysRequested} days.` });

    let reqUuid;
    await withTransaction(async (client) => {
      const reqResult = await client.query(`
        INSERT INTO leave_requests
          (employee_id, company_id, leave_type_id, start_date, end_date,
           days_requested, reason, status, requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING uuid, id
      `, [empId, company_id, ltId, start_date, end_date,
          daysRequested, reason||null,
          requires_approval ? 'pending' : 'approved', req.user.id]);
      reqUuid = reqResult.rows[0].uuid;

      // Update pending_days in balance
      if (balance.rows[0]) {
        await client.query(`
          UPDATE leave_balances SET pending_days = pending_days + $1, updated_at=NOW()
          WHERE employee_id=$2 AND leave_type_id=$3 AND fiscal_year=$4
        `, [daysRequested, empId, ltId, new Date().getFullYear()]);
      }

      // Write employment event
      await client.query(`
        INSERT INTO employment_events
          (employee_id, company_id, event_type, event_date, title, source, actor_id, metadata)
        VALUES ($1,$2,'leave_started',$3,$4,'system',$5,$6)
      `, [empId, company_id, start_date,
          `Leave requested: ${lt.rows[0].name}`,
          req.user.id, JSON.stringify({ days: daysRequested, leave_type: lt.rows[0].name })]);
    });

    writeAudit({ userId: req.user.id, action: 'leave_request_created',
      entityType: 'leave_requests', entityId: reqUuid,
      companyId: company_id, newValues: { start_date, end_date, days_requested: daysRequested },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    res.status(201).json({ success: true,
      data: { uuid: reqUuid, days_requested: daysRequested, status: requires_approval ? 'pending' : 'approved' },
      message: `Leave request created. ${daysRequested} days requested.` });
  } catch(e) { next(e); }
});

// POST /api/time/leave/requests/:uuid/approve
router.post('/requests/:uuid/approve', async (req, res, next) => {
  try {
    const lr = await query('SELECT * FROM leave_requests WHERE uuid=$1', [req.params.uuid]);
    if (!lr.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    if (lr.rows[0].status !== 'pending')
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: 'Only pending requests can be approved.' });

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE leave_requests SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
        WHERE uuid=$2
      `, [req.user.id, req.params.uuid]);

      // Move from pending to used
      await client.query(`
        UPDATE leave_balances SET
          used_days = used_days + $1,
          pending_days = GREATEST(0, pending_days - $1),
          updated_at=NOW()
        WHERE employee_id=$2 AND leave_type_id=$3 AND fiscal_year=$4
      `, [lr.rows[0].days_requested, lr.rows[0].employee_id,
          lr.rows[0].leave_type_id, new Date().getFullYear()]);
    });

    writeAudit({ userId: req.user.id, action: 'leave_request_approved',
      entityType: 'leave_requests', entityId: req.params.uuid,
      companyId: lr.rows[0].company_id, ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    res.json({ success: true, message: 'Leave request approved.' });
  } catch(e) { next(e); }
});

// POST /api/time/leave/requests/:uuid/reject
router.post('/requests/:uuid/reject', async (req, res, next) => {
  try {
    const { reason } = req.body;
    const lr = await query('SELECT * FROM leave_requests WHERE uuid=$1', [req.params.uuid]);
    if (!lr.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    if (!['pending'].includes(lr.rows[0].status))
      return res.status(400).json({ success: false, error: 'invalid_status' });

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE leave_requests SET status='rejected', rejection_reason=$1, updated_at=NOW()
        WHERE uuid=$2
      `, [reason||null, req.params.uuid]);

      await client.query(`
        UPDATE leave_balances SET
          pending_days = GREATEST(0, pending_days - $1), updated_at=NOW()
        WHERE employee_id=$2 AND leave_type_id=$3 AND fiscal_year=$4
      `, [lr.rows[0].days_requested, lr.rows[0].employee_id,
          lr.rows[0].leave_type_id, new Date().getFullYear()]);
    });

    res.json({ success: true, message: 'Leave request rejected.' });
  } catch(e) { next(e); }
});

// POST /api/time/leave/requests/:uuid/cancel
router.post('/requests/:uuid/cancel', async (req, res, next) => {
  try {
    const lr = await query('SELECT * FROM leave_requests WHERE uuid=$1', [req.params.uuid]);
    if (!lr.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    if (!['draft','pending'].includes(lr.rows[0].status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: 'Only draft or pending requests can be cancelled.' });

    await withTransaction(async (client) => {
      await client.query(`UPDATE leave_requests SET status='cancelled', updated_at=NOW() WHERE uuid=$1`, [req.params.uuid]);
      if (lr.rows[0].status === 'pending') {
        await client.query(`
          UPDATE leave_balances SET
            pending_days = GREATEST(0, pending_days - $1), updated_at=NOW()
          WHERE employee_id=$2 AND leave_type_id=$3 AND fiscal_year=$4
        `, [lr.rows[0].days_requested, lr.rows[0].employee_id,
            lr.rows[0].leave_type_id, new Date().getFullYear()]);
      }
    });

    res.json({ success: true, message: 'Leave request cancelled.' });
  } catch(e) { next(e); }
});

module.exports = router;
