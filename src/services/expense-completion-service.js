'use strict';

/**
 * Expense Completion Service
 * ==========================
 * Called automatically when a treasury_approval_request
 * with entity_type='EXPENSE' reaches final approval.
 *
 * NO manual endpoint. Event-driven from approval engine.
 *
 * Flow:
 *   Approval completed → handleExpenseApprovalCompleted()
 *   → REIMBURSEMENT/CASH_ADVANCE: expense approved + payment request created
 *   → CORPORATE_CARD: expense approved only
 */

const { query, withTransaction } = require('../config/database');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

/**
 * Handle expense approval completion
 * @param {number} approvalRequestId
 * @param {string} approvedByUserId
 * @param {object} req - for audit (ip, userAgent)
 */
async function handleExpenseApprovalCompleted(approvalRequestId, approvedByUserId, req = {}) {
  try {
    // Fetch the expense linked to this approval request
    const expenseResult = await query(`
      SELECT * FROM expenses WHERE approval_request_id = $1
    `, [approvalRequestId]);

    if (!expenseResult.rows[0]) {
      logger.info(`[EXPENSE-SVC] No expense found for approval_request_id=${approvalRequestId} — skipping`);
      return null;
    }

    const exp = expenseResult.rows[0];

    if (exp.status !== 'pending_approval') {
      logger.warn(`[EXPENSE-SVC] Expense ${exp.id} status is ${exp.status} — skipping auto-complete`);
      return null;
    }

    // CORPORATE_CARD: approve only, no payment request
    if (exp.expense_type === 'CORPORATE_CARD') {
      await query(`
        UPDATE expenses SET status='approved', updated_at=NOW() WHERE id=$1
      `, [exp.id]);

      logger.info(`[EXPENSE-SVC] Corporate card expense ${exp.id} approved — no payment request`);

      writeAudit({
        userId: approvedByUserId,
        action: 'expense_auto_approved_corporate_card',
        entityType: 'expenses', entityId: String(exp.id),
        companyId: exp.company_id,
        newValues: { status: 'approved', expense_type: 'CORPORATE_CARD' },
        ip: req.ip, userAgent: req.get ? req.get('user-agent') : null
      }).catch(() => {});

      return { expense_id: exp.id, status: 'approved', payment_request_created: false };
    }

    // REIMBURSEMENT + CASH_ADVANCE: create Treasury Payment Request
    const result = await withTransaction(async (client) => {
      const pr = await client.query(`
        INSERT INTO treasury_payment_requests (
          company_id, source_document_type, source_document_id,
          amount, currency, payment_priority, notes, status, created_by
        ) VALUES ($1,'EXPENSE',$2,$3,$4,$5,$6,'draft',$7)
        RETURNING id
      `, [exp.company_id, String(exp.id), exp.amount,
          exp.currency || 'MXN', exp.priority || 'MEDIUM',
          `Auto-created for expense #${exp.id}: ${exp.description}`,
          approvedByUserId]);

      const prId = pr.rows[0].id;

      await client.query(`
        UPDATE expenses SET
          status = 'payment_request_created',
          treasury_payment_request_id = $1,
          updated_at = NOW()
        WHERE id = $2
      `, [prId, exp.id]);

      return prId;
    });

    logger.info(`[EXPENSE-SVC] Expense ${exp.id} approved → payment request ${result} created`);

    writeAudit({
      userId: approvedByUserId,
      action: 'expense_auto_approved_payment_request_created',
      entityType: 'expenses', entityId: String(exp.id),
      companyId: exp.company_id,
      newValues: {
        status: 'payment_request_created',
        treasury_payment_request_id: result,
        expense_type: exp.expense_type
      },
      ip: req.ip, userAgent: req.get ? req.get('user-agent') : null
    }).catch(() => {});

    return { expense_id: exp.id, status: 'payment_request_created',
             treasury_payment_request_id: result, payment_request_created: true };

  } catch (err) {
    logger.error(`[EXPENSE-SVC] Error completing expense for approval ${approvalRequestId}: ${err.message}`);
    throw err;
  }
}

module.exports = { handleExpenseApprovalCompleted };
