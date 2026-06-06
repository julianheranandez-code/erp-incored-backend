'use strict';

/**
 * Internal PO Completion Service — Sprint 3C.2 hardening
 * ========================================================
 * Accepts client for transactional atomicity.
 */

const { query } = require('../config/database');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

async function handleInternalPOApprovalCompleted(approvalRequestId, approvedByUserId, req = {}, client = null) {
  const dbQuery = client
    ? (sql, params) => client.query(sql, params)
    : query;

  const poResult = await dbQuery(
    `SELECT * FROM internal_purchase_orders WHERE approval_request_id = $1`,
    [approvalRequestId]
  );

  if (!poResult.rows[0]) {
    logger.info(`[IPO-SVC] No PO found for approval_request_id=${approvalRequestId}`);
    return null;
  }

  const po = poResult.rows[0];

  if (po.status !== 'pending_approval') {
    logger.warn(`[IPO-SVC] PO ${po.id} status is ${po.status} — skipping`);
    return null;
  }

  await dbQuery(`
    UPDATE internal_purchase_orders SET
      status = 'approved',
      approved_at = NOW(),
      approved_by = $1,
      committed_amount = total_amount,
      remaining_amount = total_amount,
      updated_at = NOW()
    WHERE id = $2
  `, [approvedByUserId, po.id]);

  logger.info(`[IPO-SVC] PO ${po.id} approved — committed=${po.total_amount}`);

  writeAudit({
    userId: approvedByUserId,
    action: 'internal_po_auto_approved',
    entityType: 'internal_purchase_orders', entityId: String(po.id),
    companyId: po.company_id,
    newValues: { status: 'approved', committed_amount: po.total_amount },
    ip: req.ip, userAgent: req.get ? req.get('user-agent') : null
  }).catch(() => {});

  return { po_id: po.id, status: 'approved', committed_amount: po.total_amount };
}

module.exports = { handleInternalPOApprovalCompleted };
