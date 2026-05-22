'use strict';

/**
 * Shared Financial Infrastructure
 * Used by: AR payments, AP payments, future payroll, treasury transfers
 */

const { query } = require('../config/database');
const logger = require('../utils/logger');

// ─── PART 3: Payment Idempotency ─────────────────────────────

/**
 * Check for duplicate payment across AR or AP
 * @param {string} table - 'ar_payments' | 'ap_bill_payments'
 * @param {string} documentCol - 'invoice_id' | 'ap_bill_id'
 * @param {number} documentId
 * @param {string} reference
 * @param {number} amount
 * @param {string} date
 */
async function checkDuplicatePayment(table, documentCol, documentId, reference, amount, date) {
  if (!reference) return null;
  const amountCol = table === 'ar_payments' ? 'amount' : 'amount_paid';
  const result = await query(`
    SELECT id FROM ${table}
    WHERE ${documentCol} = $1
      AND payment_reference = $2
      AND ABS(${amountCol} - $3) < 0.01
      AND payment_date = $4
  `, [parseInt(documentId), reference, parseFloat(amount), date]);
  return result.rows[0] || null;
}

/**
 * Generate idempotency key for financial operations
 */
function generateIdempotencyKey(documentType, documentId, reference, amount, date) {
  const crypto = require('crypto');
  const payload = `${documentType}:${documentId}:${reference}:${amount}:${date}`;
  return crypto.createHash('sha256').update(payload).digest('hex').substring(0, 32);
}

/**
 * Validate financial operation params
 */
function validateFinancialOperation({ amount, paymentDate, status, allowedStatuses }) {
  const errors = [];

  if (parseFloat(amount) <= 0) {
    errors.push('Payment amount must be positive.');
  }

  if (paymentDate) {
    const daysDiff = (new Date(paymentDate) - new Date()) / (1000 * 60 * 60 * 24);
    if (daysDiff > 30) errors.push('Payment date cannot be more than 30 days in the future.');
  }

  if (status && allowedStatuses && !allowedStatuses.includes(status)) {
    errors.push(`Cannot apply payment to ${status} document.`);
  }

  return errors;
}

// ─── PART 4: Financial Period Helpers ────────────────────────

/**
 * Check if a date falls within a closed period
 */
async function isPeriodClosed(companyId, date) {
  const result = await query(`
    SELECT id, period_name, closed_by FROM financial_periods
    WHERE company_id = $1
      AND start_date <= $2::date
      AND end_date >= $2::date
      AND is_closed = TRUE
    LIMIT 1
  `, [parseInt(companyId), date]);
  return result.rows[0] || null;
}

/**
 * Assert period is open — throws if closed
 */
async function assertPeriodOpen(companyId, date, isSuperAdmin = false) {
  if (isSuperAdmin) return; // Super admin can override
  const closed = await isPeriodClosed(companyId, date);
  if (closed) {
    const err = new Error(`Financial period "${closed.period_name}" is closed. No modifications allowed.`);
    err.code = 'PERIOD_CLOSED';
    err.period = closed;
    throw err;
  }
}

// ─── PART 5: Treasury Sync ────────────────────────────────────

const TREASURY_EVENT_TYPES = [
  'payment_applied',
  'payment_reversed',
  'scheduled_payment',
  'retainage_release',
  'revision_created'
];

/**
 * Unified treasury forecast sync — AR and AP use same pattern
 */
async function syncTreasuryForecast(documentType, documentId, eventType, companyId) {
  if (!TREASURY_EVENT_TYPES.includes(eventType)) {
    logger.warn(`[TREASURY] Unknown event type: ${eventType}`);
    return;
  }
  try {
    logger.info(`[TREASURY] sync ${documentType}=${documentId} event=${eventType} company=${companyId}`);
    // Future: INSERT INTO treasury_forecast_events(...)
  } catch (err) {
    logger.error(`[TREASURY] sync failed ${documentType}=${documentId}: ${err.message}`);
  }
}

// Convenience wrappers
const syncArTreasuryForecast  = (invoiceId, event, companyId) => syncTreasuryForecast('ar_invoice', invoiceId, event, companyId);
const syncApTreasuryForecast  = (billId, event, companyId)    => syncTreasuryForecast('ap_bill', billId, event, companyId);

// ─── PART 2: Generic bank transaction matching ────────────────

const VALID_DOCUMENT_TYPES = ['ar_invoice','ap_bill','payroll','journal_entry','treasury_transfer','tax_payment'];

async function matchBankTransaction(txnId, documentId, documentType) {
  if (!VALID_DOCUMENT_TYPES.includes(documentType)) {
    throw new Error(`Invalid document_type: ${documentType}. Valid: ${VALID_DOCUMENT_TYPES.join(', ')}`);
  }
  await query(`
    UPDATE bank_transactions SET
      match_status          = 'matched',
      applied_document_id   = $1,
      applied_document_type = $2,
      applied_invoice_id    = CASE WHEN $2 IN ('ar_invoice','ap_bill') THEN $1 ELSE applied_invoice_id END
    WHERE id = $3
  `, [parseInt(documentId), documentType, parseInt(txnId)]);
  logger.info(`[TREASURY] txn=${txnId} matched to ${documentType}=${documentId}`);
}

// ─── PART 6: Standardized Audit Payload ──────────────────────

/**
 * Build consistent audit payload for AR/AP/Treasury operations
 */
function buildAuditPayload({ userId, entityType, entityId, companyId, action, oldValues, newValues, ip, userAgent }) {
  return {
    userId,
    action: action || `${entityType}_updated`,
    entityType,
    entityId: parseInt(entityId),
    companyId: parseInt(companyId),
    oldValues: oldValues || null,
    newValues: newValues || null,
    ip: ip || null,
    userAgent: userAgent || null
  };
}

module.exports = {
  // Idempotency
  checkDuplicatePayment,
  generateIdempotencyKey,
  validateFinancialOperation,
  // Period management
  isPeriodClosed,
  assertPeriodOpen,
  // Treasury sync
  syncTreasuryForecast,
  syncArTreasuryForecast,
  syncApTreasuryForecast,
  matchBankTransaction,
  TREASURY_EVENT_TYPES,
  // Audit
  buildAuditPayload
};
