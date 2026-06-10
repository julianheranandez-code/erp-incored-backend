'use strict';

const { onAPPaymentRecorded, onAPBillCancelled } = require('../services/financial-event-service');

/**
 * AP Bills v2 — Sprint 3D
 * ========================
 * Enhancements:
 *   - Approval Engine V2 integration (AP_BILL type)
 *   - Vendor Master integration (vendor_master_id → vendors)
 *   - Internal PO balance consumption (atomic, FOR UPDATE)
 *   - Treasury Payment Request auto-creation on approval
 *   - Project budget control
 *   - Full status lifecycle
 *   - Atomic completion via Sprint 3C.2 service
 */

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { getApprovalChain, resolveApprovers, getCompanyApprovalPolicy } = require('../lib/approval-engine');
const { queueRefresh } = require('../services/financeRefresh');
const logger = require('../utils/logger');

router.use(verifyToken);

// ─── HELPERS ──────────────────────────────────────────────────
function getEffectiveRoles(user) {
  return user.roles?.length ? user.roles : user.role ? [user.role] : [];
}

async function getBillAccess(id) {
  const result = await query(
    `SELECT * FROM ap_bills WHERE id = $1`, [parseInt(id)]
  );
  if (!result.rows[0]) return { error: 'not_found' };
  return { bill: result.rows[0] };
}

// ─── GET /api/ap-bills ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { company_id, project_id, status, vendor_id,
            vendor_master_id, internal_po_id,
            date_from, date_to, overdue_only,
            page = 1, limit = 50 } = req.query;

    const roles = getEffectiveRoles(req.user);
    const companyId = roles.includes('super_admin') && company_id
      ? parseInt(company_id)
      : parseInt(req.user.active_company_id || req.user.company_id);

    const conditions = [`b.company_id = $1`];
    const values = [companyId];
    let idx = 2;

    if (project_id)       { conditions.push(`b.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (status)           { conditions.push(`b.status = $${idx++}`); values.push(status); }
    if (vendor_id)        { conditions.push(`b.vendor_id = $${idx++}`); values.push(parseInt(vendor_id)); }
    if (vendor_master_id) { conditions.push(`b.vendor_master_id = $${idx++}`); values.push(parseInt(vendor_master_id)); }
    if (internal_po_id)   { conditions.push(`b.internal_po_id = $${idx++}`); values.push(parseInt(internal_po_id)); }
    if (date_from)        { conditions.push(`b.issue_date >= $${idx++}`); values.push(date_from); }
    if (date_to)          { conditions.push(`b.issue_date <= $${idx++}`); values.push(date_to); }
    if (overdue_only === 'true') conditions.push(`b.due_date < CURRENT_DATE AND b.status NOT IN ('paid','cancelled')`);

    const where = `WHERE ${conditions.join(' AND ')}`;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [rows, summary] = await Promise.all([
      query(`
        SELECT b.*,
          v.name AS vendor_name, v.vendor_code,
          vm.name AS vendor_master_name,
          p.name AS project_name, p.code AS project_code,
          po.po_number AS internal_po_number,
          CONCAT(u.first_name,' ',u.last_name) AS created_by_name
        FROM ap_bills b
        LEFT JOIN clients v    ON v.id = b.vendor_id
        LEFT JOIN vendors vm   ON vm.id = b.vendor_master_id
        LEFT JOIN projects p   ON p.id = b.project_id
        LEFT JOIN internal_purchase_orders po ON po.id = b.internal_po_id
        LEFT JOIN users u      ON u.id = b.created_by
        ${where}
        ORDER BY b.due_date ASC, b.created_at DESC
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, parseInt(limit), offset]),
      query(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(total_amount), 0) AS total_amount,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE status NOT IN ('paid','cancelled')), 0) AS outstanding,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE due_date < CURRENT_DATE AND status NOT IN ('paid','cancelled')), 0) AS overdue_ap,
          COALESCE(SUM(total_amount) FILTER (WHERE status='pending_approval'), 0) AS pending_approval
        FROM ap_bills b ${where}
      `, values)
    ]);

    res.json({ success: true, count: rows.rows.length,
      total: parseInt(summary.rows[0].total),
      summary: summary.rows[0], data: rows.rows });
  } catch(error) { next(error); }
});

// ─── GET /api/ap-bills/:id ────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT b.*,
        v.name AS vendor_name, v.rfc AS vendor_rfc,
        vm.name AS vendor_master_name, vm.vendor_code, vm.tax_id AS vendor_tax_id,
        p.name AS project_name, p.code AS project_code,
        po.po_number AS internal_po_number, po.remaining_amount AS po_remaining,
        CONCAT(ua.first_name,' ',ua.last_name) AS approved_by_name
      FROM ap_bills b
      LEFT JOIN clients v    ON v.id = b.vendor_id
      LEFT JOIN vendors vm   ON vm.id = b.vendor_master_id
      LEFT JOIN projects p   ON p.id = b.project_id
      LEFT JOIN internal_purchase_orders po ON po.id = b.internal_po_id
      LEFT JOIN users ua     ON ua.id = b.approved_by
      WHERE b.id = $1
    `, [parseInt(req.params.id)]);

    if (!result.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const [items, payments] = await Promise.all([
      query(`SELECT * FROM ap_bill_items WHERE bill_id=$1 ORDER BY id`, [parseInt(req.params.id)]).catch(() => ({ rows: [] })),
      query(`SELECT * FROM ap_payments WHERE bill_id=$1 ORDER BY payment_date DESC`, [parseInt(req.params.id)]).catch(() => ({ rows: [] }))
    ]);

    res.json({ success: true, data: {
      bill: result.rows[0], items: items.rows, payments: payments.rows
    }});
  } catch(error) { next(error); }
});

// ─── POST /api/ap-bills ───────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      company_id, project_id, vendor_id, vendor_master_id,
      internal_po_id, client_po_id, vendor_invoice_no, folio,
      description, notes, subtotal, tax_percent = 0, due_date,
      issue_date = new Date().toISOString().slice(0,10),
      currency = 'MXN', exchange_rate = 1
    } = req.body;

    if (!company_id || !project_id || !subtotal || !due_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, project_id, subtotal, due_date' });

    // FIX 1: vendor_master_id mandatory for all new AP Bills
    // Historical records with vendor_id only remain unaffected
    if (!vendor_master_id)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Vendor is required. Provide vendor_master_id.' });

    const tax_amount   = parseFloat(subtotal) * (parseFloat(tax_percent) / 100);
    const total_amount = parseFloat(subtotal) + tax_amount;

    // Validate Internal PO if provided (balance check at creation — informational)
    if (internal_po_id) {
      const poCheck = await query(
        `SELECT id, status, remaining_amount, total_amount
         FROM internal_purchase_orders WHERE id=$1 AND company_id=$2`,
        [parseInt(internal_po_id), parseInt(company_id)]
      );
      if (!poCheck.rows[0])
        return res.status(400).json({ success: false, error: 'invalid_internal_po',
          message: 'Internal PO not found or belongs to different company.' });

      const po = poCheck.rows[0];
      if (!['approved','partially_consumed'].includes(po.status))
        return res.status(400).json({ success: false, error: 'po_not_approved',
          message: `Internal PO must be approved. Current status: ${po.status}` });

      if (parseFloat(po.remaining_amount) < total_amount)
        return res.status(400).json({ success: false, error: 'po_balance_exceeded',
          message: `Bill total (${total_amount}) exceeds PO remaining balance (${po.remaining_amount}).`,
          po_remaining: parseFloat(po.remaining_amount), bill_total: total_amount });
    }

    const result = await withTransaction(async (client) => {
      const bill = await client.query(`
        INSERT INTO ap_bills (
          company_id, project_id, vendor_id, vendor_master_id,
          internal_po_id, client_po_id, vendor_invoice_no, folio,
          description, notes, subtotal, tax_percent, tax_amount,
          total_amount, total_paid, outstanding_balance,
          currency, exchange_rate, status, issue_date, due_date,
          approval_required, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,$14,
                  $15,$16,'draft',$17,$18,true,$19)
        RETURNING *
      `, [parseInt(company_id), parseInt(project_id),
          vendor_id ? parseInt(vendor_id) : null,
          vendor_master_id ? parseInt(vendor_master_id) : null,
          internal_po_id ? parseInt(internal_po_id) : null,
          client_po_id ? parseInt(client_po_id) : null,
          vendor_invoice_no || null, folio || null,
          description || null, notes || null,
          parseFloat(subtotal), parseFloat(tax_percent), tax_amount,
          total_amount, currency, parseFloat(exchange_rate),
          issue_date, due_date, req.user.id]);

      return bill.rows[0];
    });

    writeAudit({
      userId: req.user.id, action: 'ap_bill_created',
      entityType: 'ap_bills', entityId: String(result.id),
      companyId: parseInt(company_id),
      newValues: { total_amount, vendor_master_id, internal_po_id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    setImmediate(() => queueRefresh(result.project_id, 'ap_bill.create'));
    res.status(201).json({ success: true, message: 'AP Bill created.', data: result });
  } catch(error) {
    if (error.code === '23505')
      return res.status(409).json({ success: false, error: 'duplicate_folio',
        message: 'Folio already exists.' });
    next(error);
  }
});

// ─── POST /api/ap-bills/:id/submit ───────────────────────────
router.post('/:id/submit', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const access = await getBillAccess(id);
    if (access.error)
      return res.status(404).json({ success: false, error: access.error });

    const bill = access.bill;
    if (!['draft','rejected'].includes(bill.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Only draft bills can be submitted. Current: ${bill.status}` });

    const approvalPolicy = await getCompanyApprovalPolicy(bill.company_id);

    let chain;
    try {
      chain = getApprovalChain('AP_BILL', bill.total_amount, approvalPolicy);
    } catch(err) {
      return res.status(400).json({ success: false, error: 'approval_chain_error',
        message: err.message });
    }

    const { resolved, missing } = await resolveApprovers(bill.company_id, chain);
    if (missing.length > 0)
      return res.status(400).json({ success: false, error: 'missing_approver_assignments',
        message: `No approver assigned for roles: ${missing.join(', ')}`,
        missing_roles: missing });

    const finalLevel = resolved.length;
    let approvalRequestId = null;

    await withTransaction(async (client) => {
      const approvalResult = await client.query(`
        INSERT INTO treasury_approval_requests
          (company_id, approval_type, entity_type, entity_id, amount, currency,
           status, requested_by, current_level, final_level, notes)
        VALUES ($1,'AP_BILL','AP_BILL',$2,$3,$4,'pending',$5,1,$6,$7)
        RETURNING id
      `, [bill.company_id, String(id), bill.total_amount, bill.currency || 'MXN',
          req.user.id, finalLevel,
          `AP Bill ${bill.folio || bill.vendor_invoice_no || '#'+id}: ${bill.description || ''}`]);

      approvalRequestId = approvalResult.rows[0].id;

      for (const step of resolved) {
        await client.query(`
          INSERT INTO treasury_approval_steps
            (request_id, level_number, approver_role, approver_user_id, status)
          VALUES ($1,$2,$3,$4,'pending')
        `, [approvalRequestId, step.level, step.role, step.user_id]);
      }

      await client.query(`
        UPDATE ap_bills SET
          status = 'pending_approval',
          approval_request_id = $1,
          updated_at = NOW()
        WHERE id = $2
      `, [approvalRequestId, id]);
    });

    writeAudit({
      userId: req.user.id, action: 'ap_bill_submitted',
      entityType: 'ap_bills', entityId: String(id),
      companyId: bill.company_id,
      newValues: { status: 'pending_approval', approval_request_id: approvalRequestId,
                   approval_policy: approvalPolicy, levels: finalLevel },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'AP Bill submitted for approval.',
      data: { bill_id: id, approval_request_id: approvalRequestId,
              approval_chain: resolved.map(s => ({ level: s.level, role: s.role, approver: s.user_name })) }
    });
  } catch(error) { next(error); }
});

// ─── POST /api/ap-bills/:id/payments ─────────────────────────
router.post('/:id/payments', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { payment_amount, payment_date, payment_method, reference, notes } = req.body;

    if (!payment_amount || !payment_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: payment_amount, payment_date' });

    const access = await getBillAccess(id);
    if (access.error) return res.status(404).json({ success: false, error: access.error });

    const b = access.bill;
    const amount      = parseFloat(payment_amount);
    const outstanding = parseFloat(b.outstanding_balance);

    if (b.status === 'cancelled')
      return res.status(400).json({ success: false, error: 'bill_cancelled' });
    if (!['approved','partially_paid'].includes(b.status))
      return res.status(400).json({ success: false, error: 'bill_not_approved',
        message: `Bill must be approved before payment. Status: ${b.status}` });
    if (amount <= 0)
      return res.status(400).json({ success: false, error: 'invalid_amount' });
    if (amount > outstanding)
      return res.status(400).json({ success: false, error: 'AP_OVERPAYMENT',
        message: `Payment (${amount}) exceeds outstanding balance (${outstanding})` });

    const result = await withTransaction(async (client) => {
      const newTotalPaid = parseFloat(b.total_paid) + amount;
      const newOutstanding = parseFloat(b.total_amount) - newTotalPaid;
      const newStatus = newOutstanding <= 0 ? 'paid' : 'partially_paid';
      const paidDate = newStatus === 'paid' ? payment_date : null;

      const payment = await client.query(`
        INSERT INTO ap_payments (bill_id, company_id, project_id, amount,
          payment_date, payment_method, reference, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
      `, [id, b.company_id, b.project_id, amount,
          payment_date, payment_method||null, reference||null, notes||null, req.user.id]);

      const updatedBill = await client.query(`
        UPDATE ap_bills SET
          total_paid = $1, outstanding_balance = $2,
          status = $3, paid_date = COALESCE($4, paid_date),
          updated_at = NOW()
        WHERE id = $5 RETURNING *
      `, [newTotalPaid, newOutstanding, newStatus, paidDate, id]);

      // Sprint 5.2B.1 FIX: AP payment events are ATOMIC — inside transaction
      // Consistent with AR payment architecture — cash events must not fail silently
      const { onAPPaymentRecorded } = require('../services/financial-event-service');
      try {
        await onAPPaymentRecorded(payment.rows[0], b, req.user.id, client);
      } catch(evtErr) {
        logger.error(`[AP] Payment financial event failed: ${evtErr.message}`);
        throw evtErr; // Rollback payment — no partial state
      }

      return { payment: payment.rows[0], bill: updatedBill.rows[0] };
    });

    writeAudit({
      userId: req.user.id, action: 'ap_bill_payment_registered',
      entityType: 'ap_bills', entityId: String(id),
      companyId: b.company_id,
      newValues: { amount, bill_status: result.bill.status },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    setImmediate(() => queueRefresh(b.project_id, 'ap_payment.insert'));
    res.status(201).json({ success: true, message: 'Payment registered.', data: result });
  } catch(error) {
    if (error.code === '23514' || (error.message||'').includes('AP_OVERPAYMENT'))
      return res.status(400).json({ success: false, error: 'AP_OVERPAYMENT',
        message: 'Payment exceeds outstanding balance.' });
    next(error);
  }
});

// ─── POST /api/ap-bills/:id/cancel ───────────────────────────
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    if (!reason)
      return res.status(400).json({ success: false, error: 'reason_required' });

    const access = await getBillAccess(id);
    if (access.error) return res.status(404).json({ success: false, error: access.error });

    const bill = access.bill;
    const roles = getEffectiveRoles(req.user);
    if (bill.created_by !== req.user.id && !roles.includes('super_admin'))
      return res.status(403).json({ success: false, error: 'cancel_denied' });

    if (['paid','cancelled'].includes(bill.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Cannot cancel ${bill.status} bill.` });

    await query(`
      UPDATE ap_bills SET status='cancelled',
        notes=CONCAT(COALESCE(notes,''),' | Cancelled: ',$1), updated_at=NOW()
      WHERE id=$2
    `, [reason, id]);

    // Sprint 5.2B.1: Emit REVERSAL events for OPEX + LIABILITY
    onAPBillCancelled(bill, req.user.id).catch(e =>
      logger.error(`[AP] Cancel reversal event failed: ${e.message}`)
    );

    setImmediate(() => queueRefresh(bill.project_id, 'ap_bill.cancel'));
    res.json({ success: true, message: 'AP Bill cancelled.' });
  } catch(error) { next(error); }
});

// ─── GET /api/ap-bills/project/:projectId/budget ──────────────
// Phase 14: Project Profitability Foundation
router.get('/project/:projectId/budget', async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.projectId);

    const [project, bills, pos] = await Promise.all([
      query(`
        SELECT id, name, code, budget_amount, contract_value, budget_cost,
               expected_margin, spent_amount, currency
        FROM projects WHERE id=$1
      `, [projectId]),
      query(`
        SELECT
          COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled','rejected')),0) AS total_billed,
          COALESCE(SUM(total_paid),0) AS total_paid,
          COALESCE(SUM(outstanding_balance) FILTER (WHERE status NOT IN ('cancelled','rejected')),0) AS outstanding
        FROM ap_bills WHERE project_id=$1
      `, [projectId]),
      query(`
        SELECT
          COALESCE(SUM(committed_amount) FILTER (
            WHERE status IN ('approved','partially_consumed','fully_consumed')
          ),0) AS total_committed,
          COALESCE(SUM(total_amount) - SUM(remaining_amount) FILTER (
            WHERE status IN ('partially_consumed','fully_consumed')
          ),0) AS total_consumed
        FROM internal_purchase_orders WHERE project_id=$1
      `, [projectId])
    ]);

    if (!project.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const p = project.rows[0];
    const b = bills.rows[0];
    const po = pos.rows[0];

    const contractValue  = parseFloat(p.contract_value || p.budget_amount || 0);
    const budgetCost     = parseFloat(p.budget_cost || 0);
    const totalCommitted = parseFloat(po.total_committed || 0);
    const totalBilled    = parseFloat(b.total_billed || 0);
    const totalPaid      = parseFloat(b.total_paid || 0);
    const availableBudget = budgetCost > 0 ? budgetCost - totalCommitted : null;
    const expectedMargin = contractValue - budgetCost;
    const actualMargin   = contractValue - totalBilled;

    res.json({ success: true, data: {
      project_id: projectId,
      project_code: p.code,
      project_name: p.name,
      contract_value: contractValue,
      budget_cost: budgetCost,
      available_budget: availableBudget,
      total_committed: totalCommitted,
      total_billed: totalBilled,
      total_paid: totalPaid,
      outstanding: parseFloat(b.outstanding || 0),
      expected_margin: expectedMargin,
      actual_margin: actualMargin,
      margin_percent: contractValue > 0
        ? Math.round((actualMargin / contractValue) * 100 * 10) / 10
        : null
    }});
  } catch(error) { next(error); }
});

module.exports = router;
