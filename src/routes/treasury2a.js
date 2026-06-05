'use strict';

/**
 * Treasury Sprint 2A — Cash Disbursement Control
 * ===============================================
 * Payment Request Foundation
 *
 * Endpoints:
 *   POST   /api/treasury/payment-requests
 *   GET    /api/treasury/payment-requests
 *   GET    /api/treasury/payment-requests/:id
 *   PATCH  /api/treasury/payment-requests/:id/submit
 *   PATCH  /api/treasury/payment-requests/:id/assign-account
 *   PATCH  /api/treasury/payment-requests/:id/schedule
 *   POST   /api/treasury/payment-requests/:id/cancel
 *
 * OUT OF SCOPE (Sprint 2B):
 *   - Payment execution
 *   - treasury_bank_transaction creation
 *   - Dual authorization
 *   - AP Bill / Expense status → paid/reimbursed
 */

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { getEffectivePermissions } = require('../lib/iam/effective-permissions');
const { getApprovalChain, resolveApprovers, getCompanyApprovalPolicy } = require('../lib/approval-engine');
const logger = require('../utils/logger');

router.use(verifyToken);

// ─── HELPERS ─────────────────────────────────────────────────
function getEffectiveRoles(user) {
  return user.roles?.length ? user.roles : user.role ? [user.role] : [];
}

function getCompanyScope(user, queryCompanyId) {
  const roles = getEffectiveRoles(user);
  if (roles.includes('super_admin')) return queryCompanyId ? parseInt(queryCompanyId) : null;
  return parseInt(user.active_company_id || user.company_id);
}

async function assertTreasuryPermission(req, res, permission = 'treasury.view') {
  const roles = getEffectiveRoles(req.user);
  if (roles.includes('super_admin')) return true;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const effective = await getEffectivePermissions(req.user.id, companyId);
    const perms = effective.effective_permissions || [];
    const hasAccess = perms.includes('*') || perms.includes(permission) ||
      perms.includes('treasury.*') ||
      perms.some(p => p.endsWith('.*') && permission.startsWith(p.slice(0,-2)+'.'));
    if (!hasAccess) {
      res.status(403).json({ success: false, error: 'permission_denied', permission });
      return false;
    }
    return true;
  } catch(err) {
    res.status(403).json({ success: false, error: 'permission_check_failed' });
    return false;
  }
}

async function assertCompanyAccess(req, res, companyId) {
  const roles = getEffectiveRoles(req.user);
  if (roles.includes('super_admin')) return true;
  const userCompanyId = parseInt(req.user.active_company_id || user.company_id);
  if (userCompanyId === parseInt(companyId)) return true;
  try {
    const access = await query(
      `SELECT 1 FROM user_company_access WHERE user_id=$1 AND company_id=$2 AND is_active=TRUE`,
      [req.user.id, parseInt(companyId)]
    );
    if (!access.rows[0]) {
      res.status(403).json({ success: false, error: 'company_access_denied' });
      return false;
    }
    return true;
  } catch(err) {
    res.status(403).json({ success: false, error: 'company_access_check_failed' });
    return false;
  }
}

// Derive approval_type from source_document_type + payment_method
function deriveApprovalType(sourceDocType, paymentMethod) {
  if (paymentMethod === 'WIRE' || paymentMethod === 'INTERCOMPANY') return 'INTERNATIONAL_WIRE';
  if (sourceDocType === 'PAYROLL') return 'PAYROLL';
  return 'OPERATING_EXPENSE';
}

// ─── CONSTANTS ────────────────────────────────────────────────
const VALID_METHODS   = ['ACH','WIRE','CHECK','CASH','CARD','INTERCOMPANY'];
const VALID_PRIORITIES = ['urgent','high','normal','low'];
const VALID_DOC_TYPES = ['AP_BILL','EXPENSE','PAYROLL','MANUAL'];

// ─── POST /api/treasury/payment-requests ─────────────────────
router.post('/payment-requests', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const {
      company_id, source_document_type, source_document_id,
      category_id, vendor_id, client_id, amount, currency = 'USD',
      payment_method, payment_priority = 'normal',
      requested_execution_date, bank_account_id, notes
    } = req.body;

    if (!company_id || !amount || !currency)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, amount, currency' });

    if (!await assertCompanyAccess(req, res, company_id)) return;

    if (source_document_type && !VALID_DOC_TYPES.includes(source_document_type))
      return res.status(400).json({ success: false, error: 'invalid_source_document_type' });

    if (payment_method && !VALID_METHODS.includes(payment_method))
      return res.status(400).json({ success: false, error: 'invalid_payment_method',
        message: `payment_method must be: ${VALID_METHODS.join(', ')}` });

    if (payment_priority && !VALID_PRIORITIES.includes(payment_priority))
      return res.status(400).json({ success: false, error: 'invalid_payment_priority' });

    // Validate bank_account if provided
    if (bank_account_id) {
      const acctCheck = await query(
        `SELECT id, currency FROM treasury_bank_accounts WHERE id=$1 AND company_id=$2 AND status='active'`,
        [parseInt(bank_account_id), parseInt(company_id)]
      );
      if (!acctCheck.rows[0])
        return res.status(400).json({ success: false, error: 'invalid_bank_account',
          message: 'Bank account not found, inactive, or belongs to different company.' });
      if (acctCheck.rows[0].currency !== currency)
        return res.status(400).json({ success: false, error: 'currency_mismatch',
          message: `Bank account currency (${acctCheck.rows[0].currency}) does not match payment currency (${currency}).` });
    }

    const result = await query(`
      INSERT INTO treasury_payment_requests (
        company_id, source_document_type, source_document_id,
        category_id, vendor_id, client_id, amount, currency,
        payment_method, payment_priority, requested_execution_date,
        bank_account_id, notes, status, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft',$14)
      RETURNING *
    `, [parseInt(company_id), source_document_type||null, source_document_id||null,
        category_id||null, vendor_id||null, client_id||null,
        parseFloat(amount), currency, payment_method||null, payment_priority,
        requested_execution_date||null, bank_account_id||null, notes||null, req.user.id]);

    writeAudit({
      userId: req.user.id, action: 'payment_request_created',
      entityType: 'treasury_payment_requests', entityId: String(result.rows[0].id),
      companyId: parseInt(company_id),
      newValues: { amount, currency, source_document_type, payment_method },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[PAYMENT] request created: id=${result.rows[0].id} amount=${amount} ${currency}`);
    res.status(201).json({ success: true, message: 'Payment request created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── GET /api/treasury/payment-requests ──────────────────────
router.get('/payment-requests', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (companyId) { conditions.push(`pr.company_id=$${idx++}`); values.push(companyId); }
    if (req.query.status) { conditions.push(`pr.status=$${idx++}`); values.push(req.query.status); }
    if (req.query.source_document_type) { conditions.push(`pr.source_document_type=$${idx++}`); values.push(req.query.source_document_type); }
    if (req.query.payment_method) { conditions.push(`pr.payment_method=$${idx++}`); values.push(req.query.payment_method); }
    if (req.query.payment_priority) { conditions.push(`pr.payment_priority=$${idx++}`); values.push(req.query.payment_priority); }
    if (req.query.bank_account_id) { conditions.push(`pr.bank_account_id=$${idx++}`); values.push(req.query.bank_account_id); }
    if (req.query.date_from) { conditions.push(`pr.requested_execution_date >= $${idx++}`); values.push(req.query.date_from); }
    if (req.query.date_to) { conditions.push(`pr.requested_execution_date <= $${idx++}`); values.push(req.query.date_to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;

    const [result, total] = await Promise.all([
      query(`
        SELECT pr.*,
          c.name AS company_name,
          a.bank_name, a.account_name, a.currency AS account_currency,
          cat.name AS category_name, cat.category_type, cat.cash_flow_class,
          CONCAT(u.first_name,' ',u.last_name) AS created_by_name,
          ar.status AS approval_status
        FROM treasury_payment_requests pr
        JOIN companies c ON c.id = pr.company_id
        LEFT JOIN treasury_bank_accounts a ON a.id = pr.bank_account_id
        LEFT JOIN treasury_transaction_categories cat ON cat.id = pr.category_id
        LEFT JOIN users u ON u.id = pr.created_by
        LEFT JOIN treasury_approval_requests ar ON ar.id = pr.approval_request_id
        ${where}
        ORDER BY
          CASE pr.payment_priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
          pr.requested_execution_date ASC NULLS LAST,
          pr.created_at DESC
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, limit, offset]),
      query(`SELECT COUNT(*) FROM treasury_payment_requests pr ${where}`, values)
    ]);

    res.json({ success: true, count: result.rows.length,
      total: parseInt(total.rows[0].count), data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/treasury/payment-requests/:id ──────────────────
router.get('/payment-requests/:id', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const prId = parseInt(req.params.id);
    const companyId = getCompanyScope(req.user, req.query.company_id);

    const result = await query(`
      SELECT pr.*,
        c.name AS company_name,
        a.bank_name, a.account_name, a.currency AS account_currency,
        cat.name AS category_name, cat.category_type, cat.cash_flow_class,
        CONCAT(u.first_name,' ',u.last_name) AS created_by_name,
        ar.status AS approval_status, ar.current_level, ar.final_level
      FROM treasury_payment_requests pr
      JOIN companies c ON c.id = pr.company_id
      LEFT JOIN treasury_bank_accounts a ON a.id = pr.bank_account_id
      LEFT JOIN treasury_transaction_categories cat ON cat.id = pr.category_id
      LEFT JOIN users u ON u.id = pr.created_by
      LEFT JOIN treasury_approval_requests ar ON ar.id = pr.approval_request_id
      WHERE pr.id=$1 ${companyId ? 'AND pr.company_id=$2' : ''}
    `, companyId ? [prId, companyId] : [prId]);

    if (!result.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── APPROVAL ENGINE: imported from src/lib/approval-engine.js

// ─── PATCH /api/treasury/payment-requests/:id/submit ─────────
router.patch('/payment-requests/:id/submit', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const prId = parseInt(req.params.id);

    const existing = await query(
      `SELECT * FROM treasury_payment_requests WHERE id=$1`, [prId]
    );
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const pr = existing.rows[0];
    if (!await assertCompanyAccess(req, res, pr.company_id)) return;

    if (pr.status !== 'draft')
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Only draft requests can be submitted. Current: ${pr.status}` });

    const approvalType = deriveApprovalType(pr.source_document_type, pr.payment_method);

    // Option A: approval-engine.js is the ONLY source of truth
    // No local threshold logic — engine decides if approval is needed
    // approval-engine.js is the ONLY source of truth for routing
    // Policy fetched from companies table — NOT derived from currency
    const approvalPolicy = await getCompanyApprovalPolicy(pr.company_id);
    const chain = getApprovalChain(approvalType, pr.amount, approvalPolicy);

    // Defensive: engine must always return a chain
    if (!chain || chain.length === 0) {
      return res.status(500).json({ success: false, error: 'approval_chain_missing',
        message: 'No approval chain configured for this payment type and amount.' });
    }

    // Resolve specific users per step
    const { resolved, missing } = await resolveApprovers(pr.company_id, chain);

    if (missing.length > 0)
      return res.status(400).json({ success: false, error: 'missing_approver_assignments',
        message: `No approver assigned for roles: ${missing.join(', ')}. Configure approval_role_assignments first.`,
        missing_roles: missing });

    const finalLevel = resolved.length;
    let approvalRequestId = null;

    await withTransaction(async (client) => {
      // Create approval request header
      const approvalResult = await client.query(`
        INSERT INTO treasury_approval_requests
          (company_id, approval_type, entity_type, entity_id, amount, currency,
           status, requested_by, current_level, final_level, notes)
        VALUES ($1,$2,'PAYMENT_REQUEST',$3,$4,$5,'pending',$6,1,$7,$8)
        RETURNING id
      `, [pr.company_id, approvalType, String(prId), pr.amount, pr.currency,
          req.user.id, finalLevel, `Auto-created for payment request #${prId}`]);

      approvalRequestId = approvalResult.rows[0].id;

      // Create approval steps with assigned users — same pattern as Sprint 1D
      for (const step of resolved) {
        await client.query(`
          INSERT INTO treasury_approval_steps
            (request_id, level_number, approver_role, approver_user_id, status)
          VALUES ($1,$2,$3,$4,'pending')
        `, [approvalRequestId, step.level, step.role, step.user_id]);
      }

      // Link approval to payment request → status = pending_approval
      await client.query(`
        UPDATE treasury_payment_requests
        SET status='pending_approval', approval_request_id=$1, updated_at=NOW()
        WHERE id=$2
      `, [approvalRequestId, prId]);
    });

    logger.info(`[PAYMENT] submitted: id=${prId} approval=${approvalRequestId} steps=${resolved.length}`);

    writeAudit({
      userId: req.user.id, action: 'payment_request_submitted',
      entityType: 'treasury_payment_requests', entityId: String(prId),
      companyId: pr.company_id,
      newValues: { status: 'pending_approval', approval_request_id: approvalRequestId,
                   approval_type: approvalType, levels: finalLevel },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    const updated = await query(`SELECT * FROM treasury_payment_requests WHERE id=$1`, [prId]);
    res.json({ success: true, message: 'Payment request submitted for approval.',
      data: updated.rows[0], approval_request_id: approvalRequestId
    });
  } catch (error) { next(error); }
});

// ─── PATCH /api/treasury/payment-requests/:id/assign-account ─
router.patch('/payment-requests/:id/assign-account', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const prId = parseInt(req.params.id);
    const { bank_account_id } = req.body;

    if (!bank_account_id)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: bank_account_id' });

    const existing = await query(
      `SELECT * FROM treasury_payment_requests WHERE id=$1`, [prId]
    );
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const pr = existing.rows[0];
    if (!await assertCompanyAccess(req, res, pr.company_id)) return;

    if (['cancelled','rejected'].includes(pr.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Cannot assign account to ${pr.status} request.` });

    // Validate bank account belongs to company and is active
    const acctCheck = await query(
      `SELECT * FROM treasury_bank_accounts WHERE id=$1 AND company_id=$2 AND status='active'`,
      [parseInt(bank_account_id), pr.company_id]
    );
    if (!acctCheck.rows[0])
      return res.status(400).json({ success: false, error: 'invalid_bank_account',
        message: 'Bank account not found, inactive, or belongs to different company.' });

    const account = acctCheck.rows[0];

    // Currency match validation
    if (account.currency !== pr.currency)
      return res.status(400).json({ success: false, error: 'currency_mismatch',
        message: `Bank account currency (${account.currency}) does not match payment currency (${pr.currency}).` });

    // Cash position warning (Sprint 2A: warning only, no hard block)
    let cashWarning = null;
    const cashPos = await query(
      `SELECT current_cash_position FROM treasury_cash_position_view
       WHERE account_id=$1`, [parseInt(bank_account_id)]
    );
    if (cashPos.rows[0]) {
      const available = parseFloat(cashPos.rows[0].current_cash_position);
      if (available < parseFloat(pr.amount)) {
        cashWarning = {
          type: 'insufficient_cash_warning',
          available_balance: available,
          payment_amount: parseFloat(pr.amount),
          shortfall: parseFloat(pr.amount) - available,
          message: `Warning: Available balance (${available} ${pr.currency}) is less than payment amount (${pr.amount} ${pr.currency}).`
        };
        logger.warn(`[PAYMENT] cash warning: request=${prId} available=${available} needed=${pr.amount}`);
      }
    }

    const result = await query(`
      UPDATE treasury_payment_requests
      SET bank_account_id=$1, updated_at=NOW()
      WHERE id=$2 RETURNING *
    `, [parseInt(bank_account_id), prId]);

    writeAudit({
      userId: req.user.id, action: 'payment_request_account_assigned',
      entityType: 'treasury_payment_requests', entityId: String(prId),
      companyId: pr.company_id,
      oldValues: { bank_account_id: pr.bank_account_id },
      newValues: { bank_account_id, bank_name: account.bank_name, cash_warning: !!cashWarning },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Bank account assigned.',
      data: result.rows[0], warning: cashWarning || undefined });
  } catch (error) { next(error); }
});

// ─── PATCH /api/treasury/payment-requests/:id/schedule ───────
router.patch('/payment-requests/:id/schedule', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.approve')) return;
  try {
    const prId = parseInt(req.params.id);
    const { scheduled_date } = req.body;

    if (!scheduled_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: scheduled_date' });

    const existing = await query(
      `SELECT * FROM treasury_payment_requests WHERE id=$1`, [prId]
    );
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const pr = existing.rows[0];
    if (!await assertCompanyAccess(req, res, pr.company_id)) return;

    if (pr.status !== 'approved')
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Only approved requests can be scheduled. Current: ${pr.status}` });

    if (!pr.bank_account_id)
      return res.status(400).json({ success: false, error: 'bank_account_required',
        message: 'Assign a bank account before scheduling.' });

    // Validate date is today or future
    const today = new Date().toISOString().slice(0,10);
    if (scheduled_date < today)
      return res.status(400).json({ success: false, error: 'invalid_date',
        message: 'scheduled_date must be today or a future date.' });

    const result = await query(`
      UPDATE treasury_payment_requests
      SET status='scheduled', scheduled_date=$1, updated_at=NOW()
      WHERE id=$2 RETURNING *
    `, [scheduled_date, prId]);

    writeAudit({
      userId: req.user.id, action: 'payment_request_scheduled',
      entityType: 'treasury_payment_requests', entityId: String(prId),
      companyId: pr.company_id,
      newValues: { scheduled_date, bank_account_id: pr.bank_account_id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[PAYMENT] scheduled: id=${prId} date=${scheduled_date}`);
    res.json({ success: true, message: 'Payment request scheduled.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /api/treasury/payment-requests/:id/cancel ──────────
router.post('/payment-requests/:id/cancel', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const prId = parseInt(req.params.id);
    const { reason } = req.body;

    if (!reason)
      return res.status(400).json({ success: false, error: 'reason_required',
        message: 'A cancellation reason is required.' });

    const existing = await query(
      `SELECT * FROM treasury_payment_requests WHERE id=$1`, [prId]
    );
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const pr = existing.rows[0];
    if (!await assertCompanyAccess(req, res, pr.company_id)) return;

    // Only requester or super_admin can cancel
    const roles = getEffectiveRoles(req.user);
    if (pr.created_by !== req.user.id && !roles.includes('super_admin'))
      return res.status(403).json({ success: false, error: 'cancel_denied',
        message: 'Only the requester or super_admin can cancel this payment request.' });

    const CANCELLABLE = ['draft','pending_approval','approved','scheduled'];
    if (!CANCELLABLE.includes(pr.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Cannot cancel request with status: ${pr.status}` });

    await query(`
      UPDATE treasury_payment_requests
      SET status='cancelled', cancellation_reason=$1, updated_at=NOW()
      WHERE id=$2
    `, [reason, prId]);

    writeAudit({
      userId: req.user.id, action: 'payment_request_cancelled',
      entityType: 'treasury_payment_requests', entityId: String(prId),
      companyId: pr.company_id,
      oldValues: { status: pr.status },
      newValues: { status: 'cancelled', reason },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Payment request cancelled.' });
  } catch (error) { next(error); }
});

module.exports = router;
