'use strict';

/**
 * AR Invoice Completion Service — Sprint 4B
 * ==========================================
 * Event-driven — called when treasury_approval_request
 * with entity_type='AR_INVOICE' reaches final approval.
 */

const { query } = require('../config/database');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

async function handleARInvoiceApprovalCompleted(approvalRequestId, approvedByUserId, req = {}, client = null) {
  const dbQuery = client ? (sql, p) => client.query(sql, p) : query;

  const invoiceResult = await dbQuery(
    `SELECT * FROM ar_invoices WHERE approval_request_id=$1`, [approvalRequestId]
  );

  if (!invoiceResult.rows[0]) {
    logger.info(`[AR-SVC] No invoice for approval_request_id=${approvalRequestId}`);
    return null;
  }

  const invoice = invoiceResult.rows[0];
  if (invoice.status !== 'pending_approval') {
    logger.warn(`[AR-SVC] Invoice ${invoice.id} status=${invoice.status} — skipping`);
    return null;
  }

  await dbQuery(`
    UPDATE ar_invoices SET
      status='approved', approved_by=$1, approved_at=NOW(),
      approval_status='approved', updated_at=NOW()
    WHERE id=$2
  `, [approvedByUserId, invoice.id]);

  // FIX 6: Consume Customer PO balance atomically on approval
  // PO controls billing authorization — reduced when invoice is approved, not when paid
  if (invoice.client_po_id) {
    const poCheck = await dbQuery(
      `SELECT remaining_amount FROM client_purchase_orders WHERE id=$1 FOR UPDATE`,
      [invoice.client_po_id]
    );
    if (poCheck.rows[0]) {
      const remaining = parseFloat(poCheck.rows[0].remaining_amount);
      const invoiceAmount = parseFloat(invoice.total_amount);
      if (remaining < invoiceAmount) {
        throw new Error(
          `Customer PO balance insufficient. Required: ${invoiceAmount}, Available: ${remaining}. ` +
          `Another invoice may have consumed this balance.`
        );
      }
      await dbQuery(`
        UPDATE client_purchase_orders SET
          remaining_amount = remaining_amount - $1,
          invoiced_amount = COALESCE(invoiced_amount, 0) + $1,
          updated_at = NOW()
        WHERE id = $2
      `, [invoiceAmount, invoice.client_po_id]);
    }
  }

  logger.info(`[AR-SVC] Invoice ${invoice.id} approved — folio=${invoice.folio}`);

  writeAudit({
    userId: approvedByUserId, action: 'ar_invoice_auto_approved',
    entityType: 'ar_invoices', entityId: String(invoice.id),
    companyId: invoice.company_id,
    newValues: { status: 'approved', folio: invoice.folio },
    ip: req.ip, userAgent: req.get ? req.get('user-agent') : null
  }).catch(() => {});

  return { invoice_id: invoice.id, status: 'approved', folio: invoice.folio };
}

module.exports = { handleARInvoiceApprovalCompleted };
