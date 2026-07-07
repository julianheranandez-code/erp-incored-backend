'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');
const {
  checkDuplicatePayment,
  validateFinancialOperation,
  syncApTreasuryForecast,
  assertPeriodOpen,
  buildAuditPayload,
  matchBankTransaction
} = require('../services/financialHelpers');

router.use(verifyToken);

function getAuthorizedCompanyId(user, queryCompanyId) {
  if (user.role === 'admin' || user.role === 'super_admin') return queryCompanyId ? parseInt(queryCompanyId) : null;
  return parseInt(user.active_company_id || user.company_id || user.companyId);
}

// ─── PART 1: Vendor/Provider separation ──────────────────────
const VENDOR_JOIN = `LEFT JOIN clients c ON c.id = bs.vendor_id`;
const VENDOR_JOIN_RAW = `LEFT JOIN clients c ON c.id = b.vendor_id`;

// ─── PART 4: Local approval check (not in shared helpers) ────
async function assertApprovalAllowed(billId) {
  const result = await query(
    `SELECT approval_required, approval_status FROM ap_bills WHERE id = $1`,
    [parseInt(billId)]
  );
  const bill = result.rows[0];
  if (!bill) throw { code: 'NOT_FOUND', message: 'Bill not found.' };
  if (bill.approval_required && bill.approval_status !== 'approved') {
    throw { code: 'APPROVAL_REQUIRED', message: 'This bill requires approval before payment can be applied.' };
  }
}

// ─── PART 6: Approval threshold ──────────────────────────────
const AP_APPROVAL_THRESHOLD = parseFloat(process.env.AP_APPROVAL_THRESHOLD || '50000');

// ─── PART 8: Retainage helpers ────────────────────────────────
function calculateRetainageReleaseDate(issueDate, releasedays) {
  if (!issueDate || !releasedays) return null;
  const d = new Date(issueDate);
  d.setDate(d.getDate() + parseInt(releasedays));
  return d.toISOString().split('T')[0];
}

function isRetainageEligible(bill) {
  if (!bill.retainage_amount || bill.retainage_amount <= 0) return false;
  if (bill.retainage_status !== 'pending') return false;
  if (!bill.retainage_due_date) return true;
  return new Date(bill.retainage_due_date) <= new Date();
}

// ─── GET /api/ap/vendors ─────────────────────────────────────
// PART 1: Vendors only (is_vendor=true)
router.get('/vendors', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = ['is_vendor = TRUE'];
    const values = [];
    let idx = 1;
    if (authorizedCompanyId) { conditions.push(`company_id = $${idx++}`); values.push(authorizedCompanyId); }

    const result = await query(`
      SELECT id, name, email, phone, city, state, country, is_active
      FROM clients
      WHERE ${conditions.join(' AND ')}
      ORDER BY name ASC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/ap/status ───────────────────────────────────────
router.get('/status', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const { status, vendor_id, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`bs.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (status)    { conditions.push(`bs.calculated_status = $${idx++}`); values.push(status); }
    if (vendor_id) { conditions.push(`bs.vendor_id = $${idx++}`); values.push(parseInt(vendor_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const whereNoAlias = conditions.length
      ? `WHERE ${conditions.map(c => c.replace('bs.', '')).join(' AND ')}`
      : '';

    const [bills, summary] = await Promise.all([
      query(`
        SELECT bs.*, c.name AS vendor_name
        FROM ap_bill_status bs
        ${VENDOR_JOIN}
        ${where}
        ORDER BY bs.due_date ASC NULLS LAST
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, parseInt(limit), offset]),
      query(`
        SELECT
          COUNT(*)                                                    AS total_bills,
          COALESCE(SUM(total_amount), 0)                             AS total_ap,
          COALESCE(SUM(CASE WHEN calculated_status='overdue' THEN balance_due ELSE 0 END), 0) AS overdue_ap,
          COALESCE(SUM(CASE WHEN calculated_status='paid' AND paid_date >= date_trunc('month', NOW()) THEN total_amount ELSE 0 END), 0) AS paid_this_month,
          COALESCE(SUM(balance_due), 0)                              AS pending_payments,
          COUNT(CASE WHEN payment_gap_status='underpaid' THEN 1 END) AS underpaid_count,
          COUNT(CASE WHEN calculated_status='overdue' THEN 1 END)    AS overdue_count,
          ROUND(AVG(CASE WHEN paid_date IS NOT NULL AND issue_date IS NOT NULL
            THEN paid_date - issue_date END), 1)                     AS avg_days_to_pay
        FROM ap_bill_status ${whereNoAlias}
      `, values)
    ]);

    res.json({
      success: true,
      data: {
        summary: summary.rows[0],
        bills: bills.rows,
        pagination: { total: parseInt(summary.rows[0].total_bills), page: parseInt(page), limit: parseInt(limit) }
      }
    });
  } catch (error) { next(error); }
});

// ─── GET /api/ap/aging ────────────────────────────────────────
// PART 1: 100% parameterized — no interpolation
router.get('/aging', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [`calculated_status != $1`, `calculated_status != $2`];
    const values = ['paid', 'cancelled'];
    let idx = 3;

    if (authorizedCompanyId) { conditions.push(`company_id = $${idx++}`); values.push(authorizedCompanyId); }

    const result = await query(`
      SELECT aging_bucket, COUNT(*) AS bill_count,
        SUM(balance_due) AS total_balance, SUM(total_amount) AS total_amount
      FROM ap_bill_status
      WHERE ${conditions.join(' AND ')}
      GROUP BY aging_bucket
      ORDER BY CASE aging_bucket
        WHEN 'current' THEN 1 WHEN '1_30' THEN 2
        WHEN '31_60' THEN 3 WHEN '61_90' THEN 4 WHEN 'over_90' THEN 5
      END
    `, values);

    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/ap/alerts ───────────────────────────────────────
// PART 1: 100% parameterized
router.get('/alerts', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const params = authorizedCompanyId ? [authorizedCompanyId] : [];
    const cf = authorizedCompanyId ? `AND company_id = $1` : '';

    const result = await query(`
      SELECT 'overdue' AS alert_type, 'critical' AS severity,
        COUNT(*) AS count, COALESCE(SUM(balance_due), 0) AS total_amount
      FROM ap_bill_status WHERE calculated_status = 'overdue' ${cf}
      UNION ALL
      SELECT 'underpaid','warning',COUNT(*),COALESCE(SUM(gap_amount),0)
      FROM ap_bill_status WHERE payment_gap_status = 'underpaid' ${cf}
      UNION ALL
      SELECT 'pending_approval','info',COUNT(*),COALESCE(SUM(total_amount),0)
      FROM ap_bill_status WHERE calculated_status = 'pending_approval' ${cf}
      UNION ALL
      SELECT 'disputed','warning',COUNT(*),COALESCE(SUM(total_amount),0)
      FROM ap_bill_status WHERE calculated_status = 'disputed' ${cf}
      UNION ALL
      SELECT 'retainage_pending','info',COUNT(*),COALESCE(SUM(retainage_amount),0)
      FROM ap_bill_status WHERE payment_gap_status = 'retainage_pending' ${cf}
    `, params);

    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/ap/unpaid ───────────────────────────────────────
router.get('/unpaid', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [`bs.calculated_status != $1`, `bs.calculated_status != $2`,
                        `bs.calculated_status != $3`, `bs.calculated_status != $4`];
    const values = ['paid', 'cancelled', 'revised', 'replaced'];
    let idx = 5;

    if (authorizedCompanyId) { conditions.push(`bs.company_id = $${idx++}`); values.push(authorizedCompanyId); }

    const result = await query(`
      SELECT bs.*, c.name AS vendor_name
      FROM ap_bill_status bs
      ${VENDOR_JOIN}
      WHERE ${conditions.join(' AND ')}
      ORDER BY bs.due_date ASC NULLS LAST
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/ap/compliance-alerts ───────────────────────────
// PART 1: 100% parameterized
router.get('/compliance-alerts', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`b.company_id = $${idx++}`); values.push(authorizedCompanyId); }

    const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT
        c.id AS vendor_id, c.name AS vendor_name,
        COUNT(DISTINCT b.id) AS open_bills,
        COALESCE(SUM(bs.balance_due), 0) AS total_exposure,
        BOOL_OR(da.document_category = 'COI' AND
          (da.expiration_date IS NULL OR da.expiration_date < CURRENT_DATE)) AS coi_issue,
        MAX(CASE WHEN da.document_category = 'W9' THEN 1 ELSE 0 END) = 0 AS w9_missing,
        BOOL_OR(da.document_category = 'NDA' AND
          (da.expiration_date IS NULL OR da.expiration_date < CURRENT_DATE)) AS nda_issue
      FROM ap_bills b
      JOIN ap_bill_status bs ON bs.id = b.id
      JOIN clients c ON c.id = b.vendor_id
      LEFT JOIN document_attachments da ON da.document_id = c.id
        AND da.document_type = $${idx++}
        AND da.is_deleted = FALSE
      WHERE bs.calculated_status NOT IN ('paid','cancelled') ${where}
      GROUP BY c.id, c.name
      ORDER BY total_exposure DESC NULLS LAST
    `, [...values, 'client']);

    logger.info(`[COMPLIANCE] AP compliance check returned ${result.rows.length} vendors`);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── POST /api/ap/payments ────────────────────────────────────
// PART 5: payment safety validation
router.post('/payments', async (req, res, next) => {
  const startTime = Date.now();
  try {
    const {
      company_id, ap_bill_id, bank_account_id, bank_transaction_id,
      payment_reference, payment_date, payment_method = 'wire',
      amount_paid, currency = 'USD', exchange_rate = 1, notes
    } = req.body;

    if (!company_id || !ap_bill_id || !payment_date || !amount_paid) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, ap_bill_id, payment_date, amount_paid' });
    }

    const paid = parseFloat(amount_paid);

    // PART 5: Safety rules
    if (paid <= 0) {
      return res.status(400).json({ success: false, error: 'invalid_amount', message: 'Payment amount must be positive.' });
    }

    const paymentDateObj = new Date(payment_date);
    const today = new Date();
    const daysDiff = (paymentDateObj - today) / (1000 * 60 * 60 * 24);
    if (daysDiff > 30) {
      return res.status(400).json({ success: false, error: 'future_dated', message: 'Payment date cannot be more than 30 days in the future.' });
    }

    // Check bill status
    const billCheck = await query(`SELECT status, total_amount FROM ap_bills WHERE id = $1`, [parseInt(ap_bill_id)]);
    if (!billCheck.rows[0]) return res.status(404).json({ success: false, error: 'bill_not_found' });

    if (['cancelled', 'revised', 'replaced'].includes(billCheck.rows[0].status)) {
      return res.status(400).json({ success: false, error: 'invalid_bill_status',
        message: `Cannot apply payment to ${billCheck.rows[0].status} bill.` });
    }

    // Check duplicate reference
    if (payment_reference) {
      const dupCheck = await query(
        `SELECT id FROM ap_bill_payments WHERE ap_bill_id = $1 AND payment_reference = $2`,
        [parseInt(ap_bill_id), payment_reference]
      );
      if (dupCheck.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'duplicate_reference',
          message: `Payment reference '${payment_reference}' already applied to this bill.` });
      }
    }

    // PART 4: Enforce approval before payment
    try {
      await assertApprovalAllowed(parseInt(ap_bill_id));
    } catch (approvalErr) {
      if (approvalErr.code === 'APPROVAL_REQUIRED') {
        return res.status(403).json({ success: false, error: 'approval_required', message: approvalErr.message });
      }
      throw approvalErr;
    }

    // PART 3: Idempotency — check duplicate payment
    if (payment_reference) {
      const dup = await checkDuplicatePayment('ap_bill_payments', 'ap_bill_id', ap_bill_id, payment_reference, amount_paid, payment_date);
      if (dup) {
        return res.status(409).json({
          success: false, error: 'duplicate_payment',
          message: 'Possible duplicate payment detected. Same reference, amount, and date already exist for this bill.'
        });
      }
    }

    const result = await withTransaction(async (client) => {
      const payment = await client.query(`
        INSERT INTO ap_bill_payments (
          company_id, ap_bill_id, bank_account_id, bank_transaction_id,
          payment_reference, payment_date, payment_method,
          amount_paid, currency, exchange_rate, notes, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
      `, [parseInt(company_id), parseInt(ap_bill_id),
          bank_account_id ? parseInt(bank_account_id) : null,
          bank_transaction_id ? parseInt(bank_transaction_id) : null,
          payment_reference||null, payment_date, payment_method,
          paid, currency, parseFloat(exchange_rate), notes||null, req.user.id]);

      const totals = await client.query(
        `SELECT COALESCE(SUM(amount_paid),0) AS total_paid FROM ap_bill_payments WHERE ap_bill_id = $1`,
        [parseInt(ap_bill_id)]
      );
      const totalPaid = parseFloat(totals.rows[0].total_paid);
      const billTotal = parseFloat(billCheck.rows[0].total_amount);

      await client.query(`
        UPDATE ap_bills SET
          total_paid = $1,
          outstanding_balance = GREATEST(0, $2 - $1),
          status = CASE WHEN $1 >= $2 THEN 'paid' WHEN $1 > 0 THEN 'partially_paid' ELSE status END,
          paid_date = CASE WHEN $1 >= $2 THEN $3::date ELSE paid_date END,
          updated_at = NOW()
        WHERE id = $4
      `, [totalPaid, billTotal, payment_date, parseInt(ap_bill_id)]);

      if (bank_account_id) {
        await client.query(
          `UPDATE bank_accounts SET current_balance = current_balance - $1, updated_at = NOW() WHERE id = $2`,
          [paid, parseInt(bank_account_id)]
        );
      }

      if (bank_transaction_id) {
        await client.query(
          `UPDATE bank_transactions SET match_status='matched', applied_invoice_id=$1 WHERE id=$2`,
          [parseInt(ap_bill_id), parseInt(bank_transaction_id)]
        );
      }

      return payment.rows[0];
    });

    // PART 3: Treasury forecast sync (fire-and-forget)
    setImmediate(() => syncApTreasuryForecast(parseInt(ap_bill_id), 'payment_applied'));

    logger.info(`[AP] payment applied bill=${ap_bill_id} amount=${paid} in ${Date.now()-startTime}ms`);

    writeAudit({
      userId: req.user.id, action: 'ap_payment_applied',
      entityType: 'ap_bill_payments', entityId: result.id,
      companyId: parseInt(company_id),
      newValues: { ap_bill_id, amount_paid: paid },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'AP payment applied.', data: result });
  } catch (error) { next(error); }
});

// ─── GET /api/ap/payments ─────────────────────────────────────
router.get('/payments', async (req, res, next) => {
  try {
    const { ap_bill_id } = req.query;
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`p.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (ap_bill_id) { conditions.push(`p.ap_bill_id = $${idx++}`); values.push(parseInt(ap_bill_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT p.*, b.folio AS bill_folio, b.total_amount AS bill_amount,
        ba.bank_name, ba.account_name,
        CONCAT(u.first_name,' ',u.last_name) AS created_by_name
      FROM ap_bill_payments p
      LEFT JOIN ap_bills b        ON b.id = p.ap_bill_id
      LEFT JOIN bank_accounts ba  ON ba.id = p.bank_account_id
      LEFT JOIN users u           ON u.id = p.created_by
      ${where}
      ORDER BY p.payment_date DESC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── PATCH /api/ap/bills/:id ──────────────────────────────────
router.patch('/bills/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { status, approved_by, approved_at, scheduled_payment_date,
            revision_reason, revision_notes, notes } = req.body;

    const current = await query(`SELECT status FROM ap_bills WHERE id = $1`, [id]);
    if (!current.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    if (['paid','cancelled'].includes(current.rows[0].status) && !['cancelled','revised'].includes(status)) {
      return res.status(400).json({ success: false, error: 'immutable_bill',
        message: 'Cannot edit paid or cancelled bills. Create a revision instead.' });
    }

    const result = await query(`
      UPDATE ap_bills SET
        status                 = COALESCE($1, status),
        approved_by            = COALESCE($2::uuid, approved_by),
        approved_at            = COALESCE($3::timestamp, approved_at),
        scheduled_payment_date = COALESCE($4::date, scheduled_payment_date),
        revision_reason        = COALESCE($5, revision_reason),
        revision_notes         = COALESCE($6, revision_notes),
        notes                  = COALESCE($7, notes),
        updated_at             = NOW()
      WHERE id = $8 RETURNING *
    `, [status||null, approved_by||null, approved_at||null,
        scheduled_payment_date||null, revision_reason||null,
        revision_notes||null, notes||null, id]);

    // PART 3: Treasury sync
    setImmediate(() => syncApTreasuryForecast(id, `status_change_to_${status}`));

    writeAudit({
      userId: req.user.id, action: 'ap_bill_updated',
      entityType: 'ap_bills', entityId: id,
      companyId: result.rows[0]?.company_id,
      newValues: { status, scheduled_payment_date },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[AP] bill id=${id} updated status=${status}`);

    res.json({ success: true, message: 'AP bill updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /api/ap/match-transaction ──────────────────────────
// PART 2: Generic document matching
router.post('/match-transaction', async (req, res, next) => {
  try {
    const { bank_transaction_id, document_id, document_type } = req.body;
    if (!bank_transaction_id || !document_id || !document_type) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: bank_transaction_id, document_id, document_type' });
    }

    await matchBankTransaction(bank_transaction_id, document_id, document_type);

    writeAudit({
      userId: req.user.id, action: 'bank_transaction_matched',
      entityType: 'bank_transactions', entityId: parseInt(bank_transaction_id),
      companyId: req.user.company_id,
      newValues: { document_id, document_type },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Transaction matched.' });
  } catch (error) {
    if (error.message?.includes('Invalid document_type')) {
      return res.status(400).json({ success: false, error: 'invalid_document_type', message: error.message });
    }
    next(error);
  }
});

module.exports = router;
