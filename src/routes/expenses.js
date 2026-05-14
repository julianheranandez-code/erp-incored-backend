'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { queueRefresh } = require('../services/financeRefresh');
const logger = require('../utils/logger');

router.use(verifyToken);

// ─── VALID CATEGORIES ─────────────────────────────────────────
const VALID_CATEGORIES = [
  'fuel','tolls','meals','hotels','rentals',
  'subcontractor_incidentals','tools','small_materials',
  'vehicle_maintenance','vehicle_fines','vehicle_registration',
  'flights','per_diem','parking','office_supplies','permits',
  'safety_equipment','internet_services','temporary_labor','petty_cash',
  'crew_rental','maintenance','other'
];

// ─── CATEGORY ALIASES ─────────────────────────────────────────
const CATEGORY_ALIASES = {
  'hotel': 'hotels',
  'meal':  'meals',
  'toll':  'tolls',
  'gas':   'fuel',
  'gasoline': 'fuel',
  'lodging':  'hotels',
  'food':     'meals',
  'transport':'fuel'
};

function normalizeCategory(raw) {
  if (!raw) return null;
  const lower = String(raw).toLowerCase().trim();
  return CATEGORY_ALIASES[lower] || lower;
}

// ─── ISOLATION HELPERS ────────────────────────────────────────
function getAuthorizedCompanyId(user, requestedCompanyId) {
  if (user.role === 'admin') return requestedCompanyId ? parseInt(requestedCompanyId) : null;
  return parseInt(user.company_id);
}

// ─── GET /api/expenses/categories ────────────────────────────
router.get('/categories', async (req, res) => {
  res.json({ success: true, data: VALID_CATEGORIES });
});

// ─── GET /api/expenses ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, sort = 'expense_date', order = 'DESC',
            project_id, status, employee_id, category, date_from, date_to } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`e.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (project_id)          { conditions.push(`e.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (status)              { conditions.push(`e.status = $${idx++}`);     values.push(status); }
    if (employee_id)         { conditions.push(`e.employee_id = $${idx++}`); values.push(parseInt(employee_id)); }
    if (category)            { conditions.push(`e.category = $${idx++}`);   values.push(category); }
    if (date_from)           { conditions.push(`e.expense_date >= $${idx++}`); values.push(date_from); }
    if (date_to)             { conditions.push(`e.expense_date <= $${idx++}`); values.push(date_to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const validSorts = ['expense_date','amount','status','category','created_at'];
    const sortField = validSorts.includes(sort) ? sort : 'expense_date';
    const sortOrder = order === 'ASC' ? 'ASC' : 'DESC';

    const [expenses, summary, total] = await Promise.all([
      query(`
        SELECT e.*,
          emp.name AS employee_name,
          p.name AS project_name, p.code AS project_code,
          co.name AS company_name,
          CONCAT(u.first_name,' ',u.last_name) AS created_by_name
        FROM expenses e
        LEFT JOIN employees emp ON emp.id = e.employee_id
        LEFT JOIN projects p    ON p.id = e.project_id
        LEFT JOIN companies co  ON co.id = e.company_id
        LEFT JOIN users u       ON u.id = e.created_by
        ${where}
        ORDER BY e.${sortField} ${sortOrder}
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, parseInt(limit), offset]),

      query(`
        SELECT
          COUNT(*) AS total_expenses,
          COALESCE(SUM(amount), 0) AS total_amount,
          COALESCE(SUM(amount) FILTER (WHERE status = 'reimbursed'), 0) AS total_reimbursed,
          COALESCE(SUM(amount) FILTER (WHERE status IN ('submitted','ops_approved','pm_approved','finance_approved')), 0) AS pending_reimbursement,
          COALESCE(SUM(amount) FILTER (WHERE reimbursable = TRUE AND status NOT IN ('reimbursed','rejected','cancelled')), 0) AS total_reimbursable
        FROM expenses e ${where}
      `, values),

      query(`SELECT COUNT(*) AS total FROM expenses e ${where}`, values)
    ]);

    res.json({
      success: true,
      data: {
        expenses: expenses.rows,
        summary: summary.rows[0],
        pagination: {
          total: parseInt(total.rows[0].total),
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(parseInt(total.rows[0].total) / parseInt(limit))
        }
      }
    });
  } catch (error) { next(error); }
});

// ─── GET /api/expenses/:id ────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const result = await query(`
      SELECT e.*,
        emp.name AS employee_name,
        p.name AS project_name, p.code AS project_code,
        co.name AS company_name, co.short_code AS company_code,
        CONCAT(u.first_name,' ',u.last_name) AS created_by_name
      FROM expenses e
      LEFT JOIN employees emp ON emp.id = e.employee_id
      LEFT JOIN projects p    ON p.id = e.project_id
      LEFT JOIN companies co  ON co.id = e.company_id
      LEFT JOIN users u       ON u.id = e.created_by
      WHERE e.id = $1
    `, [id]);

    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Expense not found.' });

    // Company isolation
    if (req.user.role !== 'admin' && result.rows[0].company_id !== parseInt(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /api/expenses ───────────────────────────────────────
// Supports BOTH:
// 1. Single operational expense (fast field capture)
// 2. Full expense report (future)
router.post('/', async (req, res, next) => {
  const startTime = Date.now();
  logger.info('[Expenses] POST / → request received');

  try {
    const {
      company_id, project_id, employee_id,
      category, description, amount,
      currency = 'MXN', exchange_rate = 1,
      expense_date, tax_amount = 0,
      reimbursable = true,
      attachment_url, receipt_url, cfdi_uuid, notes,
      // Legacy report fields (optional — backward compat)
      title, period_start, period_end
    } = req.body;

    // Minimal required fields for single expense
    const missing = [];
    if (!company_id)  missing.push('company_id');
    if (!employee_id) missing.push('employee_id');
    if (!category)    missing.push('category');
    if (!description) missing.push('description');
    if (!amount)      missing.push('amount');

    if (missing.length > 0) {
      return res.status(400).json({
        success: false, error: 'validation_error',
        message: `Missing required fields: ${missing.join(', ')}`,
        missing_fields: missing,
        note: 'project_id is optional for non-project operational expenses'
      });
    }

    // Normalize + validate category
    const normalizedCategory = normalizeCategory(category);
    if (!normalizedCategory || !VALID_CATEGORIES.includes(normalizedCategory)) {
      return res.status(400).json({
        success: false, error: 'invalid_category',
        message: `Invalid category: "${category}"`,
        received: category,
        normalized: normalizedCategory,
        accepted: VALID_CATEGORIES
      });
    }

    // Company isolation
    if (req.user.role !== 'admin' && parseInt(company_id) !== parseInt(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Company access denied.' });
    }

    logger.info('[Expenses] inserting single expense');

    const result = await query(`
      INSERT INTO expenses (
        company_id, project_id, employee_id,
        category, description, amount, tax_amount,
        currency, exchange_rate, expense_date,
        reimbursable, attachment_url, receipt_url, cfdi_uuid, notes,
        status, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'draft',$16)
      RETURNING *
    `, [
      parseInt(company_id),
      project_id ? parseInt(project_id) : null,
      parseInt(employee_id),
      normalizedCategory, description,
      parseFloat(amount), parseFloat(tax_amount),
      currency, parseFloat(exchange_rate),
      expense_date || new Date().toISOString().split('T')[0],
      reimbursable,
      attachment_url || null, receipt_url || null,
      cfdi_uuid || null, notes || null,
      req.user.id
    ]);

    logger.info(`[Expenses] inserted id=${result.rows[0].id} in ${Date.now()-startTime}ms`);

    // Fire and forget
    writeAudit({
      userId: req.user.id, action: 'expense_created',
      entityType: 'expenses', entityId: result.rows[0].id,
      companyId: parseInt(company_id),
      newValues: { category: normalizedCategory, amount, description },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    if (project_id) {
      setImmediate(() => queueRefresh(parseInt(project_id), 'expense.create'));
    }

    res.status(201).json({ success: true, message: 'Expense created.', data: result.rows[0] });
  } catch (error) {
    logger.error('[Expenses] POST error:', { message: error.message, code: error.code });
    next(error);
  }
});

// ─── PUT /api/expenses/:id ────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await query('SELECT * FROM expenses WHERE id = $1', [id]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Expense not found.' });

    const exp = existing.rows[0];
    if (req.user.role !== 'admin' && exp.company_id !== parseInt(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }
    if (!['draft','rejected'].includes(exp.status)) {
      return res.status(400).json({ success: false, error: 'not_editable', message: `Cannot edit expense with status: ${exp.status}` });
    }

    const { category, description, amount, tax_amount, expense_date,
            reimbursable, attachment_url, receipt_url, notes } = req.body;

    const normalizedCategory = category ? normalizeCategory(category) : null;
    if (normalizedCategory && !VALID_CATEGORIES.includes(normalizedCategory)) {
      return res.status(400).json({ success: false, error: 'invalid_category', message: `Invalid category: "${category}"`, accepted: VALID_CATEGORIES });
    }

    const result = await query(`
      UPDATE expenses SET
        category       = COALESCE($1, category),
        description    = COALESCE($2, description),
        amount         = COALESCE($3::numeric, amount),
        tax_amount     = COALESCE($4::numeric, tax_amount),
        expense_date   = COALESCE($5, expense_date),
        reimbursable   = COALESCE($6::boolean, reimbursable),
        attachment_url = COALESCE($7, attachment_url),
        receipt_url    = COALESCE($8, receipt_url),
        notes          = COALESCE($9, notes),
        updated_at     = NOW()
      WHERE id = $10 RETURNING *
    `, [
      normalizedCategory || null, description || null,
      amount || null, tax_amount || null,
      expense_date || null, reimbursable !== undefined ? reimbursable : null,
      attachment_url || null, receipt_url || null,
      notes || null, id
    ]);

    writeAudit({
      userId: req.user.id, action: 'expense_updated',
      entityType: 'expenses', entityId: id,
      companyId: exp.company_id,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    res.json({ success: true, message: 'Expense updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /api/expenses/:id/submit ───────────────────────────
router.post('/:id/submit', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await query('SELECT * FROM expenses WHERE id = $1', [id]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Expense not found.' });

    if (!['draft','rejected'].includes(existing.rows[0].status)) {
      return res.status(400).json({ success: false, error: 'invalid_status', message: 'Only draft expenses can be submitted.' });
    }

    const result = await query(`
      UPDATE expenses SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
      WHERE id = $1 RETURNING *
    `, [id]);

    writeAudit({
      userId: req.user.id, action: 'expense_submitted',
      entityType: 'expenses', entityId: id,
      companyId: existing.rows[0].company_id,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    res.json({ success: true, message: 'Expense submitted for approval.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /api/expenses/:id/approve ──────────────────────────
router.post('/:id/approve', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await query('SELECT * FROM expenses WHERE id = $1', [id]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Expense not found.' });

    const { status } = existing.rows[0];
    const role = req.user.role;
    const { notes } = req.body;

    let nextStatus, levelCol;
    if (status === 'submitted' && ['admin','supervisor','manager'].includes(role)) {
      nextStatus = 'ops_approved'; levelCol = 'ops';
    } else if (status === 'ops_approved' && ['admin','project_manager','manager'].includes(role)) {
      nextStatus = 'pm_approved'; levelCol = 'pm';
    } else if (status === 'pm_approved' && ['admin','finance'].includes(role)) {
      nextStatus = 'finance_approved'; levelCol = 'finance';
    } else {
      return res.status(400).json({
        success: false, error: 'invalid_approval',
        message: `Cannot approve expense with status '${status}' as role '${role}'`
      });
    }

    const result = await query(`
      UPDATE expenses SET
        status = $1,
        ${levelCol}_approved_by = $2,
        ${levelCol}_approved_at = NOW(),
        updated_at = NOW()
      WHERE id = $3 RETURNING *
    `, [nextStatus, req.user.id, id]);

    writeAudit({
      userId: req.user.id, action: `expense_${levelCol}_approved`,
      entityType: 'expenses', entityId: id,
      companyId: existing.rows[0].company_id,
      oldValues: { status }, newValues: { status: nextStatus },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    res.json({ success: true, message: `Expense ${nextStatus}.`, data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /api/expenses/:id/reject ───────────────────────────
router.post('/:id/reject', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, error: 'validation_error', message: 'Rejection reason required.' });

    const existing = await query('SELECT * FROM expenses WHERE id = $1', [id]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Expense not found.' });

    const result = await query(`
      UPDATE expenses SET status = 'rejected', rejection_reason = $1, updated_at = NOW()
      WHERE id = $2 RETURNING *
    `, [reason, id]);

    writeAudit({
      userId: req.user.id, action: 'expense_rejected',
      entityType: 'expenses', entityId: id,
      companyId: existing.rows[0].company_id,
      newValues: { reason },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    res.json({ success: true, message: 'Expense rejected.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /api/expenses/:id/reimburse ────────────────────────
router.post('/:id/reimburse', async (req, res, next) => {
  const startTime = Date.now();
  try {
    if (!['admin','finance'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Only finance can process reimbursements.' });
    }

    const id = parseInt(req.params.id);
    const existing = await query('SELECT * FROM expenses WHERE id = $1', [id]);
    if (!existing.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Expense not found.' });

    if (existing.rows[0].status !== 'finance_approved') {
      return res.status(400).json({ success: false, error: 'not_approved', message: 'Expense must be finance_approved before reimbursement.' });
    }

    const result = await query(`
      UPDATE expenses SET
        status = 'reimbursed',
        reimbursed_at = NOW(),
        reimbursed_by = $1,
        updated_at = NOW()
      WHERE id = $2 RETURNING *
    `, [req.user.id, id]);

    writeAudit({
      userId: req.user.id, action: 'expense_reimbursed',
      entityType: 'expenses', entityId: id,
      companyId: existing.rows[0].company_id,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    if (existing.rows[0].project_id) {
      setImmediate(() => queueRefresh(existing.rows[0].project_id, 'expense.reimburse'));
    }

    logger.info(`[Expenses] reimbursed in ${Date.now()-startTime}ms`);
    res.json({ success: true, message: 'Expense reimbursed.', data: result.rows[0] });
  } catch (error) { next(error); }
});

module.exports = router;
