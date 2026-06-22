'use strict';

/**
 * Financial Event Service — Sprint 5.2B.1
 * =========================================
 * Central emitter for all financial events.
 * ALL producers must use emitFinancialEvent() — never write directly.
 *
 * ARCHITECTURE:
 *   - Append-only (INSERT only — table trigger blocks UPDATE/DELETE)
 *   - Idempotency via idempotency_key (source_type + source_id + event_type + subtype)
 *   - Atomic with calling transaction when client param passed
 *   - amount_base + fiscal_period set by DB trigger automatically
 */

const { query } = require('../config/database');
const logger = require('../utils/logger');

// ─── CENTRAL EMITTER ─────────────────────────────────────────
/**
 * Emit a single financial event.
 * @param {object} event - Event payload
 * @param {object} [client] - DB transaction client (for atomicity)
 * @returns {object} Created event row
 */
async function emitFinancialEvent(event, client = null) {
  const dbQuery = client ? (sql, p) => client.query(sql, p) : query;

  const {
    company_id, project_id = null, event_type, event_subtype = null,
    event_category = null, event_date, amount, currency = 'MXN',
    exchange_rate = 1.0, source_type, source_id,
    reversal_of = null, counterparty_company_id = null,
    metadata = {}, external_reference = null, created_by
  } = event;

  // Validate required fields
  if (!company_id) throw new Error('[FinancialEventService] company_id required');
  if (!event_type) throw new Error('[FinancialEventService] event_type required');
  if (!event_date) throw new Error('[FinancialEventService] event_date required');
  if (amount === undefined || amount === null) throw new Error('[FinancialEventService] amount required');
  if (amount < 0) throw new Error('[FinancialEventService] amount must be >= 0');
  if (event_type === 'REVERSAL' && !reversal_of)
    throw new Error('[FinancialEventService] REVERSAL event requires reversal_of');

  // IDEMPOTENCY: prevent duplicate events for same business action
  // Key: source_type + source_id + event_type + event_subtype
  if (source_type && source_id) {
    const existing = await dbQuery(`
      SELECT event_id FROM financial_events
      WHERE source_type = $1 AND source_id = $2
        AND event_type = $3
        AND ($4::varchar IS NULL OR event_subtype = $4)
        AND status = 'active'
      LIMIT 1
    `, [source_type, parseInt(source_id), event_type, event_subtype || null]);

    if (existing.rows[0]) {
      logger.warn(`[FinancialEventService] Duplicate suppressed: ${event_type}/${event_subtype} for ${source_type}#${source_id}`);
      return { ...existing.rows[0], _duplicate: true };
    }
  }

  const result = await dbQuery(`
    INSERT INTO financial_events (
      company_id, project_id, event_type, event_subtype, event_category,
      event_date, amount, currency, exchange_rate,
      source_type, source_id, reversal_of,
      counterparty_company_id, metadata, external_reference, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING event_id, event_type, event_subtype, amount, fiscal_period,
              amount_base, status, created_at
  `, [
    parseInt(company_id),
    project_id ? parseInt(project_id) : null,
    event_type, event_subtype || null, event_category || null,
    event_date, parseFloat(amount), currency, parseFloat(exchange_rate),
    source_type || null, source_id ? parseInt(source_id) : null,
    reversal_of || null,
    counterparty_company_id ? parseInt(counterparty_company_id) : null,
    JSON.stringify(metadata),
    external_reference || null,
    created_by || null
  ]);

  const created = result.rows[0];
  logger.info(`[FinancialEventService] ${event_type}/${event_subtype || '-'} event_id=${created.event_id} amount=${amount} ${currency} source=${source_type}#${source_id}`);
  return created;
}

// ─── REVERSAL HELPER ─────────────────────────────────────────
/**
 * Find the active event_id for a source document + event_type.
 * Used to populate reversal_of.
 */
async function findEventId(source_type, source_id, event_type, event_subtype = null, client = null) {
  const dbQuery = client ? (sql, p) => client.query(sql, p) : query;
  const result = await dbQuery(`
    SELECT event_id FROM financial_events
    WHERE source_type=$1 AND source_id=$2
      AND event_type=$3
      AND ($4::varchar IS NULL OR event_subtype=$4)
      AND status='active'
    LIMIT 1
  `, [source_type, parseInt(source_id), event_type, event_subtype || null]);
  return result.rows[0]?.event_id || null;
}

// ─── AR INVOICE PRODUCER ──────────────────────────────────────
/**
 * TRIGGER 1: AR Invoice Approved → REVENUE event
 */
async function onARInvoiceApproved(invoice, approvedByUserId, client = null) {
  return emitFinancialEvent({
    company_id:    invoice.company_id,
    project_id:    invoice.project_id,
    event_type:    'REVENUE',
    event_subtype: 'AR_INVOICE',
    event_category: 'REVENUE',
    event_date:    invoice.issue_date || new Date().toISOString().slice(0,10),
    amount:        parseFloat(invoice.total_amount),
    currency:      invoice.currency || 'MXN',
    source_type:   'AR_INVOICE',
    source_id:     invoice.id,
    created_by:    approvedByUserId,
    metadata: {
      folio:       invoice.folio,
      client_id:   invoice.client_id,
      due_date:    invoice.due_date
    }
  }, client);
}

/**
 * TRIGGER 2: AR Payment Received → COLLECTION + CASH_INFLOW events
 */
async function onARPaymentReceived(payment, invoice, createdByUserId, client = null) {
  const eventDate = payment.payment_date || new Date().toISOString().slice(0,10);
  const basePayload = {
    company_id:  invoice.company_id,
    project_id:  invoice.project_id,
    currency:    invoice.currency || 'MXN',
    created_by:  createdByUserId,
    metadata: {
      invoice_id:    invoice.id,
      folio:         invoice.folio,
      client_id:     invoice.client_id,
      payment_method: payment.payment_method,
      bank_account_id: payment.bank_account_id
    }
  };

  const [collection, cashInflow] = await Promise.all([
    emitFinancialEvent({
      ...basePayload,
      event_type:    'COLLECTION',
      event_subtype: 'AR_PAYMENT',
      event_category: 'COLLECTION',
      event_date:    eventDate,
      amount:        parseFloat(payment.amount),
      source_type:   'AR_PAYMENT',
      source_id:     payment.id,
    }, client),
    emitFinancialEvent({
      ...basePayload,
      event_type:    'CASH_INFLOW',
      event_subtype: 'AR_COLLECTION',
      event_category: 'CASH_FLOW',
      event_date:    eventDate,
      amount:        parseFloat(payment.amount),
      source_type:   'AR_PAYMENT',
      source_id:     payment.id,
      external_reference: payment.reference || null
    }, client)
  ]);

  return { collection, cashInflow };
}

/**
 * TRIGGER 3: AR Invoice Cancelled → REVERSAL of REVENUE
 */
async function onARInvoiceCancelled(invoice, cancelledByUserId, client = null) {
  const originalEventId = await findEventId('AR_INVOICE', invoice.id, 'REVENUE', 'AR_INVOICE', client);
  if (!originalEventId) {
    logger.info(`[FinancialEventService] AR Invoice ${invoice.id} cancelled — no REVENUE event found, skipping reversal`);
    return null;
  }

  return emitFinancialEvent({
    company_id:    invoice.company_id,
    project_id:    invoice.project_id,
    event_type:    'REVERSAL',
    event_subtype: 'AR_INVOICE_CANCEL',
    event_category: 'REVERSAL',
    event_date:    new Date().toISOString().slice(0,10),
    amount:        parseFloat(invoice.total_amount),
    currency:      invoice.currency || 'MXN',
    source_type:   'AR_INVOICE',
    source_id:     invoice.id,
    reversal_of:   originalEventId,
    created_by:    cancelledByUserId,
    metadata: { folio: invoice.folio, reason: 'invoice_cancelled' }
  }, client);
}

// ─── AP BILL PRODUCER ─────────────────────────────────────────
/**
 * TRIGGER 1: AP Bill Approved → OPERATING_EXPENSE + LIABILITY events
 */
async function onAPBillApproved(bill, approvedByUserId, client = null) {
  const eventDate = bill.issue_date || new Date().toISOString().slice(0,10);
  const basePayload = {
    company_id:  bill.company_id,
    project_id:  bill.project_id,
    currency:    bill.currency || 'MXN',
    event_date:  eventDate,
    amount:      parseFloat(bill.total_amount),
    source_type: 'AP_BILL',
    source_id:   bill.id,
    created_by:  approvedByUserId,
    metadata: {
      folio:          bill.folio || bill.vendor_invoice_no,
      vendor_master_id: bill.vendor_master_id,
      internal_po_id: bill.internal_po_id,
      due_date:       bill.due_date
    }
  };

  const [opex, liability] = await Promise.all([
    emitFinancialEvent({
      ...basePayload,
      event_type:    'OPERATING_EXPENSE',
      event_subtype: 'AP_BILL',
      event_category: 'OPERATING_EXPENSE',
    }, client),
    emitFinancialEvent({
      ...basePayload,
      event_type:    'LIABILITY',
      event_subtype: 'AP_BILL',
      event_category: 'BALANCE_SHEET',
    }, client)
  ]);

  return { operatingExpense: opex, liability };
}

/**
 * TRIGGER 2: AP Payment Recorded → REVERSAL of LIABILITY + CASH_OUTFLOW
 */
async function onAPPaymentRecorded(payment, bill, createdByUserId, client = null) {
  // Find the original LIABILITY event to reverse
  const liabilityEventId = await findEventId('AP_BILL', bill.id, 'LIABILITY', 'AP_BILL', client);

  const eventDate = payment.payment_date || new Date().toISOString().slice(0,10);
  const basePayload = {
    company_id:  bill.company_id,
    project_id:  bill.project_id,
    currency:    bill.currency || 'MXN',
    event_date:  eventDate,
    amount:      parseFloat(payment.amount),
    source_type: 'AP_PAYMENT',
    source_id:   payment.id,
    created_by:  createdByUserId,
    metadata: {
      bill_id:        bill.id,
      folio:          bill.folio || bill.vendor_invoice_no,
      vendor_master_id: bill.vendor_master_id,
      payment_method: payment.payment_method,
      bank_account_id: payment.bank_account_id
    }
  };

  const results = {};

  // Reversal of LIABILITY — validate cumulative reversals do not exceed original
  if (liabilityEventId) {
    const dbQuery = client ? (sql, p) => client.query(sql, p) : query;

    // Get original liability amount
    const liabilityRow = await dbQuery(
      `SELECT amount FROM financial_events WHERE event_id=$1`,
      [liabilityEventId]
    );
    const originalAmount = parseFloat(liabilityRow.rows[0]?.amount || 0);

    // Sum all existing reversals against this liability
    const existingReversals = await dbQuery(`
      SELECT COALESCE(SUM(amount), 0) AS total_reversed
      FROM financial_events
      WHERE reversal_of = $1 AND status = 'active'
    `, [liabilityEventId]);
    const alreadyReversed = parseFloat(existingReversals.rows[0].total_reversed);
    const newPayment = parseFloat(payment.amount);

    if (alreadyReversed + newPayment > originalAmount + 0.01) { // 0.01 rounding tolerance
      throw new Error(
        `[FinancialEventService] LIABILITY reversal overflow: ` +
        `original=${originalAmount}, already_reversed=${alreadyReversed}, ` +
        `new_payment=${newPayment}. ` +
        `Cumulative reversals would exceed original liability amount.`
      );
    }

    results.liabilityReversal = await emitFinancialEvent({
      ...basePayload,
      event_type:    'REVERSAL',
      event_subtype: 'AP_BILL_PAYMENT',
      event_category: 'BALANCE_SHEET',
      reversal_of:   liabilityEventId
    }, client);
  }

  // Cash outflow
  results.cashOutflow = await emitFinancialEvent({
    ...basePayload,
    event_type:    'CASH_OUTFLOW',
    event_subtype: 'AP_BILL_PAYMENT',
    event_category: 'CASH_FLOW',
    external_reference: payment.reference || null
  }, client);

  return results;
}

/**
 * TRIGGER 3: AP Bill Cancelled → REVERSAL of OPERATING_EXPENSE + LIABILITY
 */
async function onAPBillCancelled(bill, cancelledByUserId, client = null) {
  const [opexEventId, liabilityEventId] = await Promise.all([
    findEventId('AP_BILL', bill.id, 'OPERATING_EXPENSE', 'AP_BILL', client),
    findEventId('AP_BILL', bill.id, 'LIABILITY', 'AP_BILL', client)
  ]);

  if (!opexEventId && !liabilityEventId) {
    logger.info(`[FinancialEventService] AP Bill ${bill.id} cancelled — no events found, skipping reversal`);
    return null;
  }

  const eventDate = new Date().toISOString().slice(0,10);
  const baseCancel = {
    company_id:    bill.company_id,
    project_id:    bill.project_id,
    event_subtype: 'AP_BILL_CANCEL',
    event_category: 'REVERSAL',
    event_date:    eventDate,
    amount:        parseFloat(bill.total_amount),
    currency:      bill.currency || 'MXN',
    source_type:   'AP_BILL',
    source_id:     bill.id,
    created_by:    cancelledByUserId,
    metadata:      { folio: bill.folio || bill.vendor_invoice_no, reason: 'bill_cancelled' }
  };

  const results = {};
  if (opexEventId) {
    results.opexReversal = await emitFinancialEvent({
      ...baseCancel, event_type: 'REVERSAL', reversal_of: opexEventId
    }, client);
  }
  if (liabilityEventId) {
    results.liabilityReversal = await emitFinancialEvent({
      ...baseCancel, event_type: 'REVERSAL', reversal_of: liabilityEventId
    }, client);
  }
  return results;
}

// ─── EXPENSE PRODUCER ────────────────────────────────────────
/**
 * TRIGGER 1: Expense Approved → OPERATING_EXPENSE event
 */
async function onExpenseApproved(expense, approvedByUserId, client = null) {
  return emitFinancialEvent({
    company_id:    expense.company_id,
    project_id:    expense.project_id || null,
    event_type:    'OPERATING_EXPENSE',
    event_subtype: 'EXPENSE_APPROVED',
    event_category: 'OPERATING_EXPENSE',
    event_date:    expense.expense_date || expense.created_at?.toISOString?.()?.slice(0,10)
                   || new Date().toISOString().slice(0,10),
    amount:        parseFloat(expense.amount),
    currency:      expense.currency || 'MXN',
    source_type:   'EXPENSE',
    source_id:     expense.id,
    created_by:    approvedByUserId,
    metadata: {
      expense_type:  expense.expense_type,
      category_id:   expense.category_id,
      description:   expense.description,
      vendor_master_id: expense.vendor_master_id || null
    }
  }, client);
}

/**
 * TRIGGER 2: Expense Reimbursed → CASH_OUTFLOW event
 * source_type = EXPENSE_REIMBURSEMENT to distinguish from approval
 */
async function onExpenseReimbursed(expense, reimbursedByUserId, client = null) {
  return emitFinancialEvent({
    company_id:    expense.company_id,
    project_id:    expense.project_id || null,
    event_type:    'CASH_OUTFLOW',
    event_subtype: 'EXPENSE_REIMBURSEMENT',
    event_category: 'CASH_FLOW',
    event_date:    new Date().toISOString().slice(0,10),
    amount:        parseFloat(expense.amount),
    currency:      expense.currency || 'MXN',
    source_type:   'EXPENSE_REIMBURSEMENT',
    source_id:     expense.id,
    created_by:    reimbursedByUserId,
    metadata: {
      expense_type: expense.expense_type,
      description:  expense.description
    }
  }, client);
}

/**
 * TRIGGER 3: Expense Cancelled → REVERSAL of OPERATING_EXPENSE
 */
async function onExpenseCancelled(expense, cancelledByUserId, client = null) {
  const originalEventId = await findEventId(
    'EXPENSE', expense.id, 'OPERATING_EXPENSE', 'EXPENSE_APPROVED', client
  );
  if (!originalEventId) {
    logger.info(`[FinancialEventService] Expense ${expense.id} cancelled — no OPERATING_EXPENSE event found`);
    return null;
  }
  return emitFinancialEvent({
    company_id:    expense.company_id,
    project_id:    expense.project_id || null,
    event_type:    'REVERSAL',
    event_subtype: 'EXPENSE_APPROVED',
    event_category: 'REVERSAL',
    event_date:    new Date().toISOString().slice(0,10),
    amount:        parseFloat(expense.amount),
    currency:      expense.currency || 'MXN',
    source_type:   'EXPENSE',
    source_id:     expense.id,
    reversal_of:   originalEventId,
    created_by:    cancelledByUserId,
    metadata: { description: expense.description, reason: 'expense_cancelled' }
  }, client);
}

// ─── INTERNAL PO PRODUCER ────────────────────────────────────
/**
 * TRIGGER 1: IPO Approved → COMMITMENT event
 * Note: COMMITMENT is budget-control only — NOT a P&L event
 */
async function onIPOApproved(ipo, approvedByUserId, client = null) {
  return emitFinancialEvent({
    company_id:    ipo.company_id,
    project_id:    ipo.project_id,
    event_type:    'COMMITMENT',
    event_subtype: 'IPO_APPROVED',
    event_category: 'BUDGET_CONTROL',
    event_date:    new Date().toISOString().slice(0,10),
    amount:        parseFloat(ipo.committed_amount || ipo.total_amount),
    currency:      ipo.currency || 'MXN',
    source_type:   'INTERNAL_PO',
    source_id:     ipo.id,
    created_by:    approvedByUserId,
    metadata: {
      po_number:       ipo.po_number,
      vendor_master_id: ipo.vendor_master_id,
      description:     ipo.description
    }
  }, client);
}

/**
 * TRIGGER 2: IPO Cancelled → REVERSAL of COMMITMENT
 */
async function onIPOCancelled(ipo, cancelledByUserId, client = null) {
  const originalEventId = await findEventId(
    'INTERNAL_PO', ipo.id, 'COMMITMENT', 'IPO_APPROVED', client
  );
  if (!originalEventId) {
    logger.info(`[FinancialEventService] IPO ${ipo.id} cancelled — no COMMITMENT event found`);
    return null;
  }
  return emitFinancialEvent({
    company_id:    ipo.company_id,
    project_id:    ipo.project_id,
    event_type:    'REVERSAL',
    event_subtype: 'IPO_APPROVED',
    event_category: 'BUDGET_CONTROL',
    event_date:    new Date().toISOString().slice(0,10),
    amount:        parseFloat(ipo.committed_amount || ipo.total_amount),
    currency:      ipo.currency || 'MXN',
    source_type:   'INTERNAL_PO',
    source_id:     ipo.id,
    reversal_of:   originalEventId,
    created_by:    cancelledByUserId,
    metadata: { po_number: ipo.po_number, reason: 'ipo_cancelled' }
  }, client);
}

module.exports = {
  emitFinancialEvent,
  findEventId,
  // AR producers
  onARInvoiceApproved,
  onARPaymentReceived,
  onARInvoiceCancelled,
  // AP producers
  onAPBillApproved,
  onAPPaymentRecorded,
  onAPBillCancelled,
  // Expense producers
  onExpenseApproved,
  onExpenseReimbursed,
  onExpenseCancelled,
  // Internal PO producers
  onIPOApproved,
  onIPOCancelled
};
