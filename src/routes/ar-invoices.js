'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

// ─── HELPERS ─────────────────────────────────────────────────
function buildFilters(params) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (params.company_id) { conditions.push(`i.company_id = $${idx++}`); values.push(parseInt(params.company_id)); }
  if (params.client_id)  { conditions.push(`i.client_id = $${idx++}`);  values.push(parseInt(params.client_id)); }
  if (params.project_id) { conditions.push(`i.project_id = $${idx++}`); values.push(parseInt(params.project_id)); }
  if (params.status)     { conditions.push(`i.status = $${idx++}`);     values.push(params.status); }
  if (params.date_from)  { conditions.push(`i.issue_date >= $${idx++}`); values.push(params.date_from); }
  if (params.date_to)    { conditions.push(`i.issue_date <= $${idx++}`); values.push(params.date_to); }
  if (params.overdue_only === 'true') {
    conditions.push(`i.due_date < CURRENT_DATE`);
    conditions.push(`i.outstanding_balance > 0`);
    conditions.push(`i.status NOT IN ('paid','cancelled')`);
  }

  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values, nextIdx: idx };
}

// ─── GET /api/ar-invoices ─────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, sort = 'issue_date', order = 'DESC' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { where, values, nextIdx } = buildFilters(req.query);
    const validSorts = ['issue_date','due_date','total_amount','status','folio'];
    const sortField = validSorts.includes(sort) ? sort : 'issue_date';
    const sortOrder = order === 'ASC' ? 'ASC' : 'DESC';

    const [invoices, summary, aging, total] = await Promise.all([
      query(`
        SELECT i.*,
          c.name AS client_name,
          p.name AS project_name, p.code AS project_code,
          co.name AS company_name,
          cpo.po_number AS client_po_number
        FROM ar_invoices i
        LEFT JOIN clients c    ON c.id = i.client_id
        LEFT JOIN projects p   ON p.id = i.project_id
        LEFT JOIN companies co ON co.id = i.company_id
        LEFT JOIN client_purchase_orders cpo ON cpo.id = i.client_po_id
        ${where}
        ORDER BY i.${sortField} ${sortOrder}
        LIMIT $${nextIdx} OFFSET $${nextIdx + 1}
      `, [...values, parseInt(limit), offset]),

      query(`
        SELECT
          COALESCE(SUM(total_amount), 0) AS total_ar,
          COALESCE(SUM(outstanding_balance), 0) AS outstanding_ar,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE AND status NOT IN ('paid','cancelled')), 0) AS overdue_ar,
          COALESCE(SUM(total_paid) FILTER (WHERE DATE_TRUNC('month', issue_date) = DATE_TRUNC('month', CURRENT_DATE)), 0) AS collected_this_month
        FROM ar_invoices i ${where}
      `, values),

      query(`
        SELECT
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date >= CURRENT_DATE), 0) AS current_bucket,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - INTERVAL '30 days'), 0) AS days_1_30,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE - INTERVAL '30 days' AND due_date >= CURRENT_DATE - INTERVAL '60 days'), 0) AS days_31_60,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE - INTERVAL '60 days' AND due_date >= CURRENT_DATE - INTERVAL '90 days'), 0) AS days_61_90,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE - INTERVAL '90 days'), 0) AS days_90_plus
        FROM ar_invoices i
        WHERE outstanding_balance > 0 AND status NOT IN ('paid','cancelled')
        ${values.length ? 'AND ' + buildFilters(req.query).where.replace('WHERE ','') : ''}
      `, values),

      query(`SELECT COUNT(*) AS total FROM ar_invoices i ${where}`, values)
    ]);

    res.json({
      success: true,
      data: {
        invoices: invoices.rows,
        summary: summary.rows[0],
        aging: {
          current:      parseFloat(aging.rows[0]?.current_bucket || 0),
          days_1_30:    parseFloat(aging.rows[0]?.days_1_30 || 0),
          days_31_60:   parseFloat(aging.rows[0]?.days_31_60 || 0),
          days_61_90:   parseFloat(aging.rows[0]?.days_61_90 || 0),
          days_90_plus: parseFloat(aging.rows[0]?.days_90_plus || 0)
        },
        pagination: {
          total: parseInt(total.rows[0].total),
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(parseInt(total.rows[0].total) / parseInt(limit))
        }
      }
    });
  } catch (error) { next(error); }
});

// ─── GET /api/ar-invoices/:id ─────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const [invoice, payments] = await Promise.all([
      query(`
        SELECT i.*,
          c.name AS client_name, c.primary_contact_name, c.primary_contact_email, c.rfc AS client_rfc,
          p.name AS project_name, p.code AS project_code, p.status AS project_status,
          co.name AS company_name, co.short_code AS company_code,
          cpo.po_number AS client_po_number, cpo.total_amount AS po_total, cpo.remaining_amount AS po_remaining
        FROM ar_invoices i
        LEFT JOIN clients c    ON c.id = i.client_id
        LEFT JOIN projects p   ON p.id = i.project_id
        LEFT JOIN companies co ON co.id = i.company_id
        LEFT JOIN client_purchase_orders cpo ON cpo.id = i.client_po_id
        WHERE i.id = $1
      `, [id]),
      query(`SELECT * FROM ar_payments WHERE invoice_id = $1 ORDER BY payment_date DESC`, [id])
    ]);

    if (!invoice.rows[0]) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Invoice not found.' });
    }

    res.json({ success: true, data: { invoice: invoice.rows[0], payments: payments.rows } });
  } catch (error) { next(error); }
});

// ─── POST /api/ar-invoices ────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      company_id, client_id, project_id, client_po_id,
      folio, description, notes,
      subtotal, tax_percent = 16,
      currency = 'MXN', exchange_rate = 1,
      issue_date, due_date, cfdi_uuid, cfdi_xml_url
    } = req.body;

    if (!company_id || !client_id || !project_id || !folio || !subtotal || !issue_date || !due_date) {
      return res.status(400).json({
        success: false, error: 'validation_error',
        message: 'Required: company_id, client_id, project_id, folio, subtotal, issue_date, due_date'
      });
    }

    const tax_amount   = parseFloat(subtotal) * (parseFloat(tax_percent) / 100);
    const total_amount = parseFloat(subtotal) + tax_amount;
    const created_by   = req.user.id;

    const result = await query(`
      INSERT INTO ar_invoices (
        company_id, client_id, project_id, client_po_id,
        folio, description, notes,
        subtotal, tax_percent, tax_amount, total_amount,
        currency, exchange_rate, status, issue_date, due_date,
        cfdi_uuid, cfdi_xml_url, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'issued',$14,$15,$16,$17,$18)
      RETURNING *
    `, [
      parseInt(company_id), parseInt(client_id), parseInt(project_id),
      client_po_id ? parseInt(client_po_id) : null,
      folio, description || null, notes || null,
      parseFloat(subtotal), parseFloat(tax_percent), tax_amount, total_amount,
      currency, parseFloat(exchange_rate),
      issue_date, due_date, cfdi_uuid || null, cfdi_xml_url || null, created_by
    ]);

    res.status(201).json({ success: true, message: 'Invoice created.', data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'duplicate_folio', message: 'Folio already exists.' });
    }
    next(error);
  }
});

// ─── PUT /api/ar-invoices/:id ─────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await query('SELECT * FROM ar_invoices WHERE id = $1', [id]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Invoice not found.' });
    if (existing.rows[0].status === 'paid') {
      return res.status(400).json({ success: false, error: 'invoice_paid', message: 'Cannot edit a fully paid invoice.' });
    }

    const { status, notes, due_date, subtotal, tax_percent, cfdi_uuid, cfdi_xml_url } = req.body;
    const inv = existing.rows[0];
    const newSubtotal    = subtotal    ? parseFloat(subtotal)    : parseFloat(inv.subtotal);
    const newTaxPercent  = tax_percent ? parseFloat(tax_percent) : parseFloat(inv.tax_percent);
    const newTaxAmount   = newSubtotal * (newTaxPercent / 100);
    const newTotalAmount = newSubtotal + newTaxAmount;

    const result = await query(`
      UPDATE ar_invoices SET
        status = COALESCE($1, status), notes = COALESCE($2, notes),
        due_date = COALESCE($3, due_date),
        subtotal = $4, tax_percent = $5, tax_amount = $6, total_amount = $7,
        cfdi_uuid = COALESCE($8, cfdi_uuid), cfdi_xml_url = COALESCE($9, cfdi_xml_url),
        updated_at = NOW()
      WHERE id = $10 RETURNING *
    `, [status || null, notes || null, due_date || null, newSubtotal, newTaxPercent, newTaxAmount, newTotalAmount, cfdi_uuid || null, cfdi_xml_url || null, id]);

    res.json({ success: true, message: 'Invoice updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /api/ar-invoices/:id/payments (WITH TRANSACTION) ───
router.post('/:id/payments', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { payment_amount, payment_date, payment_method, reference, notes } = req.body;

    if (!payment_amount || !payment_date) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: payment_amount, payment_date' });
    }

    const invoice = await query('SELECT * FROM ar_invoices WHERE id = $1', [id]);
    if (!invoice.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Invoice not found.' });

    const inv      = invoice.rows[0];
    const amount   = parseFloat(payment_amount);
    const outstanding = parseFloat(inv.outstanding_balance);

    if (inv.status === 'cancelled') return res.status(400).json({ success: false, error: 'invoice_cancelled', message: 'Cannot pay a cancelled invoice.' });
    if (amount <= 0) return res.status(400).json({ success: false, error: 'invalid_amount', message: 'Amount must be > 0.' });
    if (amount > outstanding) return res.status(400).json({ success: false, error: 'AR_OVERPAYMENT', message: `Exceeds outstanding: ${outstanding}` });

    // ── ATOMIC TRANSACTION ────────────────────────────────────
    const result = await withTransaction(async (client) => {

      // 1. Insert payment
      const payment = await client.query(`
        INSERT INTO ar_payments (
          invoice_id, company_id, project_id,
          amount, currency, exchange_rate,
          payment_date, payment_method, reference, notes, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
      `, [id, inv.company_id, inv.project_id, amount, inv.currency, parseFloat(inv.exchange_rate), payment_date, payment_method || null, reference || null, notes || null, req.user.id]);

      // 2. Calculate new status
      const newTotalPaid = parseFloat(inv.total_paid) + amount;
      const newStatus    = newTotalPaid >= parseFloat(inv.total_amount) ? 'paid' : 'partially_paid';
      const paidDate     = newStatus === 'paid' ? payment_date : null;

      // 3. Update invoice
      const updatedInvoice = await client.query(`
        UPDATE ar_invoices SET
          total_paid = $1, status = $2,
          paid_date  = COALESCE($3, paid_date),
          updated_at = NOW()
        WHERE id = $4 RETURNING *
      `, [newTotalPaid, newStatus, paidDate, id]);

      // 4. Update PO if linked
      if (inv.client_po_id) {
        await client.query(`
          UPDATE client_purchase_orders SET
            invoiced_amount = (SELECT COALESCE(SUM(total_amount),0) FROM ar_invoices WHERE client_po_id = $1 AND status != 'cancelled'),
            status = CASE
              WHEN (SELECT COALESCE(SUM(total_amount),0) FROM ar_invoices WHERE client_po_id = $1 AND status != 'cancelled') >= total_amount THEN 'fully_invoiced'
              WHEN (SELECT COALESCE(SUM(total_amount),0) FROM ar_invoices WHERE client_po_id = $1 AND status != 'cancelled') > 0 THEN 'partially_invoiced'
              ELSE status END,
            updated_at = NOW()
          WHERE id = $1
        `, [inv.client_po_id]);
      }

      // 5. Queue refresh
      await client.query(`
        INSERT INTO finance_refresh_queue (project_id, reason)
        VALUES ($1, 'ar_payment.insert') ON CONFLICT DO NOTHING
      `, [inv.project_id]);

      return { payment: payment.rows[0], invoice: updatedInvoice.rows[0] };
    });
    // ── END TRANSACTION ───────────────────────────────────────

    res.status(201).json({ success: true, message: 'Payment recorded.', data: result });
  } catch (error) {
    if (error.message?.includes('AR_OVERPAYMENT') || error.message?.includes('overpayment')) {
      return res.status(400).json({ success: false, error: 'AR_OVERPAYMENT', message: 'Payment exceeds outstanding balance.' });
    }
    next(error);
  }
});

// ─── POST /api/ar-invoices/mark-overdue ──────────────────────
router.post('/mark-overdue', async (req, res, next) => {
  try {
    const result = await query(`
      UPDATE ar_invoices SET status = 'overdue', updated_at = NOW()
      WHERE due_date < CURRENT_DATE AND status IN ('issued','partially_paid') AND outstanding_balance > 0
      RETURNING id, folio, due_date, outstanding_balance
    `);
    res.json({ success: true, message: `${result.rows.length} invoice(s) marked overdue.`, data: result.rows });
  } catch (error) { next(error); }
});

module.exports = router;
