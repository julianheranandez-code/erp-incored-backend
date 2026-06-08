'use strict';

/**
 * AR Invoices v2 — Sprint 4B Revenue Governance
 * ===============================================
 * Enhancements:
 *   - Full status lifecycle (draft → pending_approval → approved → sent → partially_paid → paid)
 *   - Approval Engine V2 integration (AR_INVOICE type)
 *   - Customer PO balance validation (hard block)
 *   - Treasury INFLOW auto-creation on payment (atomic)
 *   - Collection alerts
 */

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { getApprovalChain, resolveApprovers, getCompanyApprovalPolicy } = require('../lib/approval-engine');
const logger = require('../utils/logger');

router.use(verifyToken);

// ─── HELPERS ──────────────────────────────────────────────────
function getEffectiveRoles(user) {
  return user.roles?.length ? user.roles : user.role ? [user.role] : [];
}

// ─── GET /api/ar-invoices ─────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { company_id, project_id, client_id, status,
            date_from, date_to, overdue_only,
            page = 1, limit = 50 } = req.query;

    const roles = getEffectiveRoles(req.user);
    const companyId = roles.includes('super_admin') && company_id
      ? parseInt(company_id)
      : parseInt(req.user.active_company_id || req.user.company_id);

    const conditions = [`i.company_id = $1`];
    const values = [companyId];
    let idx = 2;

    if (project_id) { conditions.push(`i.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (client_id)  { conditions.push(`i.client_id = $${idx++}`); values.push(parseInt(client_id)); }
    if (status)     { conditions.push(`i.status = $${idx++}`); values.push(status); }
    if (date_from)  { conditions.push(`i.issue_date >= $${idx++}`); values.push(date_from); }
    if (date_to)    { conditions.push(`i.issue_date <= $${idx++}`); values.push(date_to); }
    if (overdue_only === 'true')
      conditions.push(`i.due_date < CURRENT_DATE AND i.status NOT IN ('paid','cancelled')`);

    const where = `WHERE ${conditions.join(' AND ')}`;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [rows, summary] = await Promise.all([
      query(`
        SELECT i.*,
          c.name AS client_name, c.rfc AS client_rfc,
          p.name AS project_name, p.code AS project_code,
          cpo.po_number AS client_po_number, cpo.remaining_amount AS po_remaining
        FROM ar_invoices i
        LEFT JOIN clients c    ON c.id = i.client_id
        LEFT JOIN projects p   ON p.id = i.project_id
        LEFT JOIN client_purchase_orders cpo ON cpo.id = i.client_po_id
        ${where}
        ORDER BY i.due_date ASC, i.issue_date DESC
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, parseInt(limit), offset]),
      query(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled','rejected')),0) AS total_invoiced,
          COALESCE(SUM(total_paid), 0) AS total_collected,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE status NOT IN ('paid','cancelled')),0) AS outstanding,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE AND status NOT IN ('paid','cancelled')),0) AS overdue_ar
        FROM ar_invoices i ${where}
      `, values)
    ]);

    res.json({ success: true, count: rows.rows.length,
      total: parseInt(summary.rows[0].total),
      summary: summary.rows[0], data: rows.rows });
  } catch(error) { next(error); }
});

// ─── GET /api/ar-invoices/:id ─────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [invoice, payments] = await Promise.all([
      query(`
        SELECT i.*,
          c.name AS client_name, c.primary_contact_email,
          p.name AS project_name, p.code AS project_code,
          cpo.po_number AS client_po_number,
          cpo.total_amount AS po_total, cpo.remaining_amount AS po_remaining
        FROM ar_invoices i
        LEFT JOIN clients c    ON c.id = i.client_id
        LEFT JOIN projects p   ON p.id = i.project_id
        LEFT JOIN client_purchase_orders cpo ON cpo.id = i.client_po_id
        WHERE i.id = $1
      `, [parseInt(req.params.id)]),
      query(`SELECT * FROM ar_payments WHERE invoice_id=$1 ORDER BY payment_date DESC`,
            [parseInt(req.params.id)])
    ]);

    if (!invoice.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    res.json({ success: true, data: { invoice: invoice.rows[0], payments: payments.rows }});
  } catch(error) { next(error); }
});

// ─── POST /api/ar-invoices ────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      company_id, client_id, project_id, client_po_id,
      folio, description, notes, subtotal, tax_percent = 0,
      issue_date = new Date().toISOString().slice(0,10),
      due_date, currency = 'MXN', exchange_rate = 1,
      cfdi_uuid, cfdi_xml_url
    } = req.body;

    if (!company_id || !client_id || !project_id || !folio || !subtotal || !issue_date || !due_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, client_id, project_id, folio, subtotal, issue_date, due_date' });

    const tax_amount   = parseFloat(subtotal) * (parseFloat(tax_percent) / 100);
    const total_amount = parseFloat(subtotal) + tax_amount;

    // Phase 2: Customer PO balance validation (hard block)
    if (client_po_id) {
      const poCheck = await query(
        `SELECT id, remaining_amount, po_number FROM client_purchase_orders WHERE id=$1`,
        [parseInt(client_po_id)]
      );
      if (!poCheck.rows[0])
        return res.status(400).json({ success: false, error: 'invalid_client_po' });

      if (parseFloat(poCheck.rows[0].remaining_amount) < total_amount)
        return res.status(400).json({ success: false, error: 'po_balance_exceeded',
          message: `Invoice amount (${total_amount}) exceeds available Customer PO balance (${poCheck.rows[0].remaining_amount}).`,
          po_remaining: parseFloat(poCheck.rows[0].remaining_amount), invoice_total: total_amount });
    }

    const result = await query(`
      INSERT INTO ar_invoices (
        company_id, client_id, project_id, client_po_id,
        folio, description, notes, subtotal, tax_percent, tax_amount,
        total_amount, total_paid, outstanding_balance,
        currency, exchange_rate, status, issue_date, due_date,
        cfdi_uuid, cfdi_xml_url, approval_required, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$11,
                $12,$13,'draft',$14,$15,$16,$17,true,$18)
      RETURNING *
    `, [parseInt(company_id), parseInt(client_id), parseInt(project_id),
        client_po_id ? parseInt(client_po_id) : null,
        folio, description||null, notes||null,
        parseFloat(subtotal), parseFloat(tax_percent), tax_amount, total_amount,
        currency, parseFloat(exchange_rate), issue_date, due_date,
        cfdi_uuid||null, cfdi_xml_url||null, req.user.id]);

    writeAudit({
      userId: req.user.id, action: 'ar_invoice_created',
      entityType: 'ar_invoices', entityId: String(result.rows[0].id),
      companyId: parseInt(company_id),
      newValues: { folio, total_amount, client_po_id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'AR Invoice created.', data: result.rows[0] });
  } catch(error) {
    if (error.code === '23505')
      return res.status(409).json({ success: false, error: 'duplicate_folio' });
    next(error);
  }
});

// ─── POST /api/ar-invoices/:id/submit ────────────────────────
router.post('/:id/submit', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const inv = await query(`SELECT * FROM ar_invoices WHERE id=$1`, [id]);
    if (!inv.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const invoice = inv.rows[0];
    if (!['draft','rejected'].includes(invoice.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Only draft invoices can be submitted. Current: ${invoice.status}` });

    const approvalPolicy = await getCompanyApprovalPolicy(invoice.company_id);
    let chain;
    try {
      chain = getApprovalChain('AR_INVOICE', invoice.total_amount, approvalPolicy);
    } catch(err) {
      return res.status(400).json({ success: false, error: 'approval_chain_error',
        message: err.message });
    }

    const { resolved, missing } = await resolveApprovers(invoice.company_id, chain);
    if (missing.length > 0)
      return res.status(400).json({ success: false, error: 'missing_approver_assignments',
        message: `No approver for roles: ${missing.join(', ')}`, missing_roles: missing });

    let approvalRequestId = null;

    await withTransaction(async (client) => {
      const approvalResult = await client.query(`
        INSERT INTO treasury_approval_requests
          (company_id, approval_type, entity_type, entity_id, amount, currency,
           status, requested_by, current_level, final_level, notes)
        VALUES ($1,'AR_INVOICE','AR_INVOICE',$2,$3,$4,'pending',$5,1,$6,$7)
        RETURNING id
      `, [invoice.company_id, String(id), invoice.total_amount, invoice.currency,
          req.user.id, resolved.length,
          `AR Invoice ${invoice.folio}: ${invoice.description||''}`]);

      approvalRequestId = approvalResult.rows[0].id;

      for (const step of resolved) {
        await client.query(`
          INSERT INTO treasury_approval_steps
            (request_id, level_number, approver_role, approver_user_id, status)
          VALUES ($1,$2,$3,$4,'pending')
        `, [approvalRequestId, step.level, step.role, step.user_id]);
      }

      await client.query(`
        UPDATE ar_invoices SET
          status='pending_approval', approval_request_id=$1, updated_at=NOW()
        WHERE id=$2
      `, [approvalRequestId, id]);
    });

    res.json({ success: true, message: 'AR Invoice submitted for approval.',
      data: { invoice_id: id, approval_request_id: approvalRequestId,
              approval_chain: resolved.map(s => ({ level: s.level, role: s.role, approver: s.user_name })) }
    });
  } catch(error) { next(error); }
});

// ─── POST /api/ar-invoices/:id/payments ──────────────────────
// Phase 14: Atomic — payment + Treasury INFLOW in single transaction
router.post('/:id/payments', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { payment_amount, payment_date, payment_method, reference,
            bank_account_id, notes } = req.body;

    if (!payment_amount || !payment_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: payment_amount, payment_date' });

    // FIX 1: bank_account_id mandatory — every payment must enter a bank account
    if (!bank_account_id)
      return res.status(400).json({ success: false, error: 'bank_account_required',
        message: 'Customer payments require a destination bank account.' });

    const inv = await query(`SELECT * FROM ar_invoices WHERE id=$1`, [id]);
    if (!inv.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const invoice = inv.rows[0];
    const amount  = parseFloat(payment_amount);

    if (!['approved','sent','partially_paid'].includes(invoice.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Invoice must be approved/sent/partially_paid to record payment. Status: ${invoice.status}` });

    if (amount <= 0)
      return res.status(400).json({ success: false, error: 'invalid_amount' });

    if (amount > parseFloat(invoice.outstanding_balance))
      return res.status(400).json({ success: false, error: 'overpayment',
        message: `Payment exceeds outstanding balance (${invoice.outstanding_balance})` });

    const result = await withTransaction(async (client) => {
      const newTotalPaid    = parseFloat(invoice.total_paid) + amount;
      const newOutstanding  = parseFloat(invoice.total_amount) - newTotalPaid;
      const newStatus       = newOutstanding <= 0 ? 'paid' : 'partially_paid';
      const paidDate        = newStatus === 'paid' ? payment_date : null;

      // FIX 1: Treasury INFLOW mandatory — no conditional
      let bankTransactionId = null;
      {
        const txResult = await client.query(`
          INSERT INTO treasury_bank_transactions (
            company_id, bank_account_id, transaction_date, value_date,
            bank_description, amount, direction, category_id,
            project_id, client_id, notes, status, created_by
          ) VALUES ($1,$2,$3,$3,$4,$5,'INFLOW',
            (SELECT id FROM treasury_transaction_categories WHERE name='Customer Invoice Payment' AND is_active=TRUE LIMIT 1),
            $6,$7,$8,'cleared',$9)
          RETURNING id
        `, [invoice.company_id, parseInt(bank_account_id),
            payment_date,
            `AR Payment - Invoice ${invoice.folio}`,
            amount, invoice.project_id, invoice.client_id,
            notes||null, req.user.id]);
        bankTransactionId = txResult.rows[0].id;
      }

      // Record AR payment
      const payment = await client.query(`
        INSERT INTO ar_payments (
          company_id, invoice_id, customer_id, bank_account_id,
          bank_transaction_id, payment_reference, payment_date,
          payment_method, amount, currency, notes, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
      `, [invoice.company_id, id, invoice.client_id,
          bank_account_id ? parseInt(bank_account_id) : null,
          bankTransactionId, reference||null, payment_date,
          payment_method||null, amount, invoice.currency||'MXN',
          notes||null, req.user.id]);

      // Update invoice totals + status
      const updatedInvoice = await client.query(`
        UPDATE ar_invoices SET
          total_paid = $1, outstanding_balance = $2,
          status = $3, paid_date = COALESCE($4, paid_date),
          actual_payment_date = COALESCE($4, actual_payment_date),
          updated_at = NOW()
        WHERE id = $5 RETURNING *
      `, [newTotalPaid, newOutstanding, newStatus, paidDate, id]);

      // Update Client PO remaining_amount
      if (invoice.client_po_id) {
        await client.query(`
          UPDATE client_purchase_orders SET
            invoiced_amount = COALESCE(invoiced_amount, 0),
            remaining_amount = remaining_amount - $1,
            updated_at = NOW()
          WHERE id = $2
        `, [newStatus === 'paid' ? 0 : 0, invoice.client_po_id]);
        // Note: CPO remaining is for invoice amounts not payments
      }

      return { payment: payment.rows[0], invoice: updatedInvoice.rows[0],
               bank_transaction_id: bankTransactionId };
    });

    writeAudit({
      userId: req.user.id, action: 'ar_invoice_payment_recorded',
      entityType: 'ar_invoices', entityId: String(id),
      companyId: invoice.company_id,
      newValues: { amount, invoice_status: result.invoice.status,
                   bank_transaction_id: result.bank_transaction_id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[AR] payment recorded: invoice=${id} amount=${amount} status=${result.invoice.status} treasury_tx=${result.bank_transaction_id}`);
    res.status(201).json({ success: true, message: 'Payment recorded.',
      data: result, treasury_inflow_created: !!result.bank_transaction_id });
  } catch(error) { next(error); }
});

// ─── POST /api/ar-invoices/:id/send ──────────────────────────
// FIX 2: Explicit approved → sent transition
router.post('/:id/send', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const inv = await query(`SELECT * FROM ar_invoices WHERE id=$1`, [id]);
    if (!inv.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const invoice = inv.rows[0];
    if (invoice.status !== 'approved')
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Only approved invoices can be sent. Current: ${invoice.status}` });

    const result = await query(`
      UPDATE ar_invoices SET status='sent', updated_at=NOW() WHERE id=$1 RETURNING *
    `, [id]);

    writeAudit({
      userId: req.user.id, action: 'ar_invoice_sent',
      entityType: 'ar_invoices', entityId: String(id),
      companyId: invoice.company_id,
      newValues: { status: 'sent', folio: invoice.folio },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[AR] Invoice ${id} sent to customer — folio=${invoice.folio}`);
    res.json({ success: true, message: 'AR Invoice marked as sent.', data: result.rows[0] });
  } catch(error) { next(error); }
});

// ─── GET /api/ar-invoices/collection-alerts ───────────────────
// FIX 5: Collection alerts
router.get('/collection-alerts', async (req, res, next) => {
  try {
    const roles = getEffectiveRoles(req.user);
    const companyId = roles.includes('super_admin') && req.query.company_id
      ? parseInt(req.query.company_id)
      : parseInt(req.user.active_company_id || req.user.company_id);

    // Generate alerts for overdue invoices
    const overdue = await query(`
      SELECT i.id, i.folio, i.company_id, i.client_id, i.outstanding_balance,
        i.due_date, i.currency,
        CURRENT_DATE - i.due_date AS days_overdue
      FROM ar_invoices i
      WHERE i.company_id=$1
        AND i.status IN ('approved','sent','partially_paid')
        AND i.due_date < CURRENT_DATE
    `, [companyId]);

    for (const inv of overdue.rows) {
      const days = inv.days_overdue;
      let alertType = null, severity = null;
      if (days >= 90) { alertType = 'AR_OVERDUE_90'; severity = 'critical'; }
      else if (days >= 60) { alertType = 'AR_OVERDUE_60'; severity = 'high'; }
      else if (days >= 30) { alertType = 'AR_OVERDUE_30'; severity = 'warning'; }

      if (alertType) {
        await query(`
          INSERT INTO ar_collection_alerts
            (company_id, client_id, ar_invoice_id, alert_type, severity, message,
             days_overdue, amount_overdue)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8
          WHERE NOT EXISTS (
            SELECT 1 FROM ar_collection_alerts
            WHERE ar_invoice_id=$3 AND alert_type=$4 AND is_acknowledged=FALSE
              AND created_at > NOW() - INTERVAL '24 hours'
          )
        `, [inv.company_id, inv.client_id, inv.id, alertType, severity,
            `Invoice ${inv.folio} is ${days} days overdue — ${inv.outstanding_balance} ${inv.currency}`,
            days, inv.outstanding_balance]).catch(() => {});
      }
    }

    const alerts = await query(`
      SELECT a.*, i.folio, c.name AS client_name
      FROM ar_collection_alerts a
      JOIN ar_invoices i ON i.id = a.ar_invoice_id
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.company_id=$1 AND a.is_acknowledged=FALSE
      ORDER BY a.created_at DESC
    `, [companyId]);

    res.json({ success: true, count: alerts.rows.length, data: alerts.rows });
  } catch(error) { next(error); }
});

// ─── POST /api/ar-invoices/:id/cancel ────────────────────────
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    if (!reason)
      return res.status(400).json({ success: false, error: 'reason_required' });

    const inv = await query(`SELECT * FROM ar_invoices WHERE id=$1`, [id]);
    if (!inv.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const invoice = inv.rows[0];
    if (['paid','cancelled'].includes(invoice.status))
      return res.status(400).json({ success: false, error: 'invalid_status' });

    await query(`
      UPDATE ar_invoices SET status='cancelled',
        notes=CONCAT(COALESCE(notes,''),' | Cancelled: ',$1), updated_at=NOW()
      WHERE id=$2
    `, [reason, id]);

    res.json({ success: true, message: 'AR Invoice cancelled.' });
  } catch(error) { next(error); }
});

module.exports = router;
