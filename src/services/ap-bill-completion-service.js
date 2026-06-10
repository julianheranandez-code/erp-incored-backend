'use strict';

const { onAPBillApproved, onAPBillCancelled } = require('./financial-event-service');

/**
 * PROJECT COST MODEL — Sprint 3D.1 Official Definition
 * =====================================================
 *
 * COMMITTED COST (not yet actual):
 *   = SUM(internal_purchase_orders.committed_amount)
 *     WHERE status IN ('approved','partially_consumed','fully_consumed')
 *   → Increases: when Internal PO is APPROVED
 *   → Decreases: when Internal PO is CANCELLED
 *
 * ACTUAL COST (projects.spent_amount):
 *   = SUM(ap_bills.total_amount WHERE status='approved')
 *   + SUM(expenses.amount WHERE status='payment_request_created' OR status='reimbursed')
 *   → Increases: when AP Bill is APPROVED
 *   → Increases: when Expense is APPROVED (payment_request_created)
 *   → Does NOT include: draft/pending bills or expenses
 *   → Does NOT include: Internal PO commitments
 *   Updated via: refresh_project_financials() materialized view
 *
 * AVAILABLE BUDGET:
 *   = budget_cost - committed_cost
 *   → Validated at: Internal PO approval time
 *
 * CONTRACT VALUE: projects.contract_value
 *   = Revenue expected from client
 *
 * EXPECTED MARGIN:
 *   = contract_value - budget_cost
 *
 * ACTUAL MARGIN:
 *   = contract_value - spent_amount
 */

/**
 * AP Bill Completion Service v2 — Sprint 3D
 * ==========================================
 * Sprint 3D additions:
 *   - Auto-creates Treasury Payment Request on approval
 *   - Updates project spent_amount via queueRefresh
 *   - Maintains atomic completion (Sprint 3C.2)
 *   - FOR UPDATE lock on PO (race condition protection)
 */

const { query } = require('../config/database');
const { writeAudit } = require('../middleware/audit');
const { queueRefresh } = require('./financeRefresh');
const logger = require('../utils/logger');

async function handleAPBillApprovalCompleted(approvalRequestId, approvedByUserId, req = {}, client = null) {
  const dbQuery = client
    ? (sql, params) => client.query(sql, params)
    : query;

  const billResult = await dbQuery(
    `SELECT * FROM ap_bills WHERE approval_request_id = $1`,
    [approvalRequestId]
  );

  if (!billResult.rows[0]) {
    logger.info(`[APBILL-SVC] No bill found for approval_request_id=${approvalRequestId}`);
    return null;
  }

  const bill = billResult.rows[0];

  // Update AP Bill to approved
  await dbQuery(`
    UPDATE ap_bills SET
      status = 'approved',
      approved_by = $1,
      approved_at = NOW(),
      approval_status = 'approved',
      updated_at = NOW()
    WHERE id = $2
  `, [approvedByUserId, bill.id]);

  // Consume PO balance with row lock (race condition protection)
  let poUpdate = null;
  if (bill.internal_po_id) {
    const poLock = await dbQuery(
      `SELECT id, status, remaining_amount FROM internal_purchase_orders
       WHERE id = $1 FOR UPDATE`,
      [bill.internal_po_id]
    );

    if (!poLock.rows[0])
      throw new Error(`Internal PO ${bill.internal_po_id} not found during AP Bill approval`);

    const po = poLock.rows[0];
    const billAmount = parseFloat(bill.total_amount);
    const remaining  = parseFloat(po.remaining_amount);

    if (remaining < billAmount) {
      throw new Error(
        `Insufficient PO balance. Required: ${billAmount}, Available: ${remaining}. ` +
        `Another bill may have consumed this balance concurrently.`
      );
    }

    const newRemaining = remaining - billAmount;
    const newPoStatus  = newRemaining <= 0 ? 'fully_consumed' : 'partially_consumed';

    await dbQuery(`
      UPDATE internal_purchase_orders SET
        remaining_amount = $1, status = $2, updated_at = NOW()
      WHERE id = $3
    `, [newRemaining, newPoStatus, bill.internal_po_id]);

    poUpdate = { po_id: bill.internal_po_id, new_remaining: newRemaining,
                 consumed: billAmount, po_status: newPoStatus };
    logger.info(`[APBILL-SVC] PO ${bill.internal_po_id}: ${remaining} → ${newRemaining} (${newPoStatus})`);
  }

  // FIX 2: Auto-create AND auto-submit Treasury Payment Request
  // Approved AP Bills must never leave a Payment Request sitting in draft
  // Option B: create + immediately trigger approval workflow via existing engine
  const { getApprovalChain, resolveApprovers, getCompanyApprovalPolicy } = require('../lib/approval-engine');

  const approvalPolicy = await (client
    ? client.query('SELECT approval_policy FROM companies WHERE id=$1', [bill.company_id]).then(r => r.rows[0]?.approval_policy || 'MEXICO_V1')
    : query('SELECT approval_policy FROM companies WHERE id=$1', [bill.company_id]).then(r => r.rows[0]?.approval_policy || 'MEXICO_V1')
  );

  // Create Payment Request in pending_approval status directly
  const pr = await dbQuery(`
    INSERT INTO treasury_payment_requests (
      company_id, source_document_type, source_document_id,
      amount, currency, payment_priority, notes, status, created_by
    ) VALUES ($1,'AP_BILL',$2,$3,$4,'normal',$5,'draft',$6)
    RETURNING id
  `, [bill.company_id, String(bill.id), bill.total_amount,
      bill.currency || 'MXN',
      `Auto-created for AP Bill #${bill.id}${bill.folio ? ' (' + bill.folio + ')' : ''}`,
      approvedByUserId]);

  const prId = pr.rows[0].id;

  // FIX 2: Mandatory atomic PR submission — no silent recovery
  // If ANY step fails → throws → entire approval transaction rolls back
  // AP Bill remains unapproved — no partial state possible
  const chain = getApprovalChain('OPERATING_EXPENSE', bill.total_amount, approvalPolicy);

  const { resolved, missing } = await resolveApprovers(bill.company_id, chain);
  if (missing.length > 0)
    throw new Error(
      `Treasury workflow cannot start: no approver assigned for roles: ${missing.join(', ')}. ` +
      `Configure approval_role_assignments for company ${bill.company_id}.`
    );

  if (!resolved.length)
    throw new Error('Approval chain returned empty — cannot create Treasury workflow.');

  const prApproval = await dbQuery(`
    INSERT INTO treasury_approval_requests
      (company_id, approval_type, entity_type, entity_id, amount, currency,
       status, requested_by, current_level, final_level, notes)
    VALUES ($1,'OPERATING_EXPENSE','PAYMENT_REQUEST',$2,$3,$4,'pending',$5,1,$6,$7)
    RETURNING id
  `, [bill.company_id, String(prId), bill.total_amount, bill.currency || 'MXN',
      approvedByUserId, resolved.length,
      `Treasury PR for AP Bill #${bill.id}`]);

  const prApprovalId = prApproval.rows[0].id;

  for (const step of resolved) {
    await dbQuery(`
      INSERT INTO treasury_approval_steps
        (request_id, level_number, approver_role, approver_user_id, status)
      VALUES ($1,$2,$3,$4,'pending')
    `, [prApprovalId, step.level, step.role, step.user_id]);
  }

  await dbQuery(`
    UPDATE treasury_payment_requests SET
      status='pending_approval', approval_request_id=$1, updated_at=NOW()
    WHERE id=$2
  `, [prApprovalId, prId]);

  logger.info(`[APBILL-SVC] PR ${prId} → pending_approval, approval_request=${prApprovalId}, steps=${resolved.length}`);

  // Link payment request to bill
  await dbQuery(`
    UPDATE ap_bills SET treasury_payment_request_id = $1 WHERE id = $2
  `, [prId, bill.id]);

  logger.info(`[APBILL-SVC] Bill ${bill.id} approved → payment request ${prId} created`);

  // Sprint 5.2B.1: Emit OPERATING_EXPENSE + LIABILITY financial events
  try {
    await onAPBillApproved(bill, approvedByUserId, client);
  } catch(evtErr) {
    logger.error(`[APBILL-SVC] Financial event emission failed: ${evtErr.message}`);
    throw evtErr; // Rollback — event and approval must be atomic
  }

  // Update project spent_amount (async — non-critical)
  if (bill.project_id) {
    setImmediate(() => queueRefresh(bill.project_id, 'ap_bill.approved').catch(() => {}));
  }

  writeAudit({
    userId: approvedByUserId,
    action: 'ap_bill_auto_approved_payment_request_created',
    entityType: 'ap_bills', entityId: String(bill.id),
    companyId: bill.company_id,
    newValues: { status: 'approved', treasury_payment_request_id: prId, po_update: poUpdate },
    ip: req.ip, userAgent: req.get ? req.get('user-agent') : null
  }).catch(() => {});

  return { bill_id: bill.id, status: 'approved',
           treasury_payment_request_id: prId, po_update: poUpdate };
}

module.exports = { handleAPBillApprovalCompleted };
