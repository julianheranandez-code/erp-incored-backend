'use strict';

/**
 * Historical Backfill Service v2 — Sprint 5.3A
 * ==============================================
 * ARCHITECTURE: Pure orchestrator — no business logic.
 *
 * BEFORE (Sprint 5.3):
 *   Backfill → emitFinancialEvent() directly (wrong — duplicated logic)
 *
 * AFTER (Sprint 5.3A):
 *   Backfill → Producer → emitFinancialEvent() (correct — single source of truth)
 *
 * Any future change to a producer automatically applies to BOTH
 * live transactions AND historical backfill.
 *
 * ROLLBACK: Uses DB SECURITY DEFINER function (no trigger disable needed).
 */

const { query } = require('../config/database');
const logger = require('../utils/logger');
const {
  onARInvoiceApproved,
  onARPaymentReceived,
  onARInvoiceCancelled,
  onAPBillApproved,
  onAPPaymentRecorded,
  onExpenseApproved,
  onExpenseReimbursed,
  onIPOApproved,
} = require('./financial-event-service');

const BATCH_ID      = 'BACKFILL_5_3';
const BATCH_VERSION = '5.3';
const BATCH_SIZE    = 50;

// ─── EXECUTION CONTEXT ────────────────────────────────────────
// Passed to producers → merged into metadata by emitFinancialEvent()
// Producers remain the ONLY place where event fields are defined
const BACKFILL_CONTEXT = {
  mode:               'BACKFILL',
  backfill_batch_id:  BATCH_ID,
  backfill_version:   BATCH_VERSION,
  backfill_timestamp: new Date().toISOString()
};

// ─── TRACKER ─────────────────────────────────────────────────
function createTracker() {
  return { processed: 0, skipped: 0, created: 0, errors: 0, details: [] };
}

function logResult(tracker, type, id, result, error = null) {
  if (error) {
    tracker.errors++;
    tracker.details.push({ type, id, status: 'ERROR', error: error.message });
    logger.error(`[BACKFILL] ERROR ${type}#${id}: ${error.message}`);
  } else if (result?._duplicate) {
    tracker.skipped++;
    tracker.details.push({ type, id, status: 'SKIPPED' });
    logger.info(`[BACKFILL] SKIP ${type}#${id} (already has event)`);
  } else {
    tracker.created++;
    tracker.details.push({ type, id, status: 'CREATED', event_id: result?.event_id });
    logger.info(`[BACKFILL] CREATE ${type}#${id} → ${result?.event_type}/${result?.event_subtype}`);
  }
  tracker.processed++;
}

// ─── AR INVOICE ORCHESTRATION ─────────────────────────────────
async function backfillARInvoices(dryRun, tracker) {
  const records = await query(`
    SELECT ai.* FROM ar_invoices ai
    WHERE ai.status IN ('approved','sent','partially_paid','paid')
      AND NOT EXISTS (
        SELECT 1 FROM financial_events fe
        WHERE fe.source_type='AR_INVOICE' AND fe.source_id=ai.id
          AND fe.event_type='REVENUE' AND fe.status='active'
      )
    ORDER BY ai.created_at ASC LIMIT $1
  `, [BATCH_SIZE]);

  logger.info(`[BACKFILL] AR Invoices: ${records.rows.length} needing REVENUE event`);

  for (const inv of records.rows) {
    if (dryRun) {
      logger.info(`[DRY] onARInvoiceApproved(invoice#${inv.id} folio=${inv.folio} amount=${inv.total_amount})`);
      tracker.processed++; continue;
    }
    try {
      // Orchestrator calls producer — producer owns all logic
      const result = await onARInvoiceApproved(inv, inv.approved_by || inv.created_by, null, BACKFILL_CONTEXT);
      logResult(tracker, 'AR_INVOICE', inv.id, result);
    } catch(err) { logResult(tracker, 'AR_INVOICE', inv.id, null, err); }
  }
}

// ─── AP BILL ORCHESTRATION ────────────────────────────────────
async function backfillAPBills(dryRun, tracker) {
  const records = await query(`
    SELECT ab.* FROM ap_bills ab
    WHERE ab.status IN ('approved','partially_paid','paid')
      AND NOT EXISTS (
        SELECT 1 FROM financial_events fe
        WHERE fe.source_type='AP_BILL' AND fe.source_id=ab.id
          AND fe.event_type='OPERATING_EXPENSE' AND fe.status='active'
      )
    ORDER BY ab.created_at ASC LIMIT $1
  `, [BATCH_SIZE]);

  logger.info(`[BACKFILL] AP Bills: ${records.rows.length} needing OPERATING_EXPENSE + LIABILITY events`);

  for (const bill of records.rows) {
    if (dryRun) {
      logger.info(`[DRY] onAPBillApproved(bill#${bill.id} amount=${bill.total_amount})`);
      tracker.processed++; continue;
    }
    try {
      const result = await onAPBillApproved(bill, bill.approved_by || bill.created_by, null, BACKFILL_CONTEXT);
      logResult(tracker, 'AP_BILL_OPEX', bill.id, result?.operatingExpense);
      logResult(tracker, 'AP_BILL_LIABILITY', bill.id, result?.liability);
    } catch(err) { logResult(tracker, 'AP_BILL', bill.id, null, err); }
  }
}

// ─── AP PAYMENT ORCHESTRATION ─────────────────────────────────
async function backfillAPPayments(dryRun, tracker) {
  const records = await query(`
    SELECT ap.*, ab.company_id AS bill_company_id, ab.project_id,
           ab.currency, ab.folio, ab.vendor_master_id, ab.internal_po_id
    FROM ap_payments ap
    JOIN ap_bills ab ON ab.id = ap.bill_id
    WHERE NOT EXISTS (
      SELECT 1 FROM financial_events fe
      WHERE fe.source_type='AP_PAYMENT' AND fe.source_id=ap.id
        AND fe.event_type='CASH_OUTFLOW' AND fe.status='active'
    )
    ORDER BY ap.created_at ASC LIMIT $1
  `, [BATCH_SIZE]);

  logger.info(`[BACKFILL] AP Payments: ${records.rows.length} needing CASH_OUTFLOW events`);

  for (const pmt of records.rows) {
    if (dryRun) {
      logger.info(`[DRY] onAPPaymentRecorded(payment#${pmt.id} bill#${pmt.bill_id} amount=${pmt.amount})`);
      tracker.processed++; continue;
    }
    try {
      // FIX 1: Fetch complete AP Bill entity — producer owns field responsibility
      const billResult = await query(
        `SELECT * FROM ap_bills WHERE id=$1`, [pmt.bill_id]
      );
      if (!billResult.rows[0]) {
        logResult(tracker, 'AP_PAYMENT', pmt.id, null,
          new Error(`AP Bill #${pmt.bill_id} not found`));
        continue;
      }
      const result = await onAPPaymentRecorded(pmt, billResult.rows[0], pmt.created_by, null, BACKFILL_CONTEXT);
      logResult(tracker, 'AP_PAYMENT_REVERSAL', pmt.id, result?.liabilityReversal);
      logResult(tracker, 'AP_PAYMENT_CASH', pmt.id, result?.cashOutflow);
    } catch(err) { logResult(tracker, 'AP_PAYMENT', pmt.id, null, err); }
  }
}

// ─── EXPENSE ORCHESTRATION ────────────────────────────────────
async function backfillExpenses(dryRun, tracker) {
  const records = await query(`
    SELECT * FROM expenses
    WHERE status IN ('payment_request_created','reimbursed')
      AND NOT EXISTS (
        SELECT 1 FROM financial_events fe
        WHERE fe.source_type='EXPENSE' AND fe.source_id=expenses.id
          AND fe.event_type='OPERATING_EXPENSE' AND fe.status='active'
      )
    ORDER BY created_at ASC LIMIT $1
  `, [BATCH_SIZE]);

  logger.info(`[BACKFILL] Expenses: ${records.rows.length} needing OPERATING_EXPENSE events`);

  for (const exp of records.rows) {
    if (dryRun) {
      logger.info(`[DRY] onExpenseApproved(expense#${exp.id} amount=${exp.amount})`);
      if (exp.status === 'reimbursed')
        logger.info(`[DRY] onExpenseReimbursed(expense#${exp.id} amount=${exp.amount})`);
      tracker.processed++; continue;
    }
    try {
      const opex = await onExpenseApproved(exp, exp.approved_by || exp.created_by, null, BACKFILL_CONTEXT);
      logResult(tracker, 'EXPENSE_OPEX', exp.id, opex);

      if (exp.status === 'reimbursed') {
        const cashOut = await onExpenseReimbursed(exp, exp.created_by, null, BACKFILL_CONTEXT);
        logResult(tracker, 'EXPENSE_REIMBURSEMENT', exp.id, cashOut);
      }
    } catch(err) { logResult(tracker, 'EXPENSE', exp.id, null, err); }
  }
}

// ─── IPO ORCHESTRATION ───────────────────────────────────────
async function backfillIPOs(dryRun, tracker) {
  const records = await query(`
    SELECT * FROM internal_purchase_orders
    WHERE status IN ('approved','partially_consumed','fully_consumed')
      AND NOT EXISTS (
        SELECT 1 FROM financial_events fe
        WHERE fe.source_type='INTERNAL_PO' AND fe.source_id=internal_purchase_orders.id
          AND fe.event_type='COMMITMENT' AND fe.status='active'
      )
    ORDER BY created_at ASC LIMIT $1
  `, [BATCH_SIZE]);

  logger.info(`[BACKFILL] IPOs: ${records.rows.length} needing COMMITMENT events`);

  for (const ipo of records.rows) {
    if (dryRun) {
      logger.info(`[DRY] onIPOApproved(ipo#${ipo.id} po_number=${ipo.po_number} amount=${ipo.committed_amount || ipo.total_amount})`);
      tracker.processed++; continue;
    }
    try {
      const result = await onIPOApproved(ipo, ipo.approved_by || ipo.created_by, null, BACKFILL_CONTEXT);
      logResult(tracker, 'IPO_COMMITMENT', ipo.id, result);
    } catch(err) { logResult(tracker, 'IPO', ipo.id, null, err); }
  }
}

// ─── MAIN RUNNER ─────────────────────────────────────────────
async function runBackfill(options = {}) {
  const { dryRun = true } = options;

  logger.info(`[BACKFILL] ==========================================`);
  logger.info(`[BACKFILL] Sprint 5.3 Historical Backfill v2`);
  logger.info(`[BACKFILL] Mode: ${dryRun ? 'DRY RUN' : 'LIVE EXECUTE'}`);
  logger.info(`[BACKFILL] Batch ID: ${BATCH_ID}`);
  logger.info(`[BACKFILL] Architecture: Orchestrator → Producer → emitFinancialEvent()`);
  logger.info(`[BACKFILL] ==========================================`);

  const tracker = createTracker();
  const startTime = Date.now();

  await backfillARInvoices(dryRun, tracker);
  await backfillAPBills(dryRun, tracker);
  await backfillAPPayments(dryRun, tracker);
  await backfillExpenses(dryRun, tracker);
  await backfillIPOs(dryRun, tracker);

  const duration = Date.now() - startTime;
  logger.info(`[BACKFILL] ==========================================`);
  logger.info(`[BACKFILL] Processed:${tracker.processed} Created:${tracker.created} Skipped:${tracker.skipped} Errors:${tracker.errors} (${duration}ms)`);
  logger.info(`[BACKFILL] ==========================================`);

  return { ...tracker, duration, batch_id: BATCH_ID, dry_run: dryRun };
}

// ─── ROLLBACK via SECURITY DEFINER function ───────────────────
// No ALTER TABLE DISABLE TRIGGER needed
async function rollbackBackfill(batchId = BATCH_ID) {
  logger.warn(`[BACKFILL] ROLLBACK: batch=${batchId}`);

  // Use fn_delete_backfill_events() SECURITY DEFINER (created in migration)
  // This function bypasses trigger because it runs as table owner
  const result = await query(`
    SELECT fn_delete_backfill_events($1) AS deleted
  `, [batchId]);

  const deleted = result.rows[0]?.deleted || 0;
  logger.warn(`[BACKFILL] Rollback complete: ${deleted} events deleted`);
  return { deleted, batch_id: batchId };
}

// ─── POST-BACKFILL VALIDATION ─────────────────────────────────
async function validateBackfill() {
  const [dupes, orphans, nullCo, summary] = await Promise.all([
    query(`SELECT COUNT(*) AS c FROM (
      SELECT source_type,source_id,event_type,event_subtype FROM financial_events
      WHERE status='active' GROUP BY 1,2,3,4 HAVING COUNT(*)>1) x`),
    query(`SELECT COUNT(*) AS c FROM financial_events fe
      LEFT JOIN financial_events orig ON orig.event_id=fe.reversal_of
      WHERE fe.event_type='REVERSAL' AND orig.event_id IS NULL`),
    query(`SELECT COUNT(*) AS c FROM financial_events WHERE company_id IS NULL`),
    query(`SELECT event_type, COUNT(*) AS count, SUM(amount) AS total
      FROM financial_events WHERE status='active'
      GROUP BY event_type ORDER BY event_type`)
  ]);
  return {
    duplicates:       parseInt(dupes.rows[0].c),
    orphan_reversals: parseInt(orphans.rows[0].c),
    null_company:     parseInt(nullCo.rows[0].c),
    event_summary:    summary.rows
  };
}

module.exports = { runBackfill, rollbackBackfill, validateBackfill, BATCH_ID };
