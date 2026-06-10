'use strict';

/**
 * Treasury Sprint 1D v2 — Approval Workflow & Governance
 * ======================================================
 * Decision 1: New roles supervisor + accounting_manager
 * Decision 2: Option B — specific user assigned per step
 * Decision 3: Auto-assign approvers at request creation
 *
 * Endpoints:
 *   POST   /api/treasury/approvals
 *   GET    /api/treasury/approvals
 *   GET    /api/treasury/approvals/:id
 *   POST   /api/treasury/approvals/:id/approve
 *   POST   /api/treasury/approvals/:id/reject
 *   POST   /api/treasury/approvals/:id/cancel
 *   GET    /api/treasury/approvals/routing-preview
 */

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { getEffectivePermissions } = require('../lib/iam/effective-permissions');
const { getApprovalChain, resolveApprovers, getCompanyApprovalPolicy, VALID_APPROVAL_TYPES } = require('../lib/approval-engine');
const { handleExpenseApprovalCompleted } = require('../services/expense-completion-service');
const { handleInternalPOApprovalCompleted } = require('../services/ipo-completion-service');
const { handleAPBillApprovalCompleted } = require('../services/ap-bill-completion-service');
const { handleARInvoiceApprovalCompleted } = require('../services/ar-completion-service');
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
  const userCompanyId = parseInt(req.user.active_company_id || req.user.company_id);
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

// ─── APPROVAL ENGINE: imported from src/lib/approval-engine.js


// ─── ENDPOINTS ────────────────────────────────────────────────

// GET /api/treasury/approvals/routing-preview
// Preview approval chain before submitting
router.get('/approvals/routing-preview', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const { company_id, approval_type, amount } = req.query;

    if (!company_id || !approval_type || !amount)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, approval_type, amount' });

    const approvalPolicy = await getCompanyApprovalPolicy(parseInt(company_id));
    const chain = getApprovalChain(approval_type, amount, approvalPolicy);
    const { resolved, missing } = await resolveApprovers(parseInt(company_id), chain);

    res.json({
      success: true,
      data: {
        approval_type, amount: parseFloat(amount),
        total_levels: chain.length,
        chain: resolved,
        missing_assignments: missing,
        can_proceed: missing.length === 0
      }
    });
  } catch (error) { next(error); }
});

// POST /api/treasury/approvals
router.post('/approvals', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const { company_id, approval_type, entity_type, entity_id,
            amount, currency = 'USD', notes } = req.body;

    if (!company_id || !approval_type || !amount)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, approval_type, amount' });

    if (!await assertCompanyAccess(req, res, company_id)) return;
    if (!VALID_APPROVAL_TYPES.includes(approval_type))
      return res.status(400).json({ success: false, error: 'invalid_approval_type' });

    // Get approval chain
    // Fetch company approval policy — routing is policy-based
    const approvalPolicy = await getCompanyApprovalPolicy(parseInt(company_id));
    const chain = getApprovalChain(approval_type, amount, approvalPolicy);

    // Resolve specific users — Decision 2+3
    const { resolved, missing } = await resolveApprovers(parseInt(company_id), chain);

    if (missing.length > 0)
      return res.status(400).json({ success: false, error: 'missing_approver_assignments',
        message: `No approver assigned for roles: ${missing.join(', ')}. Configure approval_role_assignments first.`,
        missing_roles: missing
      });

    const finalLevel = resolved.length;

    const result = await withTransaction(async (client) => {
      const request = await client.query(`
        INSERT INTO treasury_approval_requests
          (company_id, approval_type, entity_type, entity_id, amount, currency,
           status, requested_by, current_level, final_level, notes)
        VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,1,$8,$9)
        RETURNING *
      `, [parseInt(company_id), approval_type, entity_type||null, entity_id||null,
          parseFloat(amount), currency, req.user.id, finalLevel, notes||null]);

      const requestId = request.rows[0].id;

      // Create steps with specific user assignments — Decision 2
      for (const step of resolved) {
        await client.query(`
          INSERT INTO treasury_approval_steps
            (request_id, level_number, approver_role, approver_user_id, status)
          VALUES ($1,$2,$3,$4,'pending')
        `, [requestId, step.level, step.role, step.user_id]);
      }

      return request.rows[0];
    });

    writeAudit({
      userId: req.user.id, action: 'approval_request_created',
      entityType: 'treasury_approval_requests', entityId: String(result.id),
      companyId: parseInt(company_id),
      newValues: {
        approval_type, amount, currency,
        chain: resolved.map(s => ({ level: s.level, role: s.role, user: s.email }))
      },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    const steps = await query(
      `SELECT s.*, CONCAT(u.first_name,' ',u.last_name) AS approver_name, u.email
       FROM treasury_approval_steps s
       LEFT JOIN users u ON u.id = s.approver_user_id
       WHERE s.request_id=$1 ORDER BY s.level_number`,
      [result.id]
    );

    logger.info(`[APPROVALS] request created: id=${result.id} type=${approval_type} amount=${amount} levels=${finalLevel}`);
    res.status(201).json({ success: true, message: 'Approval request created.',
      data: { ...result, steps: steps.rows } });
  } catch (error) { next(error); }
});

// GET /api/treasury/approvals
router.get('/approvals', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (companyId) { conditions.push(`r.company_id=$${idx++}`); values.push(companyId); }
    if (req.query.status) { conditions.push(`r.status=$${idx++}`); values.push(req.query.status); }
    if (req.query.approval_type) { conditions.push(`r.approval_type=$${idx++}`); values.push(req.query.approval_type); }

    // Non-admin: only see own requests OR requests assigned to them
    const roles = getEffectiveRoles(req.user);
    if (!roles.includes('super_admin') && !roles.includes('admin')) {
      conditions.push(`(r.requested_by=$${idx} OR EXISTS (
        SELECT 1 FROM treasury_approval_steps s
        WHERE s.request_id=r.id AND s.approver_user_id=$${idx} AND s.status='pending'
      ))`);
      values.push(req.user.id); idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT r.*,
        CONCAT(u.first_name,' ',u.last_name) AS requested_by_name,
        c.name AS company_name,
        -- Sprint 4C.4A: document metadata (single CASE join — no N+1)
        COALESCE(
          CASE r.entity_type
            WHEN 'EXPENSE'      THEN e.expense_number
            WHEN 'INTERNAL_PO'  THEN ipo.po_number
            WHEN 'AP_BILL'      THEN COALESCE(ab.folio, ab.vendor_invoice_no)
            WHEN 'AR_INVOICE'   THEN ai.folio
          END
        ) AS document_number,
        COALESCE(
          CASE r.entity_type
            WHEN 'EXPENSE'     THEN ep.id
            WHEN 'INTERNAL_PO' THEN ipop.id
            WHEN 'AP_BILL'     THEN abp.id
            WHEN 'AR_INVOICE'  THEN aip.id
          END
        ) AS project_id,
        COALESCE(
          CASE r.entity_type
            WHEN 'EXPENSE'     THEN ep.name
            WHEN 'INTERNAL_PO' THEN ipop.name
            WHEN 'AP_BILL'     THEN abp.name
            WHEN 'AR_INVOICE'  THEN aip.name
          END
        ) AS project_name,
        COALESCE(
          CASE r.entity_type
            WHEN 'INTERNAL_PO' THEN ipov.name
            WHEN 'AP_BILL'     THEN abv.name
          END
        ) AS vendor_name,
        COALESCE(
          CASE r.entity_type
            WHEN 'AR_INVOICE' THEN aic.name
          END
        ) AS client_name
      FROM treasury_approval_requests r
      JOIN companies c ON c.id = r.company_id
      LEFT JOIN users u ON u.id = r.requested_by
      -- Entity joins (LEFT — graceful if entity deleted)
      LEFT JOIN expenses e             ON r.entity_type='EXPENSE'      AND e.id = r.entity_id::integer
      LEFT JOIN projects ep            ON ep.id = e.project_id
      LEFT JOIN internal_purchase_orders ipo  ON r.entity_type='INTERNAL_PO' AND ipo.id = r.entity_id::integer
      LEFT JOIN projects ipop          ON ipop.id = ipo.project_id
      LEFT JOIN vendors ipov           ON ipov.id = ipo.vendor_master_id
      LEFT JOIN ap_bills ab            ON r.entity_type='AP_BILL'      AND ab.id = r.entity_id::integer
      LEFT JOIN projects abp           ON abp.id = ab.project_id
      LEFT JOIN vendors abv            ON abv.id = ab.vendor_master_id
      LEFT JOIN ar_invoices ai         ON r.entity_type='AR_INVOICE'   AND ai.id = r.entity_id::integer
      LEFT JOIN projects aip           ON aip.id = ai.project_id
      LEFT JOIN clients aic            ON aic.id = ai.client_id
      ${where}
      ORDER BY r.requested_at DESC LIMIT 100
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// GET /api/treasury/approvals/:id
router.get('/approvals/:id', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.view')) return;
  try {
    const requestId = parseInt(req.params.id);
    const companyId = getCompanyScope(req.user, req.query.company_id);

    const request = await query(`
      SELECT r.*,
        CONCAT(u.first_name,' ',u.last_name) AS requested_by_name,
        c.name AS company_name,
        COALESCE(
          CASE r.entity_type
            WHEN 'EXPENSE'      THEN e.expense_number
            WHEN 'INTERNAL_PO'  THEN ipo.po_number
            WHEN 'AP_BILL'      THEN COALESCE(ab.folio, ab.vendor_invoice_no)
            WHEN 'AR_INVOICE'   THEN ai.folio
          END
        ) AS document_number,
        COALESCE(
          CASE r.entity_type
            WHEN 'EXPENSE'     THEN ep.name
            WHEN 'INTERNAL_PO' THEN ipop.name
            WHEN 'AP_BILL'     THEN abp.name
            WHEN 'AR_INVOICE'  THEN aip.name
          END
        ) AS project_name,
        COALESCE(
          CASE r.entity_type
            WHEN 'INTERNAL_PO' THEN ipov.name
            WHEN 'AP_BILL'     THEN abv.name
          END
        ) AS vendor_name,
        COALESCE(
          CASE r.entity_type
            WHEN 'AR_INVOICE' THEN aic.name
          END
        ) AS client_name
      FROM treasury_approval_requests r
      JOIN companies c ON c.id = r.company_id
      LEFT JOIN users u ON u.id = r.requested_by
      LEFT JOIN expenses e             ON r.entity_type='EXPENSE'      AND e.id = r.entity_id::integer
      LEFT JOIN projects ep            ON ep.id = e.project_id
      LEFT JOIN internal_purchase_orders ipo  ON r.entity_type='INTERNAL_PO' AND ipo.id = r.entity_id::integer
      LEFT JOIN projects ipop          ON ipop.id = ipo.project_id
      LEFT JOIN vendors ipov           ON ipov.id = ipo.vendor_master_id
      LEFT JOIN ap_bills ab            ON r.entity_type='AP_BILL'      AND ab.id = r.entity_id::integer
      LEFT JOIN projects abp           ON abp.id = ab.project_id
      LEFT JOIN vendors abv            ON abv.id = ab.vendor_master_id
      LEFT JOIN ar_invoices ai         ON r.entity_type='AR_INVOICE'   AND ai.id = r.entity_id::integer
      LEFT JOIN projects aip           ON aip.id = ai.project_id
      LEFT JOIN clients aic            ON aic.id = ai.client_id
      WHERE r.id=$1 ${companyId ? 'AND r.company_id=$2' : ''}
    `, companyId ? [requestId, companyId] : [requestId]);

    if (!request.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const steps = await query(`
      SELECT s.*, CONCAT(u.first_name,' ',u.last_name) AS approver_name, u.email
      FROM treasury_approval_steps s
      LEFT JOIN users u ON u.id = s.approver_user_id
      WHERE s.request_id=$1 ORDER BY s.level_number
    `, [requestId]);

    res.json({ success: true, data: { ...request.rows[0], steps: steps.rows } });
  } catch (error) { next(error); }
});

// POST /api/treasury/approvals/:id/approve
router.post('/approvals/:id/approve', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.approve')) return;
  try {
    const requestId = parseInt(req.params.id);
    const { comments } = req.body;

    const request = await query(
      `SELECT * FROM treasury_approval_requests WHERE id=$1`, [requestId]
    );
    if (!request.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const req_data = request.rows[0];
    if (!await assertCompanyAccess(req, res, req_data.company_id)) return;

    if (!['pending','in_review'].includes(req_data.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Cannot approve request with status: ${req_data.status}` });

    // Prevent self-approval
    if (req_data.requested_by === req.user.id)
      return res.status(403).json({ success: false, error: 'self_approval_denied',
        message: 'You cannot approve your own request.' });

    // Get current step
    const currentStep = await query(`
      SELECT s.*, CONCAT(u.first_name,' ',u.last_name) AS approver_name
      FROM treasury_approval_steps s
      LEFT JOIN users u ON u.id = s.approver_user_id
      WHERE s.request_id=$1 AND s.level_number=$2
    `, [requestId, req_data.current_level]);

    if (!currentStep.rows[0])
      return res.status(400).json({ success: false, error: 'step_not_found' });

    const step = currentStep.rows[0];

    // Decision 2: Only the assigned user can approve — no role-wide approval
    if (step.approver_user_id !== req.user.id) {
      const roles = getEffectiveRoles(req.user);
      if (!roles.includes('super_admin'))
        return res.status(403).json({ success: false, error: 'not_assigned_approver',
          message: `This step is assigned to ${step.approver_name}. Only they can approve.` });
    }

    const isLastLevel = req_data.current_level >= req_data.final_level;
    const newStatus = isLastLevel ? 'approved' : 'in_review';
    const nextLevel = isLastLevel ? req_data.current_level : req_data.current_level + 1;

    // Sprint 3C.2: Completion service runs INSIDE the transaction
    // Guarantees atomicity: approval + entity update are a single business transaction
    let entityCompletion = null;

    await withTransaction(async (client) => {
      // Step 1: Approve current step
      await client.query(`
        UPDATE treasury_approval_steps
        SET status='approved', approved_at=NOW(), comments=$1
        WHERE id=$2
      `, [comments||null, step.id]);

      // Step 2: Update approval request status
      await client.query(`
        UPDATE treasury_approval_requests
        SET status=$1, current_level=$2,
            ${isLastLevel ? 'approved_at=NOW(),' : ''}
            updated_at=NOW()
        WHERE id=$3
      `, [newStatus, nextLevel, requestId]);

      // Step 3: If final level — run completion service INSIDE same transaction
      // If completion fails → entire transaction rolls back → no partial state
      if (isLastLevel) {
        if (req_data.entity_type === 'EXPENSE') {
          entityCompletion = await handleExpenseApprovalCompleted(requestId, req.user.id, req, client);
        } else if (req_data.entity_type === 'INTERNAL_PO') {
          entityCompletion = await handleInternalPOApprovalCompleted(requestId, req.user.id, req, client);
        } else if (req_data.entity_type === 'AP_BILL') {
          entityCompletion = await handleAPBillApprovalCompleted(requestId, req.user.id, req, client);
          logger.info(`[APPROVALS] AP Bill auto-completed: id=${entityCompletion?.bill_id}`);
        } else if (req_data.entity_type === 'AR_INVOICE') {
          entityCompletion = await handleARInvoiceApprovalCompleted(requestId, req.user.id, req, client);
          logger.info(`[APPROVALS] AR Invoice auto-completed: id=${entityCompletion?.invoice_id} status=${entityCompletion?.status}`);
        }
        // Unknown entity_type with no handler: approval still commits (no entity to update)
      }
    });

    // Audit AFTER transaction commits — fire and forget (non-critical)
    writeAudit({
      userId: req.user.id,
      action: isLastLevel ? 'approval_workflow_completed' : 'approval_step_approved',
      entityType: 'treasury_approval_requests', entityId: String(requestId),
      companyId: req_data.company_id,
      newValues: { level: req_data.current_level, new_status: newStatus,
                   comments, entity_completion: entityCompletion },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    if (isLastLevel && entityCompletion) {
      logger.info(`[APPROVALS] workflow+entity committed atomically: type=${req_data.entity_type} approval=${requestId}`);
    }

    logger.info(`[APPROVALS] step approved: request=${requestId} level=${req_data.current_level} final=${isLastLevel}`);
    res.json({ success: true,
      message: isLastLevel ? 'Request fully approved.' : `Step ${req_data.current_level} approved. Advancing to level ${nextLevel}.`,
      data: { request_id: requestId, level_approved: req_data.current_level,
              new_status: newStatus, is_final: isLastLevel,
              entity_completion: entityCompletion || undefined }
    });
  } catch (error) { next(error); }
});

// POST /api/treasury/approvals/:id/reject
router.post('/approvals/:id/reject', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.approve')) return;
  try {
    const requestId = parseInt(req.params.id);
    const { comments } = req.body;

    if (!comments)
      return res.status(400).json({ success: false, error: 'comments_required',
        message: 'A reason is required when rejecting.' });

    const request = await query(
      `SELECT * FROM treasury_approval_requests WHERE id=$1`, [requestId]
    );
    if (!request.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const req_data = request.rows[0];
    if (!await assertCompanyAccess(req, res, req_data.company_id)) return;

    if (!['pending','in_review'].includes(req_data.status))
      return res.status(400).json({ success: false, error: 'invalid_status' });

    const currentStep = await query(`
      SELECT s.*, CONCAT(u.first_name,' ',u.last_name) AS approver_name
      FROM treasury_approval_steps s
      LEFT JOIN users u ON u.id = s.approver_user_id
      WHERE s.request_id=$1 AND s.level_number=$2
    `, [requestId, req_data.current_level]);

    if (!currentStep.rows[0])
      return res.status(400).json({ success: false, error: 'step_not_found' });

    const step = currentStep.rows[0];

    // Decision 2: Only assigned user can reject
    if (step.approver_user_id !== req.user.id) {
      const roles = getEffectiveRoles(req.user);
      if (!roles.includes('super_admin'))
        return res.status(403).json({ success: false, error: 'not_assigned_approver',
          message: `This step is assigned to ${step.approver_name}. Only they can reject.` });
    }

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE treasury_approval_steps
        SET status='rejected', rejected_at=NOW(), comments=$1
        WHERE id=$2
      `, [comments, step.id]);

      await client.query(`
        UPDATE treasury_approval_requests
        SET status='rejected', rejected_at=NOW(), updated_at=NOW()
        WHERE id=$1
      `, [requestId]);
    });

    writeAudit({
      userId: req.user.id, action: 'approval_step_rejected',
      entityType: 'treasury_approval_requests', entityId: String(requestId),
      companyId: req_data.company_id,
      oldValues: { status: req_data.status },
      newValues: { level: req_data.current_level, comments },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Request rejected.',
      data: { request_id: requestId, rejected_at: new Date().toISOString() }
    });
  } catch (error) { next(error); }
});

// POST /api/treasury/approvals/:id/cancel
router.post('/approvals/:id/cancel', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.create')) return;
  try {
    const requestId = parseInt(req.params.id);
    const { comments } = req.body;

    const request = await query(
      `SELECT * FROM treasury_approval_requests WHERE id=$1`, [requestId]
    );
    if (!request.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const req_data = request.rows[0];
    if (!await assertCompanyAccess(req, res, req_data.company_id)) return;

    // Observation 3: Only requester or super_admin can cancel
    // Removed dependency on 'admin' ERP role — approval chain must be business-independent
    const roles = getEffectiveRoles(req.user);
    if (req_data.requested_by !== req.user.id && !roles.includes('super_admin'))
      return res.status(403).json({ success: false, error: 'cancel_denied',
        message: 'Only the requester or super_admin can cancel this request.' });

    if (['approved','rejected','cancelled'].includes(req_data.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Cannot cancel request with status: ${req_data.status}` });

    await query(`
      UPDATE treasury_approval_requests
      SET status='cancelled', updated_at=NOW(), notes=COALESCE($1, notes)
      WHERE id=$2
    `, [comments||null, requestId]);

    writeAudit({
      userId: req.user.id, action: 'approval_workflow_cancelled',
      entityType: 'treasury_approval_requests', entityId: String(requestId),
      companyId: req_data.company_id,
      newValues: { comments },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Request cancelled.' });
  } catch (error) { next(error); }
});


// ─── APPROVAL ASSIGNMENT CRUD ─────────────────────────────────

const VALID_APPROVAL_ROLES = ['supervisor','operations_manager','finance','procurement','accounting_manager','executive_approver'];

// GET /api/treasury/approval-assignments
router.get('/approval-assignments', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.admin')) return;
  try {
    const companyId = getCompanyScope(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (companyId) { conditions.push(`ara.company_id=$${idx++}`); values.push(companyId); }
    if (req.query.approval_role) { conditions.push(`ara.approval_role=$${idx++}`); values.push(req.query.approval_role); }
    if (req.query.is_active !== undefined) { conditions.push(`ara.is_active=$${idx++}`); values.push(req.query.is_active === 'true'); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT ara.*, c.name AS company_name,
        CONCAT(u.first_name,' ',u.last_name) AS user_name, u.email
      FROM approval_role_assignments ara
      JOIN companies c ON c.id = ara.company_id
      JOIN users u ON u.id = ara.user_id
      ${where}
      ORDER BY ara.company_id, ara.approval_role
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// GET /api/treasury/approval-assignments/validate
router.get('/approval-assignments/validate', async (req, res, next) => {
  if (!await assertTreasuryPermission(req, res, 'treasury.admin')) return;
  try {
    const companyId = req.query.company_id
      ? parseInt(req.query.company_id)
      : getCompanyScope(req.user, null);

    if (!companyId)
      return res.status(400).json({ success: false, error: 'company_id_required' });

    const result = await query(`
      SELECT approval_role FROM approval_role_assignments
      WHERE company_id=$1 AND is_active=TRUE
    `, [companyId]);

    const assignedRoles = new Set(result.rows.map(r => r.approval_role));
    const validation = {};
    for (const role of VALID_APPROVAL_ROLES) {
      validation[role] = assignedRoles.has(role);
    }
    const isValid = VALID_APPROVAL_ROLES.every(r => validation[r]);

    writeAudit({
      userId: req.user.id, action: 'assignment_validation',
      entityType: 'approval_role_assignments', entityId: String(companyId),
      companyId,
      newValues: { ...validation, valid: isValid },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, data: { ...validation, valid: isValid, company_id: companyId } });
  } catch (error) { next(error); }
});

// POST /api/treasury/approval-assignments
router.post('/approval-assignments', async (req, res, next) => {
  // Only super_admin can manage assignments
  const roles = getEffectiveRoles(req.user);
  if (!roles.includes('super_admin'))
    return res.status(403).json({ success: false, error: 'super_admin_required',
      message: 'Only super_admin can manage approval assignments.' });
  try {
    const { company_id, approval_role, user_id } = req.body;

    if (!company_id || !approval_role || !user_id)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, approval_role, user_id' });

    if (!VALID_APPROVAL_ROLES.includes(approval_role))
      return res.status(400).json({ success: false, error: 'invalid_approval_role',
        message: `approval_role must be: ${VALID_APPROVAL_ROLES.join(', ')}` });

    // Verify user exists and belongs to company (or has access via user_company_access)
    const userCheck = await query(
      `SELECT u.id, u.company_id, CONCAT(u.first_name,' ',u.last_name) AS name
       FROM users u
       WHERE u.id=$1`, [user_id]
    );
    if (!userCheck.rows[0])
      return res.status(400).json({ success: false, error: 'user_not_found' });

    // Item 3: Validate user belongs to the target company
    const user = userCheck.rows[0];
    const targetCompanyId = parseInt(company_id);
    if (user.company_id !== targetCompanyId) {
      // Check user_company_access as fallback
      const accessCheck = await query(
        `SELECT 1 FROM user_company_access WHERE user_id=$1 AND company_id=$2 AND is_active=TRUE`,
        [user_id, targetCompanyId]
      );
      if (!accessCheck.rows[0])
        return res.status(400).json({ success: false, error: 'cross_company_assignment',
          message: 'User does not belong to this company and has no company access.' });
    }

    const result = await query(`
      INSERT INTO approval_role_assignments (company_id, approval_role, user_id, is_active)
      VALUES ($1,$2,$3,TRUE) RETURNING *
    `, [parseInt(company_id), approval_role, user_id]);

    writeAudit({
      userId: req.user.id, action: 'assignment_created',
      entityType: 'approval_role_assignments', entityId: String(result.rows[0].id),
      companyId: parseInt(company_id),
      newValues: { approval_role, user_id, user_name: userCheck.rows[0].name },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Assignment created.', data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505')
      return res.status(400).json({ success: false, error: 'duplicate_active_assignment',
        message: 'An active assignment for this role already exists in this company. Deactivate it first.' });
    next(error);
  }
});

// PUT /api/treasury/approval-assignments/:id
router.put('/approval-assignments/:id', async (req, res, next) => {
  const roles = getEffectiveRoles(req.user);
  if (!roles.includes('super_admin'))
    return res.status(403).json({ success: false, error: 'super_admin_required' });
  try {
    const assignId = parseInt(req.params.id);
    const { user_id } = req.body;

    if (!user_id)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: user_id' });

    const existing = await query(
      `SELECT * FROM approval_role_assignments WHERE id=$1`, [assignId]
    );
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const userCheck = await query(
      `SELECT u.id, u.company_id, CONCAT(u.first_name,' ',u.last_name) AS name
       FROM users u WHERE u.id=$1`, [user_id]
    );
    if (!userCheck.rows[0])
      return res.status(400).json({ success: false, error: 'user_not_found' });

    // Item 1: Same cross-company validation as POST
    const targetCompanyId = existing.rows[0].company_id;
    if (userCheck.rows[0].company_id !== targetCompanyId) {
      const accessCheck = await query(
        `SELECT 1 FROM user_company_access WHERE user_id=$1 AND company_id=$2 AND is_active=TRUE`,
        [user_id, targetCompanyId]
      );
      if (!accessCheck.rows[0])
        return res.status(400).json({ success: false, error: 'cross_company_assignment',
          message: 'User does not belong to this company and has no company access.' });
    }

    const result = await query(
      `UPDATE approval_role_assignments SET user_id=$1 WHERE id=$2 RETURNING *`,
      [user_id, assignId]
    );

    writeAudit({
      userId: req.user.id, action: 'assignment_updated',
      entityType: 'approval_role_assignments', entityId: String(assignId),
      companyId: existing.rows[0].company_id,
      oldValues: { user_id: existing.rows[0].user_id },
      newValues: { user_id, user_name: userCheck.rows[0].name },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Assignment updated.', data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505')
      return res.status(400).json({ success: false, error: 'duplicate_active_assignment',
        message: 'An active assignment for this role already exists.' });
    next(error);
  }
});

// PATCH /api/treasury/approval-assignments/:id/status
router.patch('/approval-assignments/:id/status', async (req, res, next) => {
  const roles = getEffectiveRoles(req.user);
  if (!roles.includes('super_admin'))
    return res.status(403).json({ success: false, error: 'super_admin_required' });
  try {
    const assignId = parseInt(req.params.id);
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean')
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'is_active must be boolean.' });

    const existing = await query(
      `SELECT * FROM approval_role_assignments WHERE id=$1`, [assignId]
    );
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const result = await query(
      `UPDATE approval_role_assignments SET is_active=$1 WHERE id=$2 RETURNING *`,
      [is_active, assignId]
    );

    writeAudit({
      userId: req.user.id,
      action: is_active ? 'assignment_activated' : 'assignment_deactivated',
      entityType: 'approval_role_assignments', entityId: String(assignId),
      companyId: existing.rows[0].company_id,
      oldValues: { is_active: existing.rows[0].is_active },
      newValues: { is_active },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true,
      message: `Assignment ${is_active ? 'activated' : 'deactivated'}.`,
      data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505')
      return res.status(400).json({ success: false, error: 'duplicate_active_assignment',
        message: 'An active assignment for this role already exists. Deactivate it first.' });
    next(error);
  }
});

module.exports = router;
