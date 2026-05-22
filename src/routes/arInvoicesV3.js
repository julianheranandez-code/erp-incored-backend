'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { setImmediate } = require('timers');
const logger = require('../utils/logger');
const {
  checkDuplicatePayment,
  validateFinancialOperation,
  syncArTreasuryForecast,
  assertPeriodOpen,
  buildAuditPayload
} = require('../services/financialHelpers');

router.use(verifyToken);

function getAuthorizedCompanyId(user, queryCompanyId) {
  if (user.role === 'admin') return queryCompanyId ? parseInt(queryCompanyId) : null;
  return parseInt(user.active_company_id || user.company_id || user.companyId);
}

// ─── BANK ACCOUNTS ───────────────────────────────────────────

router.get('/bank-accounts', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const where = authorizedCompanyId ? 'WHERE company_id = $1' : '';
    const params = authorizedCompanyId ? [authorizedCompanyId] : [];
    const result = await query(`SELECT * FROM bank_accounts ${where} ORDER BY bank_name ASC`, params);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

router.post('/bank-accounts', async (req, res, next) => {
  try {
    const { company_id, bank_name, account_name, account_number, routing_number,
            currency = 'USD', account_type = 'checking', current_balance = 0, notes } = req.body;
    if (!company_id || !bank_name || !account_name) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, bank_name, account_name' });
    }
    const result = await query(`
      INSERT INTO bank_accounts (company_id, bank_name, account_name, account_number,
        routing_number, currency, account_type, current_balance, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [parseInt(company_id), bank_name, account_name, account_number||null,
        routing_number||null, currency, account_type, parseFloat(current_balance), notes||null]);
    res.status(201).json({ success: true, message: 'Bank account created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

router.put('/bank-accounts/:id', async (req, res, next) => {
  try {
    const { bank_name, account_name, account_number, routing_number,
            currency, account_type, current_balance, is_active, notes } = req.body;
    const result = await query(`
      UPDATE bank_accounts SET
        bank_name      = COALESCE($1, bank_name),
        account_name   = COALESCE($2, account_name),
        account_number = COALESCE($3, account_number),
        routing_number = COALESCE($4, routing_number),
        currency       = COALESCE($5, currency),
        account_type   = COALESCE($6, account_type),
        current_balance = COALESCE($7::numeric, current_balance),
        is_active      = COALESCE($8::boolean, is_active),
        notes          = COALESCE($9, notes),
        updated_at     = NOW()
      WHERE id = $10 RETURNING *
    `, [bank_name||null, account_name||null, account_number||null, routing_number||null,
        currency||null, account_type||null,
        current_balance !== undefined ? parseFloat(current_balance) : null,
        is_active !== undefined ? is_active : null,
        notes||null, parseInt(req.params.id)]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── BANK TRANSACTIONS ───────────────────────────────────────

router.get('/bank-transactions', async (req, res, next) => {
  try {
    const { bank_account_id, match_status, page = 1, limit = 50 } = req.query;
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`bt.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (bank_account_id)     { conditions.push(`bt.bank_account_id = $${idx++}`); values.push(parseInt(bank_account_id)); }
    if (match_status)        { conditions.push(`bt.match_status = $${idx++}`); values.push(match_status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT bt.*,
        ba.bank_name, ba.account_name, ba.currency,
        ai.invoice_number, ai.total_amount AS invoice_amount
      FROM bank_transactions bt
      LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      LEFT JOIN ar_invoices ai   ON ai.id = bt.applied_invoice_id
      ${where}
      ORDER BY bt.transaction_date DESC, bt.id DESC
      LIMIT $${idx} OFFSET $${idx+1}
    `, [...values, parseInt(limit), offset]);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

router.post('/bank-transactions', async (req, res, next) => {
  try {
    const { company_id, bank_account_id, transaction_date, amount,
            transaction_type = 'deposit', reference, customer_name,
            description, notes } = req.body;

    if (!company_id || !bank_account_id || !transaction_date || !amount) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, bank_account_id, transaction_date, amount' });
    }

    const result = await query(`
      INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date,
        amount, transaction_type, reference, customer_name, description, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [parseInt(company_id), parseInt(bank_account_id), transaction_date,
        parseFloat(amount), transaction_type, reference||null,
        customer_name||null, description||null, notes||null, req.user.id]);

    res.status(201).json({ success: true, message: 'Bank transaction created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── AR INVOICE STATUS ───────────────────────────────────────

router.get('/ar-status', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const { status, customer_id, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (status)     { conditions.push(`calculated_status = $${idx++}`); values.push(status); }
    if (customer_id){ conditions.push(`client_id = $${idx++}`); values.push(parseInt(customer_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [invoices, summary] = await Promise.all([
      query(`
        SELECT * FROM ar_invoice_status ${where}
        ORDER BY due_date ASC NULLS LAST
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, parseInt(limit), offset]),
      query(`
        SELECT
          COUNT(*)                                               AS total_invoices,
          COALESCE(SUM(total_amount), 0)                        AS total_ar,
          COALESCE(SUM(CASE WHEN calculated_status='overdue' THEN balance_due ELSE 0 END), 0) AS overdue_ar,
          COALESCE(SUM(CASE WHEN calculated_status='paid' AND paid_date >= date_trunc('month', NOW()) THEN total_amount ELSE 0 END), 0) AS collected_this_month,
          COALESCE(SUM(balance_due), 0)                         AS pending_payments,
          COUNT(CASE WHEN payment_gap_status='underpaid' THEN 1 END) AS underpaid_count,
          COUNT(CASE WHEN calculated_status='overdue' THEN 1 END)    AS overdue_count,
          ROUND(AVG(CASE WHEN paid_date IS NOT NULL AND issue_date IS NOT NULL
            THEN paid_date - issue_date END), 1)                AS avg_days_to_pay
        FROM ar_invoice_status ${where}
      `, values)
    ]);

    res.json({
      success: true,
      data: {
        summary: summary.rows[0],
        invoices: invoices.rows,
        pagination: {
          total: parseInt(summary.rows[0].total_invoices),
          page: parseInt(page), limit: parseInt(limit)
        }
      }
    });
  } catch (error) { next(error); }
});

// ─── AR PAYMENTS ─────────────────────────────────────────────

router.get('/payments', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const { invoice_id, customer_id } = req.query;

    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`p.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (invoice_id)  { conditions.push(`p.invoice_id = $${idx++}`); values.push(parseInt(invoice_id)); }
    if (customer_id) { conditions.push(`p.customer_id = $${idx++}`); values.push(parseInt(customer_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT p.*,
        c.name AS customer_name,
        i.invoice_number, i.total_amount AS invoice_amount,
        ba.bank_name, ba.account_name,
        CONCAT(u.first_name,' ',u.last_name) AS created_by_name
      FROM ar_payments p
      LEFT JOIN clients c      ON c.id = p.customer_id
      LEFT JOIN ar_invoices i  ON i.id = p.invoice_id
      LEFT JOIN bank_accounts ba ON ba.id = p.bank_account_id
      LEFT JOIN users u        ON u.id = p.created_by
      ${where}
      ORDER BY p.payment_date DESC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

router.post('/payments', async (req, res, next) => {
  const startTime = Date.now();
  try {
    const {
      company_id, customer_id, invoice_id, bank_account_id, bank_transaction_id,
      payment_reference, payment_date, payment_method = 'wire',
      amount_received, applied_amount, currency = 'USD', exchange_rate = 1, notes
    } = req.body;

    if (!company_id || !invoice_id || !payment_date || !amount_received) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, invoice_id, payment_date, amount_received' });
    }

    const received = parseFloat(amount_received);
    const applied  = parseFloat(applied_amount || amount_received);

    // PART 3: Idempotency — check duplicate payment
    if (payment_reference) {
      const dup = await query(
        `SELECT id FROM ar_payments WHERE invoice_id=$1 AND payment_reference=$2 AND ABS(amount-$3)<0.01 AND payment_date=$4`,
        [parseInt(invoice_id), payment_reference, received, payment_date]
      );
      if (dup.rows[0]) {
        return res.status(409).json({
          success: false, error: 'duplicate_payment',
          message: 'Possible duplicate payment detected. Same reference, amount, and date already exist for this invoice.'
        });
      }
    }

    const result = await withTransaction(async (client) => {
      // 1. Create payment
      const payment = await client.query(`
        INSERT INTO ar_payments (
          company_id, customer_id, invoice_id, bank_account_id, bank_transaction_id,
          payment_reference, payment_date, payment_method,
          amount_received, applied_amount, currency, exchange_rate, notes, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *
      `, [parseInt(company_id), customer_id ? parseInt(customer_id) : null,
          parseInt(invoice_id), bank_account_id ? parseInt(bank_account_id) : null,
          bank_transaction_id ? parseInt(bank_transaction_id) : null,
          payment_reference||null, payment_date, payment_method,
          received, applied, currency, parseFloat(exchange_rate), notes||null, req.user.id]);

      // 2. Update invoice paid amount + actual_payment_date
      const totals = await client.query(
        `SELECT COALESCE(SUM(applied_amount),0) AS total_paid FROM ar_payments WHERE invoice_id = $1`,
        [parseInt(invoice_id)]
      );
      const totalPaid = parseFloat(totals.rows[0].total_paid);

      const inv = await client.query(`SELECT total_amount FROM ar_invoices WHERE id = $1`, [parseInt(invoice_id)]);
      const invoiceTotal = parseFloat(inv.rows[0]?.total_amount || 0);

      await client.query(`
        UPDATE ar_invoices SET
          status = CASE
            WHEN $1 >= $2 THEN 'paid'
            WHEN $1 > 0 THEN 'partially_paid'
            ELSE status
          END,
          actual_payment_date = CASE WHEN $1 >= $2 THEN $3::date ELSE actual_payment_date END,
          updated_at = NOW()
        WHERE id = $4
      `, [totalPaid, invoiceTotal, payment_date, parseInt(invoice_id)]);

      // 3. Mark bank transaction as matched
      if (bank_transaction_id) {
        await client.query(`
          UPDATE bank_transactions SET match_status='matched', applied_invoice_id=$1 WHERE id=$2
        `, [parseInt(invoice_id), parseInt(bank_transaction_id)]);
      }

      return payment.rows[0];
    });

    logger.info(`[AR] payment applied invoice=${invoice_id} amount=${applied} in ${Date.now()-startTime}ms`);

    writeAudit({
      userId: req.user.id, action: 'ar_payment_applied',
      entityType: 'ar_payments', entityId: result.id,
      companyId: parseInt(company_id),
      newValues: { invoice_id, amount_received: received, applied_amount: applied },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Payment applied.', data: result });
  } catch (error) { next(error); }
});

// ─── PAYMENT MATCHING ────────────────────────────────────────

router.get('/unmatched-transactions', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const where = authorizedCompanyId
      ? `WHERE bt.company_id = $1 AND bt.match_status = 'unmatched' AND bt.transaction_type = 'deposit'`
      : `WHERE bt.match_status = 'unmatched' AND bt.transaction_type = 'deposit'`;
    const params = authorizedCompanyId ? [authorizedCompanyId] : [];

    const result = await query(`
      SELECT bt.*, ba.bank_name, ba.currency
      FROM bank_transactions bt
      LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      ${where}
      ORDER BY bt.transaction_date DESC
    `, params);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── AR ALERTS ───────────────────────────────────────────────
// PART 1: 100% parameterized — no SQL interpolation

router.get('/ar-alerts', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const params = authorizedCompanyId ? [authorizedCompanyId] : [];
    const cf = authorizedCompanyId ? `AND company_id = $1` : '';

    const result = await query(`
      SELECT
        'overdue'        AS alert_type, 'critical' AS severity,
        COUNT(*)         AS count,
        COALESCE(SUM(balance_due), 0) AS total_amount
      FROM ar_invoice_status WHERE calculated_status = 'overdue' ${cf}
      UNION ALL
      SELECT 'underpaid','warning',COUNT(*),COALESCE(SUM(gap_amount),0)
      FROM ar_invoice_status WHERE payment_gap_status = 'underpaid' ${cf}
      UNION ALL
      SELECT 'overpaid','info',COUNT(*),COALESCE(SUM(ABS(gap_amount)),0)
      FROM ar_invoice_status WHERE payment_gap_status = 'overpaid' ${cf}
      UNION ALL
      SELECT 'disputed','warning',COUNT(*),COALESCE(SUM(total_amount),0)
      FROM ar_invoice_status WHERE calculated_status = 'disputed' ${cf}
      UNION ALL
      SELECT 'unmatched_payments','info',COUNT(*),COALESCE(SUM(amount),0)
      FROM bank_transactions WHERE match_status = 'unmatched' ${cf}
    `, params);

    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

// ─── AR MATCH TRANSACTION ─────────────────────────────────────
// PART 2: Generic document matching for AR (same as AP)
router.post('/match-transaction', async (req, res, next) => {
  try {
    const { bank_transaction_id, document_id, document_type } = req.body;
    if (!bank_transaction_id || !document_id || !document_type) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: bank_transaction_id, document_id, document_type' });
    }

    const VALID_TYPES = ['ar_invoice','ap_bill','payroll','journal_entry','treasury_transfer','tax_payment'];
    if (!VALID_TYPES.includes(document_type)) {
      return res.status(400).json({ success: false, error: 'invalid_document_type',
        message: `Valid types: ${VALID_TYPES.join(', ')}` });
    }

    await query(`
      UPDATE bank_transactions SET
        match_status          = 'matched',
        applied_document_id   = $1,
        applied_document_type = $2,
        applied_invoice_id    = CASE WHEN $2 IN ('ar_invoice','ap_bill') THEN $1 ELSE applied_invoice_id END
      WHERE id = $3
    `, [parseInt(document_id), document_type, parseInt(bank_transaction_id)]);

    writeAudit({
      userId: req.user.id, action: 'bank_transaction_matched',
      entityType: 'bank_transactions', entityId: parseInt(bank_transaction_id),
      companyId: req.user.company_id,
      newValues: { document_id, document_type },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[TREASURY] txn=${bank_transaction_id} matched to ${document_type}=${document_id}`);
    res.json({ success: true, message: 'Transaction matched.' });
  } catch (error) { next(error); }
});

module.exports = router;
