'use strict';

const { onIPOCancelled } = require('../services/financial-event-service');

/**
 * PROJECT COMMITMENT MODEL — Architecture Note (Sprint 3C.3)
 * ===========================================================
 * Project-level cost commitments are derived from:
 *
 *   SELECT SUM(committed_amount)
 *   FROM internal_purchase_orders
 *   WHERE project_id = X
 *     AND status IN ('approved','partially_consumed','fully_consumed')
 *
 * DO NOT add projects.committed_amount column.
 * Project budget control is implemented in Sprint 3D.
 *
 * Vendor Master (vendors table) is the source of truth for suppliers.
 * internal_purchase_orders.vendor_master_id → vendors.id
 * Legacy vendor_id (→ clients) maintained for backward compat.
 */

/**
 * Internal Purchase Orders v2 — Sprint 3C
 * =========================================
 * Enhancements:
 *   - Approval Engine V2 integration (INTERNAL_PO type)
 *   - PO balance enforcement on AP Bill creation
 *   - committed_amount tracking
 *   - Full status lifecycle
 *   - Event-driven approval completion
 */

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { getApprovalChain, resolveApprovers, getCompanyApprovalPolicy } = require('../lib/approval-engine');
const logger = require('../utils/logger');

router.use(verifyToken);

// ─── HELPERS ──────────────────────────────────────────────────
function getEffectiveRoles(user) {
  return user.roles?.length ? user.roles : user.role ? [user.role] : [];
}

async function getIPOAccess(id, userId, roles) {
  const result = await query(`
    SELECT p.*,
      c.name AS vendor_name,
      pr.name AS project_name, pr.code AS project_code,
      CONCAT(u.first_name,' ',u.last_name) AS created_by_name
    FROM internal_purchase_orders p
    LEFT JOIN clients c   ON c.id = p.vendor_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    LEFT JOIN users u     ON u.id = p.created_by
    WHERE p.id = $1
  `, [parseInt(id)]);
  if (!result.rows[0]) return { error: 'not_found' };

  // Get line items
  const linesResult = await query(
    'SELECT * FROM internal_po_line_items WHERE po_id=$1 ORDER BY sort_order ASC, id ASC',
    [parseInt(id)]
  );
  return { po: { ...result.rows[0], line_items: linesResult.rows } };
}

const VALID_STATUSES = ['draft','pending_approval','approved','partially_consumed',
                        'fully_consumed','closed','cancelled','rejected'];

// ─── GET /api/internal-pos/categories ─────────────────────────
// FIX 1: Use treasury_transaction_categories — single source of truth
// Same catalog used by Expenses (Sprint 3B)
router.get('/categories', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, name, description, category_type, cash_flow_class,
             color, icon, is_active
      FROM treasury_transaction_categories
      WHERE is_active = TRUE
      ORDER BY category_type, name ASC
    `);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(error) { next(error); }
});

// ─── GET /api/internal-pos ────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { company_id, project_id, status, vendor_id,
            page = 1, limit = 50 } = req.query;

    const roles = getEffectiveRoles(req.user);
    const companyId = roles.includes('super_admin') && company_id
      ? parseInt(company_id)
      : parseInt(req.user.active_company_id || req.user.company_id);

    const conditions = [`p.company_id = $1`];
    const values = [companyId];
    let idx = 2;

    if (project_id) { conditions.push(`p.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (status)     { conditions.push(`p.status = $${idx++}`); values.push(status); }
    if (vendor_id)  { conditions.push(`p.vendor_id = $${idx++}`); values.push(parseInt(vendor_id)); }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [rows, summary] = await Promise.all([
      query(`
        SELECT p.*,
          v.name AS vendor_name,
          pr.name AS project_name, pr.code AS project_code,
          CONCAT(u.first_name,' ',u.last_name) AS created_by_name
        FROM internal_purchase_orders p
        LEFT JOIN clients v   ON v.id = p.vendor_id
        LEFT JOIN projects pr  ON pr.id = p.project_id
        LEFT JOIN users u      ON u.id = p.created_by
        ${where}
        ORDER BY p.created_at DESC
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, parseInt(limit), offset]),
      query(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(total_amount), 0) AS total_committed,
          COALESCE(SUM(total_amount) FILTER (WHERE status='approved'), 0) AS total_approved,
          COALESCE(SUM(remaining_amount) FILTER (WHERE status IN ('approved','partially_consumed')), 0) AS total_remaining,
          COALESCE(SUM(total_amount) FILTER (WHERE status='pending_approval'), 0) AS total_pending
        FROM internal_purchase_orders p ${where}
      `, values)
    ]);

    res.json({ success: true, count: rows.rows.length,
      total: parseInt(summary.rows[0].total),
      summary: summary.rows[0], data: rows.rows });
  } catch(error) { next(error); }
});

// ─── GET /api/internal-pos/:id ────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const access = await getIPOAccess(req.params.id, req.user.id, getEffectiveRoles(req.user));
    if (access.error)
      return res.status(access.error === 'not_found' ? 404 : 403).json({ success: false, error: access.error });

    res.json({ success: true, data: access.po });
  } catch(error) { next(error); }
});

// ─── GET /api/internal-pos/:id/balance ────────────────────────
router.get('/:id/balance', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT
        id, po_number, status, total_amount,
        COALESCE(remaining_amount, total_amount) AS remaining_amount,
        COALESCE(committed_amount, 0) AS committed_amount,
        total_amount - COALESCE(remaining_amount, total_amount) AS consumed_amount
      FROM internal_purchase_orders WHERE id = $1
    `, [parseInt(req.params.id)]);

    if (!result.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const po = result.rows[0];
    res.json({ success: true, data: {
      po_id: po.id, po_number: po.po_number, status: po.status,
      po_total: parseFloat(po.total_amount),
      consumed: parseFloat(po.consumed_amount),
      remaining: parseFloat(po.remaining_amount),
      committed: parseFloat(po.committed_amount)
    }});
  } catch(error) { next(error); }
});

// ─── GET /api/internal-pos/:id/approval-status ────────────────
router.get('/:id/approval-status', async (req, res, next) => {
  try {
    const access = await getIPOAccess(req.params.id, req.user.id, getEffectiveRoles(req.user));
    if (access.error)
      return res.status(404).json({ success: false, error: access.error });

    const po = access.po;
    if (!po.approval_request_id)
      return res.json({ success: true, data: { status: po.status, approval_request_id: null } });

    const approval = await query(`
      SELECT ar.*, s.level_number, s.approver_role, s.approver_user_id,
        s.status AS step_status,
        CONCAT(u.first_name,' ',u.last_name) AS approver_name
      FROM treasury_approval_requests ar
      LEFT JOIN treasury_approval_steps s ON s.request_id = ar.id
      LEFT JOIN users u ON u.id = s.approver_user_id
      WHERE ar.id = $1
      ORDER BY s.level_number
    `, [po.approval_request_id]);

    res.json({ success: true, data: {
      po_status: po.status,
      approval_request_id: po.approval_request_id,
      approval_status: approval.rows[0]?.status,
      current_level: approval.rows[0]?.current_level,
      final_level: approval.rows[0]?.final_level,
      steps: approval.rows.map(r => ({
        level: r.level_number, role: r.approver_role,
        approver: r.approver_name, status: r.step_status
      }))
    }});
  } catch(error) { next(error); }
});

// ─── POST /api/internal-pos ───────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      company_id, project_id, vendor_id, vendor_master_id, po_number, category,
      description, subtotal, tax_percent = 0, notes,
      payment_terms, retention_pct = 0, discount_pct = 0
    } = req.body;

    // Auto-generate PO number if not provided
    const COMPANY_CODES = { 1:'INC', 2:'ZHA', 3:'INT', 4:'MIK' };
    let finalPoNumber = po_number;
    if (!finalPoNumber) {
      const compCode = COMPANY_CODES[parseInt(company_id)] || 'INC';
      const now = new Date();
      const yymm = String(now.getMonth()+1).padStart(2,'0') + String(now.getFullYear()).slice(-2);
      const countResult = await query(
        'SELECT COUNT(*) as cnt FROM internal_purchase_orders WHERE company_id=$1',
        [parseInt(company_id)]
      );
      const seq = String(parseInt(countResult.rows[0].cnt) + 1).padStart(3,'0');
      finalPoNumber = `PO-${compCode}-${yymm}-${seq}`;
    }

    const missing = [];
    if (!company_id)  missing.push('company_id');
    if (!project_id)  missing.push('project_id');
    if (!subtotal)    missing.push('subtotal');
    if (missing.length)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: `Required: ${missing.join(', ')}` });

    // Phase 9: project_id required — no orphan POs
    if (!project_id)
      return res.status(400).json({ success: false, error: 'project_required',
        message: 'Internal Purchase Orders must be associated with a project.' });

    const tax_amount   = parseFloat(subtotal) * (parseFloat(tax_percent) / 100);
    const total_amount = parseFloat(subtotal) + tax_amount;

    const result = await query(`
      INSERT INTO internal_purchase_orders (
        company_id, project_id, vendor_id, vendor_master_id, po_number, category,
        description, subtotal, tax_percent, tax_amount, total_amount,
        remaining_amount, committed_amount, status, created_by,
        payment_terms, retention_pct, retention_amount, discount_pct, discount_amount
      ) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$10,0,'draft',$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [
        parseInt(company_id),
        parseInt(project_id),
        vendor_id ? parseInt(vendor_id) : null,
        finalPoNumber,
        category || null,
        description || null,
        parseFloat(subtotal),
        parseFloat(tax_percent),
        tax_amount,
        total_amount,
        req.user.id,
        payment_terms||null,
        parseFloat(retention_pct||0),
        parseFloat(subtotal) * (parseFloat(retention_pct||0) / 100),
        parseFloat(discount_pct||0),
        parseFloat(subtotal) * (parseFloat(discount_pct||0) / 100)
    ]);

    // Save line items if provided
    const line_items = req.body.line_items || [];
    if (line_items.length > 0) {
      for (let i = 0; i < line_items.length; i++) {
        const item = line_items[i];
        const itemTotal = parseFloat(item.quantity||1) * parseFloat(item.unit_cost||0);
        await query(`
          INSERT INTO internal_po_line_items
            (po_id, description, quantity, unit, unit_cost, total, notes, sort_order)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [result.rows[0].id, item.description||'', parseFloat(item.quantity||1),
           item.unit||null, parseFloat(item.unit_cost||0), itemTotal,
           item.notes||null, i]
        );
      }
    }

    writeAudit({
      userId: req.user.id, action: 'internal_po_created',
      entityType: 'internal_purchase_orders', entityId: String(result.rows[0].id),
      companyId: parseInt(company_id),
      newValues: { po_number, total_amount, project_id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Purchase order created.', data: result.rows[0] });
  } catch(error) {
    if (error.code === '23505')
      return res.status(409).json({ success: false, error: 'duplicate_po_number',
        message: 'PO number already exists.' });
    next(error);
  }
});

// ─── PUT /api/internal-pos/:id ────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const access = await getIPOAccess(req.params.id, req.user.id, getEffectiveRoles(req.user));
    if (access.error)
      return res.status(404).json({ success: false, error: access.error });

    const po = access.po;
    if (!['draft','rejected'].includes(po.status))
      return res.status(400).json({ success: false, error: 'not_editable',
        message: `Cannot edit PO with status: ${po.status}` });

    const { vendor_id, vendor_master_id, category, subtotal, tax_percent, notes, description } = req.body;
    const newSubtotal    = subtotal ? parseFloat(subtotal) : parseFloat(po.subtotal);
    const newTaxPct      = tax_percent !== undefined ? parseFloat(tax_percent) : parseFloat(po.tax_percent);
    const newTaxAmount   = newSubtotal * (newTaxPct / 100);
    const newTotal       = newSubtotal + newTaxAmount;

    const result = await query(`
      UPDATE internal_purchase_orders SET
        vendor_id        = COALESCE($1, vendor_id),
        vendor_master_id = COALESCE($2::integer, vendor_master_id),
        category         = COALESCE($3, category),
        subtotal         = $4,
        tax_percent      = $5,
        tax_amount       = $6,
        total_amount     = $7,
        remaining_amount = $7,
        description      = COALESCE($8, description),
        notes            = COALESCE($9, notes),
        updated_at       = NOW()
      WHERE id = $10 RETURNING *
    `, [
        vendor_id ? parseInt(vendor_id) : null,        // $1  vendor_id
        vendor_master_id ? parseInt(vendor_master_id) : null, // $2 vendor_master_id
        category || null,                              // $3  category
        newSubtotal,                                   // $4  subtotal
        newTaxPct,                                     // $5  tax_percent
        newTaxAmount,                                  // $6  tax_amount
        newTotal,                                      // $7  total_amount (also remaining_amount)
        description || null,                           // $8  description
        notes || null,                                 // $9  notes
        parseInt(req.params.id)                        // $10 id
    ]);

    res.json({ success: true, message: 'Purchase order updated.', data: result.rows[0] });
  } catch(error) { next(error); }
});

// ─── POST /api/internal-pos/:id/submit ───────────────────────
router.post('/:id/submit', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const access = await getIPOAccess(id, req.user.id, getEffectiveRoles(req.user));
    if (access.error)
      return res.status(404).json({ success: false, error: access.error });

    const po = access.po;
    if (!['draft','rejected'].includes(po.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Only draft POs can be submitted. Current: ${po.status}` });

    // Fetch company approval policy
    const approvalPolicy = await getCompanyApprovalPolicy(po.company_id);

    // Get approval chain from engine
    let chain;
    try {
      chain = getApprovalChain('INTERNAL_PO', po.total_amount, approvalPolicy);
    } catch(err) {
      return res.status(400).json({ success: false, error: 'approval_chain_error',
        message: err.message });
    }

    if (!chain || chain.length === 0)
      return res.status(500).json({ success: false, error: 'approval_chain_missing' });

    const { resolved, missing } = await resolveApprovers(po.company_id, chain);
    if (missing.length > 0)
      return res.status(400).json({ success: false, error: 'missing_approver_assignments',
        message: `No approver assigned for roles: ${missing.join(', ')}`,
        missing_roles: missing });

    const finalLevel = resolved.length;
    let approvalRequestId = null;

    await withTransaction(async (client) => {
      const approvalResult = await client.query(`
        INSERT INTO treasury_approval_requests
          (company_id, approval_type, entity_type, entity_id, amount, currency,
           status, requested_by, current_level, final_level, notes)
        VALUES ($1,'INTERNAL_PO','INTERNAL_PO',$2,$3,$4,'pending',$5,1,$6,$7)
        RETURNING id
      `, [po.company_id, String(id), po.total_amount, po.currency || 'MXN',
          req.user.id, finalLevel,
          `Internal PO #${po.po_number}: ${po.description || po.category || ''}`]);

      approvalRequestId = approvalResult.rows[0].id;

      for (const step of resolved) {
        await client.query(`
          INSERT INTO treasury_approval_steps
            (request_id, level_number, approver_role, approver_user_id, status)
          VALUES ($1,$2,$3,$4,'pending')
        `, [approvalRequestId, step.level, step.role, step.user_id]);
      }

      await client.query(`
        UPDATE internal_purchase_orders SET
          status = 'pending_approval',
          approval_request_id = $1,
          updated_at = NOW()
        WHERE id = $2
      `, [approvalRequestId, id]);
    });

    writeAudit({
      userId: req.user.id, action: 'internal_po_submitted',
      entityType: 'internal_purchase_orders', entityId: String(id),
      companyId: po.company_id,
      newValues: { status: 'pending_approval', approval_request_id: approvalRequestId,
                   approval_policy: approvalPolicy, levels: finalLevel },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[IPO] submitted: id=${id} approval=${approvalRequestId} policy=${approvalPolicy}`);
    res.json({ success: true, message: 'Internal PO submitted for approval.',
      data: { po_id: id, approval_request_id: approvalRequestId,
              approval_chain: resolved.map(s => ({ level: s.level, role: s.role, approver: s.user_name })) }
    });
  } catch(error) { next(error); }
});

// ─── POST /api/internal-pos/:id/cancel ───────────────────────
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    if (!reason)
      return res.status(400).json({ success: false, error: 'reason_required' });

    const access = await getIPOAccess(id, req.user.id, getEffectiveRoles(req.user));
    if (access.error) return res.status(404).json({ success: false, error: access.error });

    const po = access.po;
    const roles = getEffectiveRoles(req.user);
    if (po.created_by !== req.user.id && !roles.includes('super_admin'))
      return res.status(403).json({ success: false, error: 'cancel_denied' });

    if (['closed','cancelled'].includes(po.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Cannot cancel PO with status: ${po.status}` });

    if (po.status === 'fully_consumed')
      return res.status(400).json({ success: false, error: 'fully_consumed',
        message: 'Cannot cancel fully consumed PO.' });

    // FIX 2: Release commitment on cancellation
    const releaseCommitment = ['approved','partially_consumed'].includes(po.status);

    await query(`
      UPDATE internal_purchase_orders SET
        status = 'cancelled',
        committed_amount = CASE WHEN $1 THEN 0 ELSE committed_amount END,
        notes = CONCAT(COALESCE(notes,''), ' | Cancelled: ', $2),
        updated_at = NOW()
      WHERE id = $3
    `, [releaseCommitment, reason, id]);

    writeAudit({
      userId: req.user.id, action: 'internal_po_cancelled',
      entityType: 'internal_purchase_orders', entityId: String(id),
      companyId: po.company_id,
      newValues: { reason },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Internal PO cancelled.' });
  } catch(error) { next(error); }
});

module.exports = router;

// POST /api/internal-pos/:id/approve-step — approve current level in chain
router.post('/:id/approve-step', async (req, res, next) => {
  try {
    const { comments } = req.body;
    const poId = parseInt(req.params.id);
    const access = await getIPOAccess(poId, req.user.id, getEffectiveRoles(req.user));
    if (access.error) return res.status(404).json({ success:false, error:access.error });

    const po = access.po;
    if (po.status !== 'pending_approval')
      return res.status(400).json({ success:false, error:'invalid_status',
        message:`PO must be pending_approval. Current: ${po.status}` });

    // Find pending step for this user (any level)
    const stepResult = await query(`
      SELECT s.* FROM treasury_approval_steps s
      WHERE s.request_id = $1 AND s.approver_user_id = $2 AND s.status = 'pending'
      ORDER BY s.level_number ASC LIMIT 1
    `, [po.approval_request_id, req.user.id]);

    if (!stepResult.rows[0])
      return res.status(403).json({ success:false, error:'not_your_turn',
        message:'No pending approval step found for your user' });

    // Segregation of duties: creator cannot approve their own request
    if (po.created_by === req.user.id)
      return res.status(403).json({ success:false, error:'segregation_of_duties',
        message:'No puedes aprobar una solicitud que tu mismo creaste.' });

    const step = stepResult.rows[0];

    let stillPending = 1;
    await withTransaction(async (client) => {
      // Approve this step
      await client.query(`
        UPDATE treasury_approval_steps SET
          status='approved', approved_at=NOW(), comments=$1, updated_at=NOW()
        WHERE id=$2
      `, [comments||null, step.id]);

      // Check if all steps approved
      const pendingResult = await client.query(`
        SELECT COUNT(*) as pending FROM treasury_approval_steps
        WHERE request_id=$1 AND status='pending'
      `, [po.approval_request_id]);

      stillPending = parseInt(pendingResult.rows[0].pending);

      if (stillPending === 0) {
        await client.query(`
          UPDATE treasury_approval_requests SET status='approved', updated_at=NOW()
          WHERE id=$1`, [po.approval_request_id]);
        await client.query(`
          UPDATE internal_purchase_orders SET
            status='approved', approved_at=NOW(), approved_by=$1,
            approved_amount=total_amount, remaining_amount=total_amount,
            updated_at=NOW()
          WHERE id=$2`, [req.user.id, poId]);
      } else {
        await client.query(`
          UPDATE treasury_approval_requests SET
            current_level=$1, updated_at=NOW()
          WHERE id=$2`, [step.level_number + 1, po.approval_request_id]);
      }
    });

    const updatedPO = await getIPOAccess(poId, req.user.id, getEffectiveRoles(req.user));
    return res.json({ success:true, data: updatedPO.po,
      message: stillPending === 0 ? 'PO fully approved!' : `Level ${step.level_number} approved. Waiting for next approver.`
    });
  } catch(e) { next(e); }
});

// GET /api/internal-pos/:id/ap-bills — AP Bills linked to this PO
router.get('/:id/ap-bills', async (req, res, next) => {
  try {
    const poId = parseInt(req.params.id);
    const access = await getIPOAccess(poId, req.user.id, getEffectiveRoles(req.user));
    if (access.error) return res.status(404).json({ success: false, error: access.error });

    const result = await query(`
      SELECT b.*,
        v.name AS vendor_name,
        CONCAT(u.first_name,' ',u.last_name) AS created_by_name
      FROM ap_bills b
      LEFT JOIN clients v  ON v.id = b.vendor_id
      LEFT JOIN users u    ON u.id = b.created_by
      WHERE b.internal_po_id = $1
      ORDER BY b.created_at DESC
    `, [poId]);

    // Calculate billed amount
    const billed = result.rows.reduce((s, b) => s + parseFloat(b.total_amount||0), 0);
    const po = access.po;

    return res.json({
      success: true,
      data: result.rows,
      summary: {
        total_billed:    billed,
        po_total:        parseFloat(po.total_amount||0),
        remaining:       parseFloat(po.total_amount||0) - billed,
        billed_pct:      po.total_amount > 0 ? Math.round((billed/parseFloat(po.total_amount))*100) : 0
      },
      metadata: { count: result.rows.length, generated_at: new Date().toISOString() }
    });
  } catch(e) { next(e); }
});
