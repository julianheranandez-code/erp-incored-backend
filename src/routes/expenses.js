'use strict';

/**
 * Expenses Routes v2 — Sprint 3B
 * ================================
 * Enhanced with:
 *   - expense_type (REIMBURSEMENT/CASH_ADVANCE/CORPORATE_CARD)
 *   - priority (LOW/MEDIUM/HIGH/URGENT)
 *   - Approval Engine V2 integration
 *   - Treasury Payment Request auto-creation
 *   - Treasury Categories (replaces hardcoded VALID_CATEGORIES)
 *   - Attachment required before submit
 *
 * Status lifecycle:
 *   draft → pending_approval → approved → payment_request_created → reimbursed
 *   CORPORATE_CARD: draft → pending_approval → approved (no payment request)
 */

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { getApprovalChain, resolveApprovers, getCompanyApprovalPolicy } = require('../lib/approval-engine');
const logger = require('../utils/logger');

router.use(verifyToken);

// ─── CONSTANTS ────────────────────────────────────────────────
const VALID_EXPENSE_TYPES = ['REIMBURSEMENT','CASH_ADVANCE','CORPORATE_CARD'];
const VALID_PRIORITIES    = ['LOW','MEDIUM','HIGH','URGENT'];

// ─── HELPERS ─────────────────────────────────────────────────
function getEffectiveRoles(user) {
  return user.roles?.length ? user.roles : user.role ? [user.role] : [];
}

async function assertCompanyAccess(req, res, companyId) {
  const roles = getEffectiveRoles(req.user);
  if (roles.includes('super_admin')) return true;
  const userCompanyId = parseInt(req.user.active_company_id || req.user.company_id);
  if (userCompanyId === parseInt(companyId)) return true;
  const access = await query(
    `SELECT 1 FROM user_company_access WHERE user_id=$1 AND company_id=$2 AND is_active=TRUE`,
    [req.user.id, parseInt(companyId)]
  );
  if (!access.rows[0]) {
    res.status(403).json({ success: false, error: 'company_access_denied' });
    return false;
  }
  return true;
}

// ─── GET /api/expenses/categories ────────────────────────────
// Returns treasury categories compatible with expenses (OUTFLOW types)
router.get('/categories', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id, name, category_type, cash_flow_class
      FROM treasury_transaction_categories
      WHERE is_active = TRUE
        AND category_type IN ('expense','financing','asset')
        AND module = 'treasury'
      ORDER BY category_type, name ASC
    `);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(error) { next(error); }
});

// ─── GET /api/expenses ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { company_id, project_id, status, employee_id,
            category_id, expense_type, priority, date_from, date_to,
            page = 1, limit = 50 } = req.query;

    const roles = getEffectiveRoles(req.user);
    const isSuperAdmin = roles.includes('super_admin') || roles.includes('admin');
    const companyId = isSuperAdmin && company_id
      ? parseInt(company_id)
      : parseInt(req.user.active_company_id || req.user.company_id);

    const conditions = [`e.company_id = $1`];
    const values = [companyId];
    let idx = 2;

    if (!isSuperAdmin) { conditions.push(`e.created_by = $${idx++}`); values.push(req.user.id); }
    if (project_id)    { conditions.push(`e.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (status)        { conditions.push(`e.status = $${idx++}`); values.push(status); }
    if (employee_id)   { conditions.push(`e.employee_id = $${idx++}`); values.push(parseInt(employee_id)); }
    if (expense_type)  { conditions.push(`e.expense_type = $${idx++}`); values.push(expense_type); }
    if (priority)      { conditions.push(`e.priority = $${idx++}`); values.push(priority); }
    if (category_id)   { conditions.push(`e.category_id = $${idx++}`); values.push(parseInt(category_id)); }
    if (date_from)     { conditions.push(`e.expense_date >= $${idx++}`); values.push(date_from); }
    if (date_to)       { conditions.push(`e.expense_date <= $${idx++}`); values.push(date_to); }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const where = `WHERE ${conditions.join(' AND ')}`;

    const [rows, summary] = await Promise.all([
      query(`
        SELECT e.*,
          CONCAT(u.first_name,' ',u.last_name) AS employee_name,
          p.name AS project_name,
          tc.name AS category_name, tc.category_type
        FROM expenses e
        LEFT JOIN users u ON u.id = e.created_by
        LEFT JOIN projects p ON p.id = e.project_id
        LEFT JOIN treasury_transaction_categories tc ON tc.id = e.category_id
        ${where}
        ORDER BY e.created_at DESC
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, parseInt(limit), offset]),
      query(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(amount), 0) AS total_amount,
          COALESCE(SUM(amount) FILTER (WHERE status = 'reimbursed'), 0) AS total_reimbursed,
          COALESCE(SUM(amount) FILTER (WHERE status IN ('pending_approval','submitted','ops_approved','pm_approved','finance_approved')), 0) AS pending_reimbursement,
          COALESCE(SUM(amount) FILTER (WHERE status = 'payment_request_created'), 0) AS in_treasury
        FROM expenses e ${where}
      `, values)
    ]);

    res.json({ success: true, count: rows.rows.length,
      total: parseInt(summary.rows[0].total),
      summary: summary.rows[0], data: rows.rows });
  } catch(error) { next(error); }
});

// ─── GET /api/expenses/:id ────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT e.*,
        CONCAT(u.first_name,' ',u.last_name) AS employee_name,
        p.name AS project_name, p.code AS project_code,
        tc.name AS category_name, tc.category_type
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      LEFT JOIN projects p ON p.id = e.project_id
      LEFT JOIN treasury_transaction_categories tc ON tc.id = e.category_id
      WHERE e.id = $1
    `, [parseInt(req.params.id)]);

    if (!result.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const exp = result.rows[0];
    const roles = getEffectiveRoles(req.user);
    if (!roles.includes('super_admin') && !roles.includes('admin') &&
        exp.created_by !== req.user.id)
      return res.status(403).json({ success: false, error: 'forbidden' });

    res.json({ success: true, data: exp });
  } catch(error) { next(error); }
});

// ─── POST /api/expenses ───────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      company_id, project_id, employee_id, category_id,
      description, amount, tax_amount = 0, currency = 'MXN',
      exchange_rate = 1, expense_date, reimbursable = true,
      attachment_url, receipt_url, cfdi_uuid, notes,
      expense_type = 'REIMBURSEMENT', priority = 'MEDIUM'
    } = req.body;

    if (!company_id || !category_id || !description || !amount || !expense_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, category_id, description, amount, expense_date' });

    if (!await assertCompanyAccess(req, res, company_id)) return;

    if (expense_type && !VALID_EXPENSE_TYPES.includes(expense_type))
      return res.status(400).json({ success: false, error: 'invalid_expense_type',
        message: `expense_type must be: ${VALID_EXPENSE_TYPES.join(', ')}` });

    if (priority && !VALID_PRIORITIES.includes(priority))
      return res.status(400).json({ success: false, error: 'invalid_priority' });

    const result = await query(`
      INSERT INTO expenses (
        company_id, project_id, employee_id, category_id, description,
        amount, tax_amount, currency, exchange_rate, expense_date,
        reimbursable, attachment_url, receipt_url, cfdi_uuid, notes,
        expense_type, priority, status, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'draft',$18)
      RETURNING *
    `, [parseInt(company_id), project_id ? parseInt(project_id) : null,
        employee_id ? parseInt(employee_id) : parseInt(req.user.id),
        category_id ? parseInt(category_id) : null, description, parseFloat(amount), parseFloat(tax_amount),
        currency, parseFloat(exchange_rate), expense_date,
        reimbursable, attachment_url||null, receipt_url||null,
        cfdi_uuid||null, notes||null, expense_type, priority, req.user.id]);

    writeAudit({
      userId: req.user.id, action: 'expense_created',
      entityType: 'expenses', entityId: String(result.rows[0].id),
      companyId: parseInt(company_id),
      newValues: { amount, expense_type, priority, category_id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Expense created.', data: result.rows[0] });
  } catch(error) { next(error); }
});

// ─── PUT /api/expenses/:id ────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await query(`SELECT * FROM expenses WHERE id=$1`, [id]);
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const exp = existing.rows[0];
    if (exp.created_by !== req.user.id && !getEffectiveRoles(req.user).includes('admin'))
      return res.status(403).json({ success: false, error: 'forbidden' });

    if (!['draft','rejected'].includes(exp.status))
      return res.status(400).json({ success: false, error: 'not_editable',
        message: `Cannot edit expense with status: ${exp.status}` });

    const { category_id, description, amount, tax_amount, expense_date,
            reimbursable, attachment_url, receipt_url, notes,
            expense_type, priority } = req.body;

    if (expense_type && !VALID_EXPENSE_TYPES.includes(expense_type))
      return res.status(400).json({ success: false, error: 'invalid_expense_type' });
    if (priority && !VALID_PRIORITIES.includes(priority))
      return res.status(400).json({ success: false, error: 'invalid_priority' });

    const result = await query(`
      UPDATE expenses SET
        category_id    = COALESCE($1::integer, category_id),
        description    = COALESCE($2, description),
        amount         = COALESCE($3, amount),
        tax_amount     = COALESCE($4, tax_amount),
        expense_date   = COALESCE($5, expense_date),
        reimbursable   = COALESCE($6::boolean, reimbursable),
        attachment_url = COALESCE($7, attachment_url),
        receipt_url    = COALESCE($8, receipt_url),
        notes          = COALESCE($9, notes),
        expense_type   = COALESCE($10, expense_type),
        priority       = COALESCE($11, priority),
        updated_at     = NOW()
      WHERE id=$12 RETURNING *
    `, [category_id ? parseInt(category_id) : null, description||null, amount ? parseFloat(amount) : null,
        tax_amount ? parseFloat(tax_amount) : null, expense_date||null,
        reimbursable !== undefined ? reimbursable : null,
        attachment_url||null, receipt_url||null, notes||null,
        expense_type||null, priority||null, id]);

    res.json({ success: true, message: 'Expense updated.', data: result.rows[0] });
  } catch(error) { next(error); }
});

// ─── POST /api/expenses/:id/submit ───────────────────────────
router.post('/:id/submit', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await query(`SELECT * FROM expenses WHERE id=$1`, [id]);
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const exp = existing.rows[0];

    if (!['draft','rejected'].includes(exp.status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Only draft expenses can be submitted. Current: ${exp.status}` });

    // Attachment required before submit
    if (!exp.attachment_url && !exp.receipt_url)
      return res.status(400).json({ success: false, error: 'attachment_required',
        message: 'At least one attachment (receipt or document) is required before submitting.' });

    // Fetch company approval policy
    const approvalPolicy = await getCompanyApprovalPolicy(exp.company_id);

    // Get approval chain from engine
    let chain;
    try {
      chain = getApprovalChain('EXPENSE', exp.amount, approvalPolicy);
    } catch(err) {
      return res.status(400).json({ success: false, error: 'approval_chain_error',
        message: err.message });
    }

    if (!chain || chain.length === 0)
      return res.status(500).json({ success: false, error: 'approval_chain_missing' });

    // Resolve specific users
    const { resolved, missing } = await resolveApprovers(exp.company_id, chain);
    if (missing.length > 0)
      return res.status(400).json({ success: false, error: 'missing_approver_assignments',
        message: `No approver assigned for roles: ${missing.join(', ')}`,
        missing_roles: missing });

    const finalLevel = resolved.length;
    let approvalRequestId = null;

    await withTransaction(async (client) => {
      // Create approval request
      const approvalResult = await client.query(`
        INSERT INTO treasury_approval_requests
          (company_id, approval_type, entity_type, entity_id, amount, currency,
           status, requested_by, current_level, final_level, notes)
        VALUES ($1,'EXPENSE','EXPENSE',$2,$3,$4,'pending',$5,1,$6,$7)
        RETURNING id
      `, [exp.company_id, String(id), exp.amount, exp.currency || 'MXN',
          req.user.id, finalLevel, `Expense #${id}: ${exp.description}`]);

      approvalRequestId = approvalResult.rows[0].id;

      // Create approval steps with assigned users
      for (const step of resolved) {
        await client.query(`
          INSERT INTO treasury_approval_steps
            (request_id, level_number, approver_role, approver_user_id, status)
          VALUES ($1,$2,$3,$4,'pending')
        `, [approvalRequestId, step.level, step.role, step.user_id]);
      }

      // Update expense status
      await client.query(`
        UPDATE expenses SET
          status = 'pending_approval',
          approval_request_id = $1,
          submitted_at = NOW(),
          updated_at = NOW()
        WHERE id = $2
      `, [approvalRequestId, id]);
    });

    writeAudit({
      userId: req.user.id, action: 'expense_submitted',
      entityType: 'expenses', entityId: String(id),
      companyId: exp.company_id,
      newValues: { status: 'pending_approval', approval_request_id: approvalRequestId,
                   approval_policy: approvalPolicy, levels: finalLevel },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(`[EXPENSES] submitted: id=${id} approval=${approvalRequestId} policy=${approvalPolicy}`);
    res.json({ success: true, message: 'Expense submitted for approval.',
      data: { expense_id: id, approval_request_id: approvalRequestId,
              approval_chain: resolved.map(s => ({ level: s.level, role: s.role, approver: s.user_name })) }
    });
  } catch(error) { next(error); }
});

// ─── POST /api/expenses/:id/reject ───────────────────────────
router.post('/:id/reject', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    if (!reason)
      return res.status(400).json({ success: false, error: 'reason_required' });

    const existing = await query(`SELECT * FROM expenses WHERE id=$1`, [id]);
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    if (!['pending_approval','submitted','ops_approved','pm_approved','finance_approved']
        .includes(existing.rows[0].status))
      return res.status(400).json({ success: false, error: 'invalid_status' });

    await query(`
      UPDATE expenses SET status='rejected', rejection_reason=$1, updated_at=NOW()
      WHERE id=$2
    `, [reason, id]);

    writeAudit({
      userId: req.user.id, action: 'expense_rejected',
      entityType: 'expenses', entityId: String(id),
      companyId: existing.rows[0].company_id,
      newValues: { reason },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Expense rejected.' });
  } catch(error) { next(error); }
});

// ─── POST /api/expenses/:id/reimburse ────────────────────────
router.post('/:id/reimburse', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const roles = getEffectiveRoles(req.user);
    if (!roles.includes('super_admin') && !roles.includes('admin'))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const existing = await query(`SELECT * FROM expenses WHERE id=$1`, [id]);
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    // Can reimburse from payment_request_created OR approved (legacy)
    if (!['payment_request_created','approved'].includes(existing.rows[0].status))
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: 'Expense must be payment_request_created or approved to reimburse.' });

    const result = await query(`
      UPDATE expenses SET
        status = 'reimbursed', reimbursed_at = NOW(), reimbursed_by = $1, updated_at = NOW()
      WHERE id = $2 RETURNING *
    `, [req.user.id, id]);

    writeAudit({
      userId: req.user.id, action: 'expense_reimbursed',
      entityType: 'expenses', entityId: String(id),
      companyId: existing.rows[0].company_id,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Expense reimbursed.', data: result.rows[0] });
  } catch(error) { next(error); }
});

// ─── POST /api/expenses/:id/cancel ───────────────────────────
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    if (!reason)
      return res.status(400).json({ success: false, error: 'reason_required' });

    const existing = await query(`SELECT * FROM expenses WHERE id=$1`, [id]);
    if (!existing.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const exp = existing.rows[0];
    const roles = getEffectiveRoles(req.user);
    if (exp.created_by !== req.user.id && !roles.includes('super_admin'))
      return res.status(403).json({ success: false, error: 'cancel_denied' });

    if (['reimbursed','cancelled'].includes(exp.status))
      return res.status(400).json({ success: false, error: 'invalid_status' });

    await query(`
      UPDATE expenses SET status='cancelled', rejection_reason=$1, updated_at=NOW()
      WHERE id=$2
    `, [reason, id]);

    res.json({ success: true, message: 'Expense cancelled.' });
  } catch(error) { next(error); }
});

module.exports = router;
