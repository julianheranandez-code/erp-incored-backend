'use strict';

const { onExpenseApproved } = require('./financial-event-service');

/**
 * Expense Completion Service — Sprint 3C.2 hardening
 * ====================================================
 * NOW ACCEPTS client parameter for transactional atomicity.
 * Runs inside the same DB transaction as approval completion.
 * If this fails → entire approval transaction rolls back.
 */

const { query, withTransaction } = require('../config/database');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

async function handleExpenseApprovalCompleted(approvalRequestId, approvedByUserId, req = {}, client = null) {
  // Use provided client (transactional) or fallback to standalone query
  const dbQuery = client
    ? (sql, params) => client.query(sql, params)
    : query;

  const expenseResult = await dbQuery(
    `SELECT * FROM expenses WHERE approval_request_id = $1`,
    [approvalRequestId]
  );

  if (!expenseResult.rows[0]) {
    logger.info(`[EXPENSE-SVC] No expense found for approval_request_id=${approvalRequestId}`);
    return null;
  }

  const exp = expenseResult.rows[0];

  if (exp.status !== 'pending_approval') {
    logger.warn(`[EXPENSE-SVC] Expense ${exp.id} status is ${exp.status} — skipping`);
    return null;
  }

  // CORPORATE_CARD: approve only
  if (exp.expense_type === 'CORPORATE_CARD') {
    await dbQuery(
      `UPDATE expenses SET status='approved', updated_at=NOW() WHERE id=$1`,
      [exp.id]
    );
    logger.info(`[EXPENSE-SVC] Corporate card expense ${exp.id} approved`);
    // Sprint 5.2B.2: Emit OPERATING_EXPENSE event (atomic)
    try {
      await onExpenseApproved(exp, approvedByUserId, client);
    } catch(evtErr) {
      logger.error(`[EXPENSE-SVC] Financial event emission failed: ${evtErr.message}`);
      throw evtErr;
    }
    return { expense_id: exp.id, status: 'approved', payment_request_created: false };
  }

  // REIMBURSEMENT + CASH_ADVANCE: create Treasury Payment Request
  const pr = await dbQuery(`
    INSERT INTO treasury_payment_requests (
      company_id, source_document_type, source_document_id,
      amount, currency, payment_priority, notes, status, created_by
    ) VALUES ($1,'EXPENSE',$2,$3,$4,$5,$6,'draft',$7)
    RETURNING id
  `, [exp.company_id, String(exp.id), exp.amount, exp.currency || 'MXN',
      exp.priority || 'MEDIUM',
      `Auto-created for expense #${exp.id}: ${exp.description}`,
      approvedByUserId]);

  const prId = pr.rows[0].id;

  await dbQuery(`
    UPDATE expenses SET
      status = 'payment_request_created',
      treasury_payment_request_id = $1,
      updated_at = NOW()
    WHERE id = $2
  `, [prId, exp.id]);

  logger.info(`[EXPENSE-SVC] Expense ${exp.id} → payment request ${prId} created`);

  writeAudit({
    userId: approvedByUserId,
    action: 'expense_auto_approved_payment_request_created',
    entityType: 'expenses', entityId: String(exp.id),
    companyId: exp.company_id,
    newValues: { status: 'payment_request_created', treasury_payment_request_id: prId },
    ip: req.ip, userAgent: req.get ? req.get('user-agent') : null
  }).catch(() => {});

  return { expense_id: exp.id, status: 'payment_request_created',
           treasury_payment_request_id: prId, payment_request_created: true };
}

module.exports = { handleExpenseApprovalCompleted };
