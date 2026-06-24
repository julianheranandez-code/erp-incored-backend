'use strict';

/**
 * Treasury Execute Endpoint — Sprint 5.2D
 * =========================================
 * Adds POST /api/treasury/payment-requests/:id/execute
 * and hooks Financial Event producers into:
 *   - Treasury transactions (INFLOW/OUTFLOW)
 *   - Payment request execution
 *   - Intercompany transfer execution
 *
 * This file is APPENDED to treasury2a.js router exports.
 * Add to app.js after existing treasury2a mount.
 */

const express = require('express');
const router  = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const {
  onTreasuryTransactionCreated,
  onPaymentRequestExecuted,
  onIntercompanyTransferExecuted
} = require('../services/financial-event-service');
const logger = require('../utils/logger');

router.use(verifyToken);

// ─── POST /api/treasury/payment-requests/:id/execute ─────────
// Sprint 5.2D: Execute a scheduled payment request → CASH_OUTFLOW event
router.post('/payment-requests/:id/execute', async (req, res, next) => {
  try {
    const prId = parseInt(req.params.id);
    const { payment_date, reference } = req.body;

    const pr = await query(
      `SELECT * FROM treasury_payment_requests WHERE id=$1`, [prId]
    );
    if (!pr.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const paymentRequest = pr.rows[0];

    if (!['approved','scheduled'].includes(paymentRequest.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Only approved/scheduled requests can be executed. Current: ${paymentRequest.status}` });

    const result = await withTransaction(async (client) => {
      // Update payment request to executed
      const updated = await client.query(`
        UPDATE treasury_payment_requests SET
          status = 'executed',
          payment_date = $1,
          updated_at = NOW()
        WHERE id = $2 RETURNING *
      `, [payment_date || new Date().toISOString().slice(0,10), prId]);

      // Sprint 5.2D ARCHITECTURE DECISION:
      // PR execution does NOT emit CASH_OUTFLOW here.
      // CASH_OUTFLOW was already emitted when the underlying AP Bill / Expense payment
      // was recorded (via onAPPaymentRecorded / onExpenseReimbursed).
      // PR execute = operational status tracking only — not a new cash event.
      // Exception: DIRECT treasury payments (no AP Bill source) DO emit here.
      if (!paymentRequest.source_document_type ||
          !['AP_BILL','EXPENSE'].includes(paymentRequest.source_document_type)) {
        try {
          await onPaymentRequestExecuted(
            { ...paymentRequest, payment_date: payment_date || new Date().toISOString().slice(0,10) },
            req.user.id, client
          );
        } catch(evtErr) {
          logger.error(`[TREASURY] Payment request execute event failed: ${evtErr.message}`);
          throw evtErr;
        }
      } else {
        logger.info(`[TREASURY] PR ${prId} executed — CASH_OUTFLOW already emitted by ${paymentRequest.source_document_type} payment`);
      }

      return updated.rows[0];
    });

    writeAudit({
      userId: req.user.id, action: 'payment_request_executed',
      entityType: 'treasury_payment_requests', entityId: String(prId),
      companyId: paymentRequest.company_id,
      newValues: { status: 'executed', payment_date },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Payment request executed.', data: result });
  } catch(error) { next(error); }
});

// ─── POST /api/treasury/transactions (override with event hook) ─
// Sprint 5.2D: Wrap existing transaction creation with event emission
router.post('/transactions-with-events', async (req, res, next) => {
  try {
    const {
      company_id, bank_account_id, transaction_date, value_date,
      bank_reference, bank_description, amount, direction,
      category_id, project_id, vendor_id, client_id,
      invoice_id, notes, import_source
    } = req.body;

    if (!company_id || !bank_account_id || !transaction_date ||
        !bank_description || !amount || !direction)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, bank_account_id, transaction_date, bank_description, amount, direction' });

    if (!['INFLOW','OUTFLOW'].includes(direction))
      return res.status(400).json({ success: false, error: 'invalid_direction' });

    const result = await withTransaction(async (client) => {
      const tx = await client.query(`
        INSERT INTO treasury_bank_transactions (
          company_id, bank_account_id, transaction_date, value_date,
          bank_reference, bank_description, amount, direction,
          category_id, project_id, vendor_id, client_id,
          invoice_id, notes, import_source, status, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'cleared',$16)
        RETURNING *
      `, [parseInt(company_id), parseInt(bank_account_id),
          transaction_date, value_date||null,
          bank_reference||null, bank_description, parseFloat(amount), direction,
          category_id||null, project_id||null, vendor_id||null,
          client_id||null, invoice_id||null, notes||null,
          import_source||null, req.user.id]);

      const createdTx = tx.rows[0];

      // Sprint 5.2D: Emit CASH_INFLOW or CASH_OUTFLOW event
      try {
        await onTreasuryTransactionCreated(createdTx, req.user.id, client);
      } catch(evtErr) {
        logger.error(`[TREASURY] Transaction event emission failed: ${evtErr.message}`);
        throw evtErr;
      }

      return createdTx;
    });

    res.status(201).json({ success: true, message: 'Transaction created.', data: result });
  } catch(error) { next(error); }
});

// ─── POST /api/treasury/intercompany-transfers/:id/execute ───
// Sprint 5.2D: Execute intercompany transfer → dual events (atomic)
router.post('/intercompany-transfers/:id/execute', async (req, res, next) => {
  try {
    const transferId = parseInt(req.params.id);

    const tr = await query(
      `SELECT * FROM treasury_intercompany_transfers WHERE id=$1`, [transferId]
    );
    if (!tr.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const transfer = tr.rows[0];

    if (transfer.status !== 'approved')
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Only approved transfers can be executed. Current: ${transfer.status}` });

    const result = await withTransaction(async (client) => {
      const updated = await client.query(`
        UPDATE treasury_intercompany_transfers SET
          status = 'executed',
          executed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1 RETURNING *
      `, [transferId]);

      const executedTransfer = updated.rows[0];

      // Sprint 5.2D: Emit BOTH events atomically — no single-sided transfers
      try {
        await onIntercompanyTransferExecuted(executedTransfer, req.user.id, client);
      } catch(evtErr) {
        logger.error(`[TREASURY] Intercompany event emission failed: ${evtErr.message}`);
        throw evtErr; // Rollback both events
      }

      return executedTransfer;
    });

    writeAudit({
      userId: req.user.id, action: 'intercompany_transfer_executed',
      entityType: 'treasury_intercompany_transfers', entityId: String(transferId),
      companyId: transfer.source_company_id,
      newValues: { status: 'executed' },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Intercompany transfer executed.', data: result });
  } catch(error) { next(error); }
});

module.exports = router;
