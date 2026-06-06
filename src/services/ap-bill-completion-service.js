'use strict';

/**
 * AP Bill Completion Service — Sprint 3C.2 hardening
 * ====================================================
 * Accepts client for transactional atomicity.
 * Row-level lock (FOR UPDATE) prevents race conditions.
 */

const { query } = require('../config/database');
const { writeAudit } = require('../middleware/audit');
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
      updated_at = NOW()
    WHERE id = $2
  `, [approvedByUserId, bill.id]);

  // Consume PO balance with row lock (race condition protection)
  let poUpdate = null;
  if (bill.internal_po_id) {
    // Use FOR UPDATE — must be inside a transaction
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

    // Hard block — remaining can never go negative
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
        remaining_amount = $1,
        status = $2,
        updated_at = NOW()
      WHERE id = $3
    `, [newRemaining, newPoStatus, bill.internal_po_id]);

    poUpdate = { po_id: bill.internal_po_id, new_remaining: newRemaining,
                 consumed: billAmount, po_status: newPoStatus };
    logger.info(`[APBILL-SVC] PO ${bill.internal_po_id} balance: ${remaining} → ${newRemaining} (${newPoStatus})`);
  }

  writeAudit({
    userId: approvedByUserId,
    action: 'ap_bill_auto_approved',
    entityType: 'ap_bills', entityId: String(bill.id),
    companyId: bill.company_id,
    newValues: { status: 'approved', po_update: poUpdate },
    ip: req.ip, userAgent: req.get ? req.get('user-agent') : null
  }).catch(() => {});

  return { bill_id: bill.id, status: 'approved', po_update: poUpdate };
}

module.exports = { handleAPBillApprovalCompleted };
