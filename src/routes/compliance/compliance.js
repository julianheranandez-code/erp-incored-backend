'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { writeAudit } = require('../../middleware/audit');

router.use(verifyToken);

// ─── REQUIREMENTS CATALOG ─────────────────────────────────────

router.get('/requirements', async (req, res, next) => {
  try {
    const { company_id, category, country_code } = req.query;
    let conditions = ['is_active = true'];
    let values = [];
    let idx = 1;
    if (category)     { conditions.push(`category = $${idx++}`); values.push(category); }
    if (country_code) { conditions.push(`(country_code = $${idx++} OR country_code IS NULL)`); values.push(country_code); }
    const result = await query(`
      SELECT uuid, requirement_code, name, name_en, country_code,
        category, frequency, alert_days, is_active
      FROM compliance_requirements
      WHERE ${conditions.join(' AND ')}
      ORDER BY category, requirement_code
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// ─── IMSS ENROLLMENTS ─────────────────────────────────────────

router.get('/imss/enrollments', async (req, res, next) => {
  try {
    const { company_id, status, employee_uuid } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    let conditions = ['ie.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (status)        { conditions.push(`ie.status = $${idx++}`); values.push(status); }
    if (employee_uuid) { conditions.push(`e.uuid = $${idx++}`); values.push(employee_uuid); }
    const result = await query(`
      SELECT ie.uuid, ie.nss, ie.sbc_daily, ie.enrollment_type,
        ie.event_date, ie.event_type, ie.status, ie.sua_batch_id,
        ie.record_source, ie.notes, ie.created_at,
        e.uuid AS employee_uuid, e.employee_number,
        CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal,e.last_name,'')) AS employee_name
      FROM imss_enrollments ie
      JOIN employees e ON e.id = ie.employee_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ie.event_date DESC
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

router.post('/imss/enrollments', async (req, res, next) => {
  try {
    const { employee_uuid, event_type, event_date, sbc_daily,
            enrollment_type = 'IMSS_regular', nss, sua_batch_id,
            record_source = 'web', source_reference, notes } = req.body;
    if (!employee_uuid || !event_type || !event_date || !sbc_daily)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: employee_uuid, event_type, event_date, sbc_daily' });

    const emp = await query(`
      SELECT e.id, e.company_id, eti.nss AS stored_nss
      FROM employees e
      LEFT JOIN employee_tax_identifiers eti ON eti.employee_id = e.id AND eti.country_code = 'MX'
      WHERE e.uuid = $1
    `, [employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const { id: empId, company_id } = emp.rows[0];
    const finalNss = nss || emp.rows[0].stored_nss || '00000000000';

    const result = await withTransaction(async (client) => {
      const ins = await client.query(`
        INSERT INTO imss_enrollments
          (employee_id, company_id, nss, sbc_daily, enrollment_type,
           event_date, event_type, sua_batch_id, record_source, source_reference,
           notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING uuid, event_type, event_date, status
      `, [empId, company_id, finalNss, parseFloat(sbc_daily),
          enrollment_type, event_date, event_type, sua_batch_id||null,
          record_source, source_reference||null, notes||null, req.user.id]);

      // Write employment event
      const eventMap = {
        'alta': 'imss_alta', 'baja': 'imss_baja',
        'modificacion_salario': 'imss_alta', 'incapacidad': 'leave_started'
      };
      await client.query(`
        INSERT INTO employment_events
          (employee_id, company_id, event_type, event_date, title, source, actor_id, metadata)
        VALUES ($1,$2,$3,$4,$5,'system',$6,$7)
      `, [empId, company_id, eventMap[event_type] || 'imss_alta', event_date,
          `IMSS ${event_type} registrado`, req.user.id,
          JSON.stringify({ event_type, sbc_daily, enrollment_type })]);

      return ins.rows[0];
    });

    writeAudit({ userId: req.user.id, action: `imss_${event_type}`,
      entityType: 'imss_enrollments', entityId: result.uuid,
      companyId: company_id, newValues: { event_type, event_date, sbc_daily },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    res.status(201).json({ success: true, data: result, message: `IMSS ${event_type} registered.` });
  } catch(e) { next(e); }
});

// ─── IMSS PAYMENTS ────────────────────────────────────────────

router.get('/imss/payments', async (req, res, next) => {
  try {
    const { company_id, year, status } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    let conditions = ['company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (year)   { conditions.push(`payment_period LIKE $${idx++}`); values.push(`${year}%`); }
    if (status) { conditions.push(`status = $${idx++}`); values.push(status); }
    const result = await query(`
      SELECT uuid, payment_period, due_date, amount_employee,
        amount_employer, amount_total, status, paid_date, reference
      FROM imss_payments WHERE ${conditions.join(' AND ')}
      ORDER BY payment_period DESC
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

router.post('/imss/payments', async (req, res, next) => {
  try {
    const { company_id, payment_period, due_date,
            amount_employee, amount_employer, notes } = req.body;
    if (!company_id || !payment_period || !due_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, payment_period, due_date' });
    const total = parseFloat(amount_employee || 0) + parseFloat(amount_employer || 0);
    const result = await query(`
      INSERT INTO imss_payments
        (company_id, payment_period, due_date, amount_employee, amount_employer, amount_total, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (company_id, payment_period) DO UPDATE SET
        due_date=$3, amount_employee=$4, amount_employer=$5,
        amount_total=$6, notes=$7, updated_at=NOW()
      RETURNING uuid, payment_period, amount_total, status
    `, [parseInt(company_id), payment_period, due_date,
        parseFloat(amount_employee||0), parseFloat(amount_employer||0),
        total, notes||null, req.user.id]);
    res.status(201).json({ success: true, data: result.rows[0], message: 'IMSS payment record created.' });
  } catch(e) { next(e); }
});

router.patch('/imss/payments/:uuid/pay', async (req, res, next) => {
  try {
    const { paid_date, reference, notes } = req.body;
    const result = await query(`
      UPDATE imss_payments SET status='paid', paid_date=$1,
        reference=$2, notes=COALESCE($3,notes), updated_at=NOW()
      WHERE uuid=$4 RETURNING uuid, payment_period, status
    `, [paid_date||new Date().toISOString().slice(0,10), reference||null,
        notes||null, req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0], message: 'IMSS payment marked as paid.' });
  } catch(e) { next(e); }
});

// ─── ISN PAYMENTS ─────────────────────────────────────────────

router.get('/isn/payments', async (req, res, next) => {
  try {
    const { company_id, year, status } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    let conditions = ['company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (year)   { conditions.push(`payment_period LIKE $${idx++}`); values.push(`${year}%`); }
    if (status) { conditions.push(`status = $${idx++}`); values.push(status); }
    const result = await query(`
      SELECT uuid, state_code, payment_period, taxable_payroll,
        isn_rate, amount_due, due_date, status, paid_date, reference
      FROM isn_payments WHERE ${conditions.join(' AND ')}
      ORDER BY payment_period DESC
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

router.post('/isn/payments', async (req, res, next) => {
  try {
    const { company_id, state_code, payment_period, taxable_payroll,
            isn_rate, due_date } = req.body;
    if (!company_id || !state_code || !payment_period || !taxable_payroll || !isn_rate || !due_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, state_code, payment_period, taxable_payroll, isn_rate, due_date' });
    const amount_due = parseFloat(taxable_payroll) * parseFloat(isn_rate);
    const result = await query(`
      INSERT INTO isn_payments
        (company_id, state_code, payment_period, taxable_payroll, isn_rate, amount_due, due_date, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (company_id, state_code, payment_period) DO UPDATE SET
        taxable_payroll=$4, isn_rate=$5, amount_due=$6, due_date=$7, updated_at=NOW()
      RETURNING uuid, payment_period, amount_due, status
    `, [parseInt(company_id), state_code, payment_period,
        parseFloat(taxable_payroll), parseFloat(isn_rate),
        amount_due, due_date, req.user.id]);
    res.status(201).json({ success: true, data: result.rows[0], message: 'ISN payment record created.' });
  } catch(e) { next(e); }
});

router.patch('/isn/payments/:uuid/pay', async (req, res, next) => {
  try {
    const { paid_date, reference } = req.body;
    const result = await query(`
      UPDATE isn_payments SET status='paid', paid_date=$1, reference=$2, updated_at=NOW()
      WHERE uuid=$3 RETURNING uuid, payment_period, status
    `, [paid_date||new Date().toISOString().slice(0,10), reference||null, req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0], message: 'ISN payment marked as paid.' });
  } catch(e) { next(e); }
});

// ─── ALERT SCANNER ────────────────────────────────────────────

async function upsertAlert(client, companyId, category, entityType, entityId, entityUuid, message, dueDate, severity) {
  await client.query(`
    INSERT INTO compliance_alerts
      (company_id, alert_category, entity_type, entity_id, entity_uuid,
       alert_message, due_date, severity, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open')
    ON CONFLICT DO NOTHING
  `, [companyId, category, entityType, entityId, entityUuid, message, dueDate, severity]);
}

function getSeverity(daysUntil) {
  if (daysUntil < 0)  return 'critical';
  if (daysUntil < 7)  return 'critical';
  if (daysUntil < 30) return 'high';
  if (daysUntil < 60) return 'medium';
  return 'low';
}

router.post('/alerts/scan', async (req, res, next) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const cid = parseInt(company_id);
    const today = new Date();
    const in90 = new Date(today); in90.setDate(in90.getDate() + 90);
    let alertsCreated = 0;

    await withTransaction(async (client) => {
      // 1. Skill expiries
      const skills = await client.query(`
        SELECT es.id, es.uuid, es.expiry_date, sc.name AS skill_name,
          e.id AS emp_id, e.employee_number
        FROM employee_skills es
        JOIN skills_catalog sc ON sc.id = es.skill_id
        JOIN employees e ON e.id = es.employee_id
        WHERE e.company_id=$1 AND es.expiry_date IS NOT NULL
          AND es.expiry_date <= $2 AND es.status='active'
      `, [cid, in90.toISOString().slice(0,10)]);

      for (const s of skills.rows) {
        const days = Math.floor((new Date(s.expiry_date) - today) / 86400000);
        const sev = getSeverity(days);
        const msg = `${s.skill_name} expira ${s.expiry_date} (Empleado ${s.employee_number})`;
        await upsertAlert(client, cid, 'skill_expiry', 'employee_skills',
          s.id, s.uuid, msg, s.expiry_date, sev);
        alertsCreated++;
      }

      // 2. Vehicle verification
      const vehicles = await client.query(`
        SELECT vd.id, vd.uuid, vd.verification_expiry, a.asset_number
        FROM vehicle_details vd
        JOIN assets a ON a.id = vd.asset_id
        WHERE a.company_id=$1 AND vd.verification_expiry IS NOT NULL
          AND vd.verification_expiry <= $2
      `, [cid, in90.toISOString().slice(0,10)]);

      for (const v of vehicles.rows) {
        const days = Math.floor((new Date(v.verification_expiry) - today) / 86400000);
        const msg = `Verificacion vehicular ${v.asset_number} vence ${v.verification_expiry}`;
        await upsertAlert(client, cid, 'vehicle_verification', 'vehicle_details',
          v.id, v.uuid, msg, v.verification_expiry, getSeverity(days));
        alertsCreated++;
      }

      // 3. Asset insurance expiry
      const insurance = await client.query(`
        SELECT ai.id, ai.uuid, ai.expiry_date, a.asset_number
        FROM asset_insurance ai
        JOIN assets a ON a.id = ai.asset_id
        WHERE a.company_id=$1 AND ai.is_current=true
          AND ai.expiry_date <= $2
      `, [cid, in90.toISOString().slice(0,10)]);

      for (const ins of insurance.rows) {
        const days = Math.floor((new Date(ins.expiry_date) - today) / 86400000);
        const msg = `Seguro activo de ${ins.asset_number} vence ${ins.expiry_date}`;
        await upsertAlert(client, cid, 'asset_insurance', 'asset_insurance',
          ins.id, ins.uuid, msg, ins.expiry_date, getSeverity(days));
        alertsCreated++;
      }

      // 4. I-9 expiry
      const i9 = await client.query(`
        SELECT eti.id, eti.employee_id, eti.i9_expiry_date,
          e.uuid AS emp_uuid, e.employee_number
        FROM employee_tax_identifiers eti
        JOIN employees e ON e.id = eti.employee_id
        WHERE e.company_id=$1 AND eti.country_code='US'
          AND eti.i9_expiry_date IS NOT NULL
          AND eti.i9_expiry_date <= $2
      `, [cid, in90.toISOString().slice(0,10)]);

      for (const i of i9.rows) {
        const days = Math.floor((new Date(i.i9_expiry_date) - today) / 86400000);
        const msg = `I-9 de ${i.employee_number} vence ${i.i9_expiry_date}`;
        await upsertAlert(client, cid, 'i9_expiry', 'employees',
          i.employee_id, i.emp_uuid, msg, i.i9_expiry_date, getSeverity(days));
        alertsCreated++;
      }

      // 5. Obligation payments due
      const in30 = new Date(today); in30.setDate(in30.getDate() + 30);
      const oblSchedules = await client.query(`
        SELECT os.id, os.uuid, os.due_date, os.total_amount,
          fo.obligation_number
        FROM obligation_schedules os
        JOIN financial_obligations fo ON fo.id = os.obligation_id
        WHERE fo.company_id=$1 AND os.status='pending'
          AND os.due_date <= $2
      `, [cid, in30.toISOString().slice(0,10)]);

      for (const o of oblSchedules.rows) {
        const days = Math.floor((new Date(o.due_date) - today) / 86400000);
        const msg = `Pago ${o.obligation_number}: $${o.total_amount} vence ${o.due_date}`;
        await upsertAlert(client, cid, 'obligation_payment', 'obligation_schedules',
          o.id, o.uuid, msg, o.due_date, getSeverity(days));
        alertsCreated++;
      }

      // 6. IMSS overdue payments
      const imssOverdue = await client.query(`
        SELECT id, uuid, payment_period, due_date, amount_total
        FROM imss_payments
        WHERE company_id=$1 AND status='pending' AND due_date < CURRENT_DATE
      `, [cid]);

      for (const im of imssOverdue.rows) {
        const msg = `IMSS periodo ${im.payment_period} vencido (${im.due_date})`;
        await upsertAlert(client, cid, 'imss_payment', 'imss_payments',
          im.id, im.uuid, msg, im.due_date, 'critical');
        alertsCreated++;
      }
    });

    res.json({ success: true, data: { alerts_created: alertsCreated },
      message: `Compliance scan complete. ${alertsCreated} alerts processed.` });
  } catch(e) { next(e); }
});

// ─── ALERTS ───────────────────────────────────────────────────

router.get('/alerts', async (req, res, next) => {
  try {
    const { company_id, severity, status, category, page = 1, limit = 50 } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let conditions = ['ca.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (severity) { conditions.push(`ca.severity = $${idx++}`); values.push(severity); }
    if (status)   { conditions.push(`ca.status = $${idx++}`); values.push(status); }
    if (category) { conditions.push(`ca.alert_category = $${idx++}`); values.push(category); }
    values.push(parseInt(limit), offset);
    const result = await query(`
      SELECT ca.uuid, ca.alert_category, ca.entity_type, ca.entity_uuid,
        ca.alert_message, ca.due_date, ca.severity, ca.status,
        ca.assigned_to, ca.target_resolution_date, ca.created_at,
        CONCAT(u.first_name,' ',u.last_name) AS assigned_to_name
      FROM compliance_alerts ca
      LEFT JOIN users u ON u.id = ca.assigned_to
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE ca.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
          WHEN 'medium' THEN 3 ELSE 4 END,
        ca.due_date ASC NULLS LAST
      LIMIT $${idx++} OFFSET $${idx++}
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

router.patch('/alerts/:uuid/resolve', async (req, res, next) => {
  try {
    const result = await query(`
      UPDATE compliance_alerts SET status='resolved', resolved_by=$1,
        resolved_at=NOW(), updated_at=NOW()
      WHERE uuid=$2 RETURNING uuid, alert_category, status
    `, [req.user.id, req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0], message: 'Alert resolved.' });
  } catch(e) { next(e); }
});

router.patch('/alerts/:uuid/dismiss', async (req, res, next) => {
  try {
    const result = await query(`
      UPDATE compliance_alerts SET status='dismissed', updated_at=NOW()
      WHERE uuid=$1 RETURNING uuid, alert_category, status
    `, [req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0], message: 'Alert dismissed.' });
  } catch(e) { next(e); }
});

router.patch('/alerts/:uuid/assign', async (req, res, next) => {
  try {
    const { assigned_to_uuid, target_resolution_date } = req.body;
    let userId = null;
    if (assigned_to_uuid) {
      const u = await query('SELECT id FROM users WHERE uuid=$1 OR id::text=$1', [assigned_to_uuid]);
      userId = u.rows[0]?.id || null;
    }
    const result = await query(`
      UPDATE compliance_alerts SET assigned_to=$1, target_resolution_date=$2,
        status='acknowledged', updated_at=NOW()
      WHERE uuid=$3 RETURNING uuid, alert_category, status
    `, [userId, target_resolution_date||null, req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0], message: 'Alert assigned.' });
  } catch(e) { next(e); }
});

// ─── OSHA INCIDENTS ───────────────────────────────────────────

router.get('/osha/incidents', async (req, res, next) => {
  try {
    const { company_id, status, year } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    let conditions = ['oi.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (status) { conditions.push(`oi.status = $${idx++}`); values.push(status); }
    if (year)   { conditions.push(`EXTRACT(YEAR FROM oi.incident_date) = $${idx++}`); values.push(parseInt(year)); }
    const result = await query(`
      SELECT oi.uuid, oi.incident_date, oi.incident_type, oi.severity,
        oi.days_lost, oi.recordable, oi.osha_300_reportable,
        oi.status, oi.record_source, oi.created_at,
        e.uuid AS employee_uuid, e.employee_number,
        CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal,e.last_name,'')) AS employee_name
      FROM osha_incidents oi
      JOIN employees e ON e.id = oi.employee_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY oi.incident_date DESC
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

router.post('/osha/incidents', async (req, res, next) => {
  try {
    const { company_id, employee_uuid, incident_date, incident_type,
            description, location, severity = 'minor', days_lost = 0,
            recordable = false, osha_300_reportable = false,
            root_cause, corrective_action,
            record_source = 'web', source_reference } = req.body;
    if (!company_id || !employee_uuid || !incident_date || !incident_type || !description)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, employee_uuid, incident_date, incident_type, description' });
    const emp = await query('SELECT id FROM employees WHERE uuid=$1', [employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      INSERT INTO osha_incidents
        (company_id, employee_id, incident_date, incident_type, description,
         location, severity, days_lost, recordable, osha_300_reportable,
         root_cause, corrective_action, record_source, source_reference, reported_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING uuid, incident_date, incident_type, severity, status
    `, [parseInt(company_id), emp.rows[0].id, incident_date, incident_type,
        description, location||null, severity, parseInt(days_lost),
        recordable, osha_300_reportable, root_cause||null, corrective_action||null,
        record_source, source_reference||null, req.user.id]);
    writeAudit({ userId: req.user.id, action: 'osha_incident_created',
      entityType: 'osha_incidents', entityId: result.rows[0].uuid,
      companyId: parseInt(company_id), newValues: { incident_date, incident_type, severity },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.status(201).json({ success: true, data: result.rows[0], message: 'OSHA incident recorded.' });
  } catch(e) { next(e); }
});

// ─── DASHBOARD ────────────────────────────────────────────────

router.get('/dashboard', async (req, res, next) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const cid = parseInt(company_id);

    const [alerts, imssPayments, openIncidents] = await Promise.all([
      query(`
        SELECT severity, COUNT(*) AS count
        FROM compliance_alerts WHERE company_id=$1 AND status='open'
        GROUP BY severity
      `, [cid]),
      query(`
        SELECT COUNT(*) AS overdue FROM imss_payments
        WHERE company_id=$1 AND status='pending' AND due_date < CURRENT_DATE
      `, [cid]),
      query(`
        SELECT COUNT(*) AS open FROM osha_incidents
        WHERE company_id=$1 AND status IN ('open','under_investigation')
      `, [cid])
    ]);

    const alertSummary = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const row of alerts.rows) {
      alertSummary[row.severity] = parseInt(row.count);
    }

    const totalAlerts = Object.values(alertSummary).reduce((a, b) => a + b, 0);
    const criticalHigh = alertSummary.critical + alertSummary.high;

    res.json({ success: true, data: {
      alerts: alertSummary,
      total_open_alerts: totalAlerts,
      critical_high_alerts: criticalHigh,
      imss_overdue_payments: parseInt(imssPayments.rows[0].overdue),
      open_osha_incidents: parseInt(openIncidents.rows[0].open),
      health_status: criticalHigh === 0 ? 'green' : criticalHigh < 3 ? 'yellow' : 'red'
    }});
  } catch(e) { next(e); }
});

module.exports = router;
