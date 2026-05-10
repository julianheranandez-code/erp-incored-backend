'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { queueRefresh } = require('../services/financeRefresh');
const logger = require('../utils/logger');

router.use(verifyToken);

// ─── MULTI-COMPANY ISOLATION ──────────────────────────────────
function getAuthorizedCompanyId(user, requestedCompanyId) {
  if (user.role === 'admin') {
    return requestedCompanyId ? parseInt(requestedCompanyId) : null;
  }
  return parseInt(user.company_id);
}

async function assertBillAccess(billId, user) {
  const result = await query(
    'SELECT id, company_id, project_id, status, total_amount, total_paid, outstanding_balance FROM ap_bills WHERE id = $1',
    [billId]
  );
  if (!result.rows[0]) return { error: 'not_found', message: 'Bill not found.' };
  if (user.role !== 'admin' && result.rows[0].company_id !== parseInt(user.company_id)) {
    return { error: 'forbidden', message: 'Access denied to this bill.' };
  }
  return { bill: result.rows[0] };
}

// ─── GET /api/ap-bills ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, sort = 'issue_date', order = 'DESC',
            project_id, status, vendor_id, date_from, date_to, overdue_only } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`b.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (project_id)          { conditions.push(`b.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (status)              { conditions.push(`b.status = $${idx++}`);     values.push(status); }
    if (vendor_id)           { conditions.push(`b.vendor_id = $${idx++}`);  values.push(parseInt(vendor_id)); }
    if (date_from)           { conditions.push(`b.issue_date >= $${idx++}`); values.push(date_from); }
    if (date_to)             { conditions.push(`b.issue_date <= $${idx++}`); values.push(date_to); }
    if (overdue_only === 'true') {
      conditions.push(`b.due_date < CURRENT_DATE`);
      conditions.push(`b.outstanding_balance > 0`);
      conditions.push(`b.status NOT IN ('paid','cancelled')`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const validSorts = ['issue_date','due_date','total_amount','status','vendor_invoice_no'];
    const sortField = validSorts.includes(sort) ? sort : 'issue_date';
    const sortOrder = order === 'ASC' ? 'ASC' : 'DESC';

    const [bills, summary, aging, total] = await Promise.all([
      query(`
        SELECT b.*,
          v.name AS vendor_name, v.rfc AS vendor_rfc,
          p.name AS project_name, p.code AS project_code,
          co.name AS company_name,
          cpo.po_number AS client_po_number,
          CONCAT(u.first_name, ' ', u.last_name) AS created_by_name,
          CONCAT(ua.first_name, ' ', ua.last_name) AS approved_by_name
        FROM ap_bills b
        LEFT JOIN clients v    ON v.id = b.vendor_id
        LEFT JOIN projects p   ON p.id = b.project_id
        LEFT JOIN companies co ON co.id = b.company_id
        LEFT JOIN client_purchase_orders cpo ON cpo.id = b.client_po_id
        LEFT JOIN users u      ON u.id = b.created_by
        LEFT JOIN users ua     ON ua.id = b.approved_by
        ${where}
        ORDER BY b.${sortField} ${sortOrder}
        LIMIT $${idx} OFFSET $${idx + 1}
      `, [...values, parseInt(limit), offset]),

      query(`
        SELECT
          COALESCE(SUM(total_amount), 0) AS total_ap,
          COALESCE(SUM(outstanding_balance), 0) AS outstanding_ap,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE AND status NOT IN ('paid','cancelled')), 0) AS overdue_ap,
          COALESCE(SUM(total_paid) FILTER (WHERE DATE_TRUNC('month', issue_date) = DATE_TRUNC('month', CURRENT_DATE)), 0) AS paid_this_month
        FROM ap_bills b ${where}
      `, values),

      query(`
        SELECT
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date >= CURRENT_DATE), 0) AS current_bucket,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - INTERVAL '30 days'), 0) AS days_1_30,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE - INTERVAL '30 days' AND due_date >= CURRENT_DATE - INTERVAL '60 days'), 0) AS days_31_60,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE - INTERVAL '60 days' AND due_date >= CURRENT_DATE - INTERVAL '90 days'), 0) AS days_61_90,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE - INTERVAL '90 days'), 0) AS days_90_plus
        FROM ap_bills b
        WHERE outstanding_balance > 0 AND status NOT IN ('paid','cancelled')
        ${authorizedCompanyId ? 'AND b.company_id = $1' : ''}
      `, authorizedCompanyId ? [authorizedCompanyId] : []),

      query(`SELECT COUNT(*) AS total FROM ap_bills b ${where}`, values)
    ]);

    res.json({
      success: true,
      data: {
        bills: bills.rows,
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

// ─── GET /api/ap-bills/:id ────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const access = await assertBillAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    const [bill, items, payments] = await Promise.all([
      query(`
        SELECT b.*,
          v.name AS vendor_name, v.rfc AS vendor_rfc,
          v.primary_contact_name, v.primary_contact_email,
          p.name AS project_name, p.code AS project_code,
          co.name AS company_name, co.short_code AS company_code,
          cpo.po_number AS client_po_number, cpo.total_amount AS po_total,
          CONCAT(u.first_name, ' ', u.last_name) AS created_by_name,
          CONCAT(ua.first_name, ' ', ua.last_name) AS approved_by_name
        FROM ap_bills b
        LEFT JOIN clients v    ON v.id = b.vendor_id
        LEFT JOIN projects p   ON p.id = b.project_id
        LEFT JOIN companies co ON co.id = b.company_id
        LEFT JOIN client_purchase_orders cpo ON cpo.id = b.client_po_id
        LEFT JOIN users u      ON u.id = b.created_by
        LEFT JOIN users ua     ON ua.id = b.approved_by
        WHERE b.id = $1
      `, [id]),
      query('SELECT * FROM ap_bill_items WHERE bill_id = $1 ORDER BY line_order ASC', [id]),
      query('SELECT * FROM ap_payments WHERE bill_id = $1 ORDER BY payment_date DESC', [id])
    ]);

    res.json({
      success: true,
      data: { bill: bill.rows[0], items: items.rows, payments: payments.rows }
    });
  } catch (error) { next(error); }
});

// ─── POST /api/ap-bills ───────────────────────────────────────
router.post('/', async (req, res, next) => {
  const startTime = Date.now();
  logger.info('[AP Bills] POST / → request received');

  try {
    const {
      company_id, project_id, vendor_id, client_po_id,
      vendor_invoice_no, folio, description, notes,
      subtotal, tax_percent = 16,
      currency = 'MXN', exchange_rate = 1,
      issue_date, due_date,
      cfdi_uuid, cfdi_xml_url, attachment_url,
      items = []
    } = req.body;

    if (!company_id || !project_id || !vendor_id || !subtotal || !due_date) {
      return res.status(400).json({
        success: false, error: 'validation_error',
        message: 'Required: company_id, project_id, vendor_id, subtotal, due_date'
      });
    }

    if (req.user.role !== 'admin' && parseInt(company_id) !== parseInt(req.user.company_id)) {
      return res.status(403).json({
        success: false, error: 'forbidden',
        message: 'You can only create bills for your own company.'
      });
    }

    const tax_amount   = parseFloat(subtotal) * (parseFloat(tax_percent) / 100);
    const total_amount = parseFloat(subtotal) + tax_amount;

    logger.info('[AP Bills] transaction starting');

    // ── ATOMIC TRANSACTION ────────────────────────────────────
    const result = await withTransaction(async (client) => {

      // 1. Insert bill
      const bill = await client.query(`
        INSERT INTO ap_bills (
          company_id, project_id, vendor_id, client_po_id,
          vendor_invoice_no, folio, description, notes,
          subtotal, tax_percent, tax_amount, total_amount,
          currency, exchange_rate,
          status, issue_date, due_date,
          cfdi_uuid, cfdi_xml_url, attachment_url,
          created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'received',$15,$16,$17,$18,$19,$20)
        RETURNING *
      `, [
        parseInt(company_id), parseInt(project_id),
        parseInt(vendor_id),
        client_po_id ? parseInt(client_po_id) : null,
        vendor_invoice_no || null, folio || null,
        description || null, notes || null,
        parseFloat(subtotal), parseFloat(tax_percent), tax_amount, total_amount,
        currency, parseFloat(exchange_rate),
        issue_date || new Date().toISOString().split('T')[0],
        due_date,
        cfdi_uuid || null, cfdi_xml_url || null, attachment_url || null,
        req.user.id
      ]);

      logger.info(`[AP Bills] bill inserted id=${bill.rows[0].id}`);

      // 2. Insert line items
      if (items.length > 0) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const itemTotal = parseFloat(item.quantity) * parseFloat(item.unit_cost);
          await client.query(`
            INSERT INTO ap_bill_items
              (bill_id, description, quantity, unit, unit_cost, total_cost, line_order)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
          `, [bill.rows[0].id, item.description, item.quantity,
              item.unit || null, item.unit_cost, itemTotal, i + 1]);
        }
        logger.info(`[AP Bills] ${items.length} items inserted`);
      }

      return bill.rows[0];
    });
    // ── END TRANSACTION ───────────────────────────────────────

    logger.info(`[AP Bills] transaction committed in ${Date.now() - startTime}ms`);

    // ── FIRE AND FORGET — never block response ────────────────

    // Audit log (non-blocking)
    writeAudit({
      userId: req.user.id, action: 'ap_bill_created',
      entityType: 'ap_bills', entityId: result.id,
      companyId: result.company_id, newValues: result,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[AP Bills] audit failed:', err.message));

    logger.info('[AP Bills] audit queued (non-blocking)');

    // Finance refresh (non-blocking)
    setImmediate(() => {
      queueRefresh(result.project_id, 'ap_bill.create');
      logger.info('[AP Bills] finance refresh queued (non-blocking)');
    });

    // ── RESPOND IMMEDIATELY ───────────────────────────────────
    logger.info(`[AP Bills] response sent in ${Date.now() - startTime}ms`);
    res.status(201).json({ success: true, message: 'Bill created.', data: result });

  } catch (error) {
    if (error.message?.startsWith('PO_EXCEEDED')) {
      return res.status(422).json({
        success: false, error: 'po_exceeded',
        message: 'Bill amount exceeds committed PO amount.',
        details: error.message
      });
    }
    next(error);
  }
});

// ─── PUT /api/ap-bills/:id ────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const access = await assertBillAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    if (access.bill.status === 'paid') {
      return res.status(400).json({
        success: false, error: 'bill_paid',
        message: 'Cannot edit a fully paid bill.'
      });
    }

    const existing = await query('SELECT * FROM ap_bills WHERE id = $1', [id]);
    const bill = existing.rows[0];
    const { status, notes, due_date, subtotal, tax_percent,
            cfdi_uuid, cfdi_xml_url, attachment_url } = req.body;

    const newSubtotal    = subtotal    ? parseFloat(subtotal)    : parseFloat(bill.subtotal);
    const newTaxPercent  = tax_percent ? parseFloat(tax_percent) : parseFloat(bill.tax_percent);
    const newTaxAmount   = newSubtotal * (newTaxPercent / 100);
    const newTotalAmount = newSubtotal + newTaxAmount;

    const result = await query(`
      UPDATE ap_bills SET
        status = COALESCE($1, status), notes = COALESCE($2, notes),
        due_date = COALESCE($3, due_date),
        subtotal = $4, tax_percent = $5, tax_amount = $6, total_amount = $7,
        cfdi_uuid = COALESCE($8, cfdi_uuid),
        cfdi_xml_url = COALESCE($9, cfdi_xml_url),
        attachment_url = COALESCE($10, attachment_url),
        updated_at = NOW()
      WHERE id = $11 RETURNING *
    `, [status || null, notes || null, due_date || null,
        newSubtotal, newTaxPercent, newTaxAmount, newTotalAmount,
        cfdi_uuid || null, cfdi_xml_url || null, attachment_url || null, id]);

    // Fire and forget
    writeAudit({
      userId: req.user.id, action: 'ap_bill_updated',
      entityType: 'ap_bills', entityId: id,
      companyId: result.rows[0].company_id,
      oldValues: { subtotal: bill.subtotal, status: bill.status },
      newValues: { subtotal: result.rows[0].subtotal, status: result.rows[0].status },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[AP Bills] audit failed:', err.message));

    setImmediate(() => queueRefresh(result.rows[0].project_id, 'ap_bill.update'));

    res.json({ success: true, message: 'Bill updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /api/ap-bills/:id/payments ─────────────────────────
router.post('/:id/payments', async (req, res, next) => {
  const startTime = Date.now();
  logger.info('[AP Bills] POST /:id/payments → request received');

  try {
    const id = parseInt(req.params.id);
    const access = await assertBillAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    if (!['admin','finance','manager'].includes(req.user.role)) {
      return res.status(403).json({
        success: false, error: 'forbidden',
        message: 'Only finance team can register payments.'
      });
    }

    const { payment_amount, payment_date, payment_method, reference, notes } = req.body;
    if (!payment_amount || !payment_date) {
      return res.status(400).json({
        success: false, error: 'validation_error',
        message: 'Required: payment_amount, payment_date'
      });
    }

    const bill        = await query('SELECT * FROM ap_bills WHERE id = $1', [id]);
    const b           = bill.rows[0];
    const amount      = parseFloat(payment_amount);
    const outstanding = parseFloat(b.outstanding_balance);

    if (b.status === 'cancelled') return res.status(400).json({ success: false, error: 'bill_cancelled', message: 'Cannot pay a cancelled bill.' });
    if (amount <= 0) return res.status(400).json({ success: false, error: 'invalid_amount', message: 'Amount must be > 0.' });
    if (amount > outstanding) return res.status(400).json({ success: false, error: 'AP_OVERPAYMENT', message: `Exceeds outstanding: ${outstanding}` });

    logger.info('[AP Bills] payment transaction starting');

    // ── ATOMIC TRANSACTION ────────────────────────────────────
    const result = await withTransaction(async (client) => {

      const payment = await client.query(`
        INSERT INTO ap_payments (
          bill_id, company_id, project_id,
          amount, currency, exchange_rate,
          payment_date, payment_method, reference, notes, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
      `, [id, b.company_id, b.project_id, amount,
          b.currency, parseFloat(b.exchange_rate),
          payment_date, payment_method || null,
          reference || null, notes || null, req.user.id]);

      const newTotalPaid = parseFloat(b.total_paid) + amount;
      const newStatus    = newTotalPaid >= parseFloat(b.total_amount) ? 'paid' : 'partially_paid';
      const paidDate     = newStatus === 'paid' ? payment_date : null;

      const updatedBill = await client.query(`
        UPDATE ap_bills SET
          total_paid = $1, status = $2,
          paid_date  = COALESCE($3, paid_date),
          updated_at = NOW()
        WHERE id = $4 RETURNING *
      `, [newTotalPaid, newStatus, paidDate, id]);

      return { payment: payment.rows[0], bill: updatedBill.rows[0] };
    });
    // ── END TRANSACTION ───────────────────────────────────────

    logger.info(`[AP Bills] payment committed in ${Date.now() - startTime}ms`);

    // Fire and forget
    writeAudit({
      userId: req.user.id, action: 'ap_payment_registered',
      entityType: 'ap_bills', entityId: id,
      companyId: b.company_id,
      newValues: { payment_id: result.payment.id, amount, payment_date, bill_status: result.bill.status },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[AP Bills] audit failed:', err.message));

    setImmediate(() => {
      queueRefresh(b.project_id, 'ap_payment.insert');
      logger.info('[AP Bills] finance refresh queued');
    });

    logger.info(`[AP Bills] payment response sent in ${Date.now() - startTime}ms`);
    res.status(201).json({ success: true, message: 'Payment registered.', data: result });

  } catch (error) {
    if (error.message?.includes('AP_OVERPAYMENT') || error.message?.includes('overpayment')) {
      return res.status(400).json({ success: false, error: 'AP_OVERPAYMENT', message: 'Payment exceeds outstanding balance.' });
    }
    next(error);
  }
});

// ─── POST /api/ap-bills/mark-overdue ─────────────────────────
router.post('/mark-overdue', async (req, res, next) => {
  try {
    if (!['admin','finance','manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Insufficient permissions.' });
    }

    const companyFilter = req.user.role !== 'admin' ? `AND company_id = $1` : '';
    const params = req.user.role !== 'admin' ? [parseInt(req.user.company_id)] : [];

    const result = await query(`
      UPDATE ap_bills SET status = 'overdue', updated_at = NOW()
      WHERE due_date < CURRENT_DATE
        AND status IN ('received','approved','partially_paid')
        AND outstanding_balance > 0
        ${companyFilter}
      RETURNING id, vendor_invoice_no, due_date, outstanding_balance, company_id, project_id
    `, params);

    const projectIds = [...new Set(result.rows.map(r => r.project_id))];
    setImmediate(() => {
      projectIds.forEach(pid => queueRefresh(pid, 'ap_bills.mark_overdue'));
    });

    res.json({
      success: true,
      message: `${result.rows.length} bill(s) marked overdue.`,
      data: result.rows
    });
  } catch (error) { next(error); }
});

module.exports = router;
