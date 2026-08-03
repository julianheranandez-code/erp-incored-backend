'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { writeAudit } = require('../../middleware/audit');

router.use(verifyToken);

async function generateObligationNumber() {
  const result = await query("SELECT 'OBL-' || LPAD(nextval('obligation_number_seq')::text, 6, '0') AS obl_number");
  return result.rows[0].obl_number;
}

// ─── CREDITORS ────────────────────────────────────────────────

// GET /api/obligations/creditors?company_id=X&type=bank
router.get('/creditors', async (req, res, next) => {
  try {
    const { company_id, creditor_type, search } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    let conditions = ['company_id = $1', 'is_active = true'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (creditor_type) { conditions.push(`creditor_type = $${idx++}`); values.push(creditor_type); }
    if (search) {
      conditions.push(`name ILIKE $${idx++}`);
      values.push('%' + search + '%');
    }
    const result = await query(`
      SELECT uuid, creditor_type, name, contact_name, contact_email,
        contact_phone, country_code, notes, is_active, created_at
      FROM creditors WHERE ${conditions.join(' AND ')}
      ORDER BY creditor_type, name
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/obligations/creditors
router.post('/creditors', async (req, res, next) => {
  try {
    const { company_id, creditor_type, name, contact_name, contact_email,
            contact_phone, country_code = 'MX', notes } = req.body;
    if (!company_id || !creditor_type || !name)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, creditor_type, name' });
    const result = await query(`
      INSERT INTO creditors
        (company_id, creditor_type, name, contact_name, contact_email,
         contact_phone, country_code, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING uuid, name, creditor_type
    `, [parseInt(company_id), creditor_type, name, contact_name||null,
        contact_email||null, contact_phone||null, country_code, notes||null, req.user.id]);
    writeAudit({ userId: req.user.id, action: 'creditor_created',
      entityType: 'creditors', entityId: result.rows[0].uuid,
      companyId: parseInt(company_id), newValues: { name, creditor_type },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.status(201).json({ success: true, data: result.rows[0], message: 'Creditor created.' });
  } catch(e) { next(e); }
});

// PUT /api/obligations/creditors/:uuid
router.put('/creditors/:uuid', async (req, res, next) => {
  try {
    const allowed = ['creditor_type','name','contact_name','contact_email',
                     'contact_phone','country_code','notes','is_active'];
    const fields = []; const params = []; let idx = 1;
    for (const key of allowed) {
      if (key in req.body) { fields.push(`${key} = $${idx++}`); params.push(req.body[key]); }
    }
    if (!fields.length) return res.status(400).json({ success: false, error: 'no_fields' });
    params.push(req.params.uuid);
    const result = await query(
      `UPDATE creditors SET ${fields.join(', ')}, updated_at=NOW() WHERE uuid=$${idx} RETURNING uuid, name`,
      params);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// ─── OBLIGATIONS ──────────────────────────────────────────────

// GET /api/obligations?company_id=X&status=active
router.get('/', async (req, res, next) => {
  try {
    const { company_id, status, obligation_type, page = 1, limit = 20 } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let conditions = ['fo.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (status)          { conditions.push(`fo.status = $${idx++}`); values.push(status); }
    if (obligation_type) { conditions.push(`fo.obligation_type = $${idx++}`); values.push(obligation_type); }
    const countResult = await query(
      `SELECT COUNT(*) FROM financial_obligations fo WHERE ${conditions.join(' AND ')}`, values);
    const total = parseInt(countResult.rows[0].count);
    values.push(parseInt(limit), offset);
    const result = await query(`
      SELECT fo.uuid, fo.obligation_number, fo.obligation_type, fo.description,
        fo.principal_amount, fo.outstanding_principal, fo.currency,
        fo.interest_rate, fo.interest_type, fo.status,
        fo.start_date, fo.maturity_date, fo.payment_frequency,
        fo.total_paid, fo.origin_source,
        c.name AS creditor_name, c.creditor_type
      FROM financial_obligations fo
      JOIN creditors c ON c.id = fo.creditor_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY fo.obligation_number
      LIMIT $${idx++} OFFSET $${idx++}
    `, values);
    res.json({ success: true, count: result.rows.length, total,
      page: parseInt(page), total_pages: Math.ceil(total / parseInt(limit)),
      data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/obligations/summary?company_id=X
router.get('/summary', async (req, res, next) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const totals = await query(`
      SELECT currency,
        COUNT(*) AS total_obligations,
        SUM(principal_amount) AS total_principal,
        SUM(outstanding_principal) AS total_outstanding,
        SUM(total_paid) AS total_paid
      FROM financial_obligations
      WHERE company_id=$1 AND status='active'
      GROUP BY currency
    `, [parseInt(company_id)]);
    const byType = await query(`
      SELECT obligation_type, COUNT(*) AS count,
        SUM(outstanding_principal) AS outstanding
      FROM financial_obligations
      WHERE company_id=$1 AND status='active'
      GROUP BY obligation_type ORDER BY outstanding DESC
    `, [parseInt(company_id)]);
    const upcoming = await query(`
      SELECT COUNT(*) AS count, SUM(total_amount) AS total
      FROM obligation_schedules os
      JOIN financial_obligations fo ON fo.id = os.obligation_id
      WHERE fo.company_id=$1 AND os.status='pending'
        AND os.due_date <= CURRENT_DATE + INTERVAL '30 days'
    `, [parseInt(company_id)]);
    res.json({ success: true, data: {
      totals: totals.rows,
      by_type: byType.rows,
      upcoming_30_days: upcoming.rows[0]
    }});
  } catch(e) { next(e); }
});

// GET /api/obligations/alerts/upcoming?company_id=X&days=30
router.get('/alerts/upcoming', async (req, res, next) => {
  try {
    const { company_id, days = 30 } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + parseInt(days));
    const result = await query(`
      SELECT os.uuid AS schedule_uuid, os.due_date, os.total_amount,
        os.principal_amount, os.interest_amount, os.status AS schedule_status,
        fo.uuid AS obligation_uuid, fo.obligation_number, fo.obligation_type,
        fo.currency, fo.outstanding_principal,
        c.name AS creditor_name, c.creditor_type
      FROM obligation_schedules os
      JOIN financial_obligations fo ON fo.id = os.obligation_id
      JOIN creditors c ON c.id = fo.creditor_id
      WHERE fo.company_id=$1
        AND os.status IN ('pending','overdue')
        AND os.due_date <= $2
      ORDER BY os.due_date ASC
    `, [parseInt(company_id), futureDate.toISOString().slice(0,10)]);
    res.json({ success: true, count: result.rows.length, days: parseInt(days), data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/obligations/:uuid
router.get('/:uuid', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT fo.uuid, fo.obligation_number, fo.obligation_type, fo.description,
        fo.principal_amount, fo.outstanding_principal, fo.currency,
        fo.interest_rate, fo.interest_type, fo.calculation_method,
        fo.start_date, fo.maturity_date, fo.first_payment_date,
        fo.accrued_interest, fo.total_paid, fo.total_interest_paid,
        fo.status, fo.payment_frequency, fo.payment_day,
        fo.notes, fo.origin_source, fo.origin_reference,
        fo.is_active, fo.created_at,
        c.uuid AS creditor_uuid, c.name AS creditor_name, c.creditor_type,
        comp.name AS company_name
      FROM financial_obligations fo
      JOIN creditors c ON c.id = fo.creditor_id
      JOIN companies comp ON comp.id = fo.company_id
      WHERE fo.uuid = $1
    `, [req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// POST /api/obligations
router.post('/', async (req, res, next) => {
  try {
    const {
      company_id, creditor_uuid, obligation_type, description,
      principal_amount, currency = 'MXN', interest_rate, interest_type = 'fixed',
      calculation_method = 'simple', start_date, maturity_date, first_payment_date,
      payment_frequency = 'monthly', payment_day, notes,
      asset_uuid, linked_project_id,
      origin_source = 'web', origin_reference
    } = req.body;

    if (!company_id || !creditor_uuid || !obligation_type || !principal_amount || !start_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, creditor_uuid, obligation_type, principal_amount, start_date' });

    const creditor = await query('SELECT id FROM creditors WHERE uuid=$1', [creditor_uuid]);
    if (!creditor.rows[0]) return res.status(404).json({ success: false, error: 'creditor_not_found' });

    let assetId = null;
    if (asset_uuid) {
      const a = await query('SELECT id FROM assets WHERE uuid=$1', [asset_uuid]);
      assetId = a.rows[0]?.id || null;
    }

    const oblNumber = await generateObligationNumber();
    const result = await query(`
      INSERT INTO financial_obligations (
        company_id, creditor_id, obligation_number, obligation_type, description,
        principal_amount, outstanding_principal, currency, interest_rate, interest_type,
        calculation_method, start_date, maturity_date, first_payment_date,
        payment_frequency, payment_day, notes, asset_id, linked_project_id,
        origin_source, origin_reference, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING uuid, obligation_number, obligation_type, status
    `, [parseInt(company_id), creditor.rows[0].id, oblNumber, obligation_type,
        description||null, parseFloat(principal_amount), currency,
        interest_rate||null, interest_type, calculation_method,
        start_date, maturity_date||null, first_payment_date||null,
        payment_frequency, payment_day||null, notes||null,
        assetId, linked_project_id||null,
        origin_source, origin_reference||null, req.user.id]);

    writeAudit({ userId: req.user.id, action: 'obligation_created',
      entityType: 'financial_obligations', entityId: result.rows[0].uuid,
      companyId: parseInt(company_id),
      newValues: { obligation_number: oblNumber, obligation_type, principal_amount },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    res.status(201).json({ success: true, data: result.rows[0],
      message: `Obligation ${oblNumber} created.` });
  } catch(e) { next(e); }
});

// PATCH /api/obligations/:uuid/status
router.patch('/:uuid/status', async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const valid = ['active','paid_off','defaulted','restructured','cancelled'];
    if (!valid.includes(status))
      return res.status(400).json({ success: false, error: 'invalid_status' });
    const result = await query(`
      UPDATE financial_obligations SET status=$1, notes=COALESCE($2,notes), updated_at=NOW()
      WHERE uuid=$3 RETURNING uuid, obligation_number, status
    `, [status, notes||null, req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    writeAudit({ userId: req.user.id, action: 'obligation_status_changed',
      entityType: 'financial_obligations', entityId: req.params.uuid,
      newValues: { status }, ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// ─── SCHEDULE ─────────────────────────────────────────────────

// GET /api/obligations/:uuid/schedule
router.get('/:uuid/schedule', async (req, res, next) => {
  try {
    const obl = await query('SELECT id FROM financial_obligations WHERE uuid=$1', [req.params.uuid]);
    if (!obl.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT uuid, installment_number, due_date, principal_amount,
        interest_amount, total_amount, status, paid_date, paid_amount, notes
      FROM obligation_schedules WHERE obligation_id=$1
      ORDER BY installment_number
    `, [obl.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/obligations/:uuid/schedule/generate
router.post('/:uuid/schedule/generate', async (req, res, next) => {
  try {
    const { installments, first_payment_date } = req.body;
    if (!installments || !first_payment_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: installments, first_payment_date' });

    const obl = await query(`
      SELECT id, company_id, principal_amount, interest_rate,
        calculation_method, payment_frequency
      FROM financial_obligations WHERE uuid=$1
    `, [req.params.uuid]);
    if (!obl.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const { id: oblId, company_id, principal_amount, interest_rate,
            calculation_method } = obl.rows[0];
    const n = parseInt(installments);
    const P = parseFloat(principal_amount);
    const r = parseFloat(interest_rate || 0) / 100 / 12;

    // Generate schedule rows
    const rows = [];
    let balance = P;
    const startDate = new Date(first_payment_date);

    for (let i = 1; i <= n; i++) {
      const dueDate = new Date(startDate);
      dueDate.setMonth(dueDate.getMonth() + (i - 1));

      let principalPortion, interestPortion, total;

      if (calculation_method === 'french_amortization' && r > 0) {
        const payment = (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
        interestPortion = balance * r;
        principalPortion = payment - interestPortion;
        total = payment;
        balance -= principalPortion;
      } else {
        principalPortion = P / n;
        interestPortion = balance * r;
        total = principalPortion + interestPortion;
        balance -= principalPortion;
      }

      // Adjust last installment for rounding
      if (i === n && balance > 0) principalPortion += balance;

      rows.push({
        obligation_id: oblId, company_id,
        installment_number: i,
        due_date: dueDate.toISOString().slice(0, 10),
        principal_amount: Math.max(0, parseFloat(principalPortion.toFixed(2))),
        interest_amount: parseFloat(interestPortion.toFixed(2)),
        total_amount: parseFloat(total.toFixed(2))
      });
    }

    // Delete existing schedule and insert new
    await withTransaction(async (client) => {
      await client.query('DELETE FROM obligation_schedules WHERE obligation_id=$1', [oblId]);
      for (const row of rows) {
        await client.query(`
          INSERT INTO obligation_schedules
            (obligation_id, company_id, installment_number, due_date,
             principal_amount, interest_amount, total_amount)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [row.obligation_id, row.company_id, row.installment_number,
            row.due_date, row.principal_amount, row.interest_amount, row.total_amount]);
      }
    });

    res.status(201).json({ success: true,
      data: { installments: n, first_payment_date, rows_created: rows.length },
      message: `${rows.length} installments generated.` });
  } catch(e) { next(e); }
});

// POST /api/obligations/:uuid/schedule/bulk
router.post('/:uuid/schedule/bulk', async (req, res, next) => {
  try {
    const { schedule } = req.body;
    if (!schedule?.length)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: schedule array' });
    const obl = await query('SELECT id, company_id FROM financial_obligations WHERE uuid=$1', [req.params.uuid]);
    if (!obl.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const { id: oblId, company_id } = obl.rows[0];
    await withTransaction(async (client) => {
      await client.query('DELETE FROM obligation_schedules WHERE obligation_id=$1', [oblId]);
      for (const row of schedule) {
        await client.query(`
          INSERT INTO obligation_schedules
            (obligation_id, company_id, installment_number, due_date,
             principal_amount, interest_amount, total_amount)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [oblId, company_id, row.installment_number, row.due_date,
            row.principal_amount||0, row.interest_amount||0, row.total_amount]);
      }
    });
    res.status(201).json({ success: true,
      message: `${schedule.length} installments created.` });
  } catch(e) { next(e); }
});

// PATCH /api/obligations/:uuid/schedule/:inst_uuid/pay
router.patch('/:uuid/schedule/:inst_uuid/pay', async (req, res, next) => {
  try {
    const { paid_date, paid_amount, notes } = req.body;
    const result = await query(`
      UPDATE obligation_schedules
      SET status='paid', paid_date=$1, paid_amount=$2, notes=COALESCE($3,notes), updated_at=NOW()
      WHERE uuid=$4 RETURNING uuid, installment_number, total_amount, status
    `, [paid_date||new Date().toISOString().slice(0,10), paid_amount||null,
        notes||null, req.params.inst_uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0], message: 'Installment marked as paid.' });
  } catch(e) { next(e); }
});

// ─── PAYMENTS ─────────────────────────────────────────────────

// GET /api/obligations/:uuid/payments
router.get('/:uuid/payments', async (req, res, next) => {
  try {
    const obl = await query('SELECT id FROM financial_obligations WHERE uuid=$1', [req.params.uuid]);
    if (!obl.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT uuid, payment_date, amount, principal_portion, interest_portion,
        currency, payment_method, reference, payment_type, notes, created_at
      FROM obligation_payments WHERE obligation_id=$1
      ORDER BY payment_date DESC
    `, [obl.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/obligations/:uuid/payments
router.post('/:uuid/payments', async (req, res, next) => {
  try {
    const { payment_date, amount, principal_portion = 0, interest_portion = 0,
            currency = 'MXN', payment_method = 'transfer', reference,
            payment_type = 'scheduled', schedule_uuid, notes } = req.body;
    if (!payment_date || !amount)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: payment_date, amount' });

    const obl = await query(`
      SELECT id, company_id, outstanding_principal, total_paid, total_interest_paid
      FROM financial_obligations WHERE uuid=$1
    `, [req.params.uuid]);
    if (!obl.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const { id: oblId, company_id, outstanding_principal,
            total_paid, total_interest_paid } = obl.rows[0];

    let scheduleId = null;
    if (schedule_uuid) {
      const s = await query('SELECT id FROM obligation_schedules WHERE uuid=$1', [schedule_uuid]);
      scheduleId = s.rows[0]?.id || null;
    }

    const newOutstanding = Math.max(0,
      parseFloat(outstanding_principal) - parseFloat(principal_portion));
    const newTotalPaid = parseFloat(total_paid) + parseFloat(amount);
    const newTotalInterest = parseFloat(total_interest_paid) + parseFloat(interest_portion);
    const newStatus = newOutstanding <= 0 ? 'paid_off' : undefined;

    await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO obligation_payments
          (obligation_id, schedule_id, company_id, payment_date, amount,
           principal_portion, interest_portion, currency, payment_method,
           reference, payment_type, notes, recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `, [oblId, scheduleId, company_id, payment_date, parseFloat(amount),
          parseFloat(principal_portion), parseFloat(interest_portion),
          currency, payment_method, reference||null, payment_type, notes||null, req.user.id]);

      const statusUpdate = newStatus ? ', status=$4' : '';
      const params = [newOutstanding, newTotalPaid, newTotalInterest];
      if (newStatus) params.push(newStatus);
      params.push(oblId);
      await client.query(`
        UPDATE financial_obligations SET
          outstanding_principal=$1, total_paid=$2, total_interest_paid=$3
          ${statusUpdate}, updated_at=NOW()
        WHERE id=$${params.length}
      `, params);

      if (scheduleId) {
        await client.query(`
          UPDATE obligation_schedules SET status='paid', paid_date=$1,
            paid_amount=$2, updated_at=NOW() WHERE id=$3
        `, [payment_date, parseFloat(amount), scheduleId]);
      }
    });

    writeAudit({ userId: req.user.id, action: 'obligation_payment_recorded',
      entityType: 'financial_obligations', entityId: req.params.uuid,
      companyId: company_id, newValues: { payment_date, amount, outstanding: newOutstanding },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    res.status(201).json({ success: true,
      data: { payment_date, amount, outstanding_principal: newOutstanding,
        status: newStatus || 'active' },
      message: `Payment recorded. Outstanding: ${newOutstanding.toFixed(2)} ${currency}` });
  } catch(e) { next(e); }
});

module.exports = router;
