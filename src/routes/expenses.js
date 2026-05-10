'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { queueRefresh } = require('../services/financeRefresh');
const logger = require('../utils/logger');

router.use(verifyToken);

// ─── HELPERS ─────────────────────────────────────────────────
function getAuthorizedCompanyId(user, requestedCompanyId) {
  if (user.role === 'admin') return requestedCompanyId ? parseInt(requestedCompanyId) : null;
  return parseInt(user.company_id);
}

async function assertReportAccess(reportId, user) {
  const result = await query(
    'SELECT id, company_id, employee_id, project_id, status FROM expense_reports WHERE id = $1',
    [reportId]
  );
  if (!result.rows[0]) return { error: 'not_found', message: 'Expense report not found.' };
  if (user.role !== 'admin' && result.rows[0].company_id !== parseInt(user.company_id)) {
    return { error: 'forbidden', message: 'Access denied to this expense report.' };
  }
  return { report: result.rows[0] };
}

// ─── GET /api/expenses ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, sort = 'created_at', order = 'DESC',
            project_id, status, employee_id, date_from, date_to } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`r.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (project_id)          { conditions.push(`r.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (status)              { conditions.push(`r.status = $${idx++}`);     values.push(status); }
    if (employee_id)         { conditions.push(`r.employee_id = $${idx++}`); values.push(parseInt(employee_id)); }
    if (date_from)           { conditions.push(`r.created_at >= $${idx++}`); values.push(date_from); }
    if (date_to)             { conditions.push(`r.created_at <= $${idx++}`); values.push(date_to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const validSorts = ['created_at','total_amount','status'];
    const sortField = validSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'ASC' ? 'ASC' : 'DESC';

    const [reports, summary, alerts, total] = await Promise.all([

      query(`
        SELECT r.*,
          e.name AS employee_name,
          p.name AS project_name, p.code AS project_code,
          co.name AS company_name
        FROM expense_reports r
        LEFT JOIN employees e  ON e.id = r.employee_id
        LEFT JOIN projects p   ON p.id = r.project_id
        LEFT JOIN companies co ON co.id = r.company_id
        ${where}
        ORDER BY r.${sortField} ${sortOrder}
        LIMIT $${idx} OFFSET $${idx + 1}
      `, [...values, parseInt(limit), offset]),

      // Summary
      query(`
        SELECT
          COUNT(*) AS total_reports,
          COALESCE(SUM(total_amount), 0) AS total_submitted,
          COALESCE(SUM(total_approved), 0) AS total_approved,
          COALESCE(SUM(total_paid), 0) AS total_reimbursed,
          COALESCE(SUM(total_approved - total_paid), 0) AS pending_reimbursement
        FROM expense_reports r ${where}
      `, values),

      // Alerts
      query(`
        SELECT r.id, r.title, r.total_amount, r.status,
          e.name AS employee_name, p.name AS project_name,
          CASE
            WHEN r.total_amount > 50000 THEN 'large_expense'
            WHEN r.status IN ('finance_approved') AND r.total_paid = 0
              AND r.finance_approved_at < NOW() - INTERVAL '7 days' THEN 'overdue_reimbursement'
            ELSE NULL
          END AS alert_type
        FROM expense_reports r
        LEFT JOIN employees e ON e.id = r.employee_id
        LEFT JOIN projects p  ON p.id = r.project_id
        ${where}
        HAVING CASE
            WHEN r.total_amount > 50000 THEN 'large_expense'
            WHEN r.status IN ('finance_approved') AND r.total_paid = 0
              AND r.finance_approved_at < NOW() - INTERVAL '7 days' THEN 'overdue_reimbursement'
            ELSE NULL
          END IS NOT NULL
        LIMIT 10
      `, values).catch(() => ({ rows: [] })),

      query(`SELECT COUNT(*) AS total FROM expense_reports r ${where}`, values)
    ]);

    res.json({
      success: true,
      data: {
        reports: reports.rows,
        summary: summary.rows[0],
        alerts: alerts.rows || [],
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

// ─── GET /api/expenses/categories ────────────────────────────
router.get('/categories', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM expense_categories WHERE is_active = TRUE ORDER BY name ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/expenses/:id ────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const access = await assertReportAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    const [report, items, attachments, approvals, reimbursements] = await Promise.all([
      query(`
        SELECT r.*,
          e.name AS employee_name, e.company_id AS employee_company_id,
          p.name AS project_name, p.code AS project_code,
          co.name AS company_name, co.short_code AS company_code
        FROM expense_reports r
        LEFT JOIN employees e  ON e.id = r.employee_id
        LEFT JOIN projects p   ON p.id = r.project_id
        LEFT JOIN companies co ON co.id = r.company_id
        WHERE r.id = $1
      `, [id]),
      query(`
        SELECT i.*, ec.name AS category_name
        FROM expense_items i
        LEFT JOIN expense_categories ec ON ec.code = i.category_code
        WHERE i.report_id = $1 ORDER BY i.expense_date ASC
      `, [id]),
      query('SELECT * FROM expense_attachments WHERE report_id = $1 ORDER BY created_at DESC', [id]),
      query(`
        SELECT ea.*, CONCAT(u.first_name,' ',u.last_name) AS approved_by_name
        FROM expense_approvals ea
        LEFT JOIN users u ON u.id = ea.approved_by
        WHERE ea.report_id = $1 ORDER BY ea.level ASC
      `, [id]),
      query('SELECT * FROM expense_reimbursements WHERE report_id = $1 ORDER BY created_at DESC', [id])
    ]);

    res.json({
      success: true,
      data: {
        report: report.rows[0],
        items: items.rows,
        attachments: attachments.rows,
        approvals: approvals.rows,
        reimbursements: reimbursements.rows
      }
    });
  } catch (error) { next(error); }
});

// ─── POST /api/expenses ───────────────────────────────────────
router.post('/', async (req, res, next) => {
  const startTime = Date.now();
  logger.info('[Expenses] POST / → request received');

  try {
    const {
      company_id, project_id, employee_id,
      title, currency = 'MXN',
      period_start, period_end, notes,
      items = []
    } = req.body;

    if (!company_id || !project_id || !employee_id || !title || !period_start || !period_end) {
      return res.status(400).json({
        success: false, error: 'validation_error',
        message: 'Required: company_id, project_id, employee_id, title, period_start, period_end'
      });
    }

    if (req.user.role !== 'admin' && parseInt(company_id) !== parseInt(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Company access denied.' });
    }

    // Calculate total from items
    const total_amount = items.reduce((sum, item) =>
      sum + (parseFloat(item.quantity || 1) * parseFloat(item.amount || 0)), 0);

    logger.info('[Expenses] transaction starting');

    const result = await withTransaction(async (client) => {

      // 1. Create report
      const report = await client.query(`
        INSERT INTO expense_reports (
          company_id, project_id, employee_id,
          title, currency, total_amount,
          period_start, period_end, notes,
          status, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',NOW(),NOW())
        RETURNING *
      `, [parseInt(company_id), parseInt(project_id), parseInt(employee_id),
          title, currency, total_amount,
          period_start, period_end, notes || null]);

      logger.info(`[Expenses] report inserted id=${report.rows[0].id}`);

      // 2. Insert items
      if (items.length > 0) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          await client.query(`
            INSERT INTO expense_items (
              report_id, category, category_code, description,
              amount, currency, exchange_rate, expense_date,
              receipt_url, cfdi_uuid
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          `, [
            report.rows[0].id,
            item.category || item.category_code || 'other',
            item.category_code || item.category || 'other',
            item.description,
            parseFloat(item.amount),
            item.currency || currency,
            parseFloat(item.exchange_rate || 1),
            item.expense_date || period_start,
            item.receipt_url || null,
            item.cfdi_uuid || null
          ]);
        }
        logger.info(`[Expenses] ${items.length} items inserted`);
      }

      return report.rows[0];
    });

    logger.info(`[Expenses] transaction committed in ${Date.now() - startTime}ms`);

    // Fire and forget
    writeAudit({
      userId: req.user.id, action: 'expense_report_created',
      entityType: 'expense_reports', entityId: result.id,
      companyId: result.company_id, newValues: { title: result.title, total_amount: result.total_amount },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    setImmediate(() => queueRefresh(result.project_id, 'expense.create'));

    logger.info(`[Expenses] response sent in ${Date.now() - startTime}ms`);
    res.status(201).json({ success: true, message: 'Expense report created.', data: result });
  } catch (error) { next(error); }
});

// ─── PUT /api/expenses/:id ────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  const startTime = Date.now();
  try {
    const id = parseInt(req.params.id);
    const access = await assertReportAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    if (!['draft','ops_rejected','pm_rejected','finance_rejected'].includes(access.report.status)) {
      return res.status(400).json({
        success: false, error: 'not_editable',
        message: `Cannot edit report with status: ${access.report.status}`
      });
    }

    const { title, notes, period_start, period_end, items } = req.body;

    const result = await withTransaction(async (client) => {
      const updated = await client.query(`
        UPDATE expense_reports SET
          title        = COALESCE($1, title),
          notes        = COALESCE($2, notes),
          period_start = COALESCE($3, period_start),
          period_end   = COALESCE($4, period_end),
          updated_at   = NOW()
        WHERE id = $5 RETURNING *
      `, [title || null, notes || null, period_start || null, period_end || null, id]);

      if (items && items.length > 0) {
        await client.query('DELETE FROM expense_items WHERE report_id = $1', [id]);
        const total_amount = items.reduce((sum, item) =>
          sum + (parseFloat(item.quantity || 1) * parseFloat(item.amount || 0)), 0);
        for (const item of items) {
          await client.query(`
            INSERT INTO expense_items (
              report_id, category, category_code, description,
              amount, currency, exchange_rate, expense_date, receipt_url
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `, [id, item.category || 'other', item.category_code || 'other',
              item.description, parseFloat(item.amount),
              item.currency || 'MXN', parseFloat(item.exchange_rate || 1),
              item.expense_date, item.receipt_url || null]);
        }
        await client.query(
          'UPDATE expense_reports SET total_amount = $1 WHERE id = $2',
          [total_amount, id]
        );
      }

      return updated.rows[0];
    });

    writeAudit({
      userId: req.user.id, action: 'expense_report_updated',
      entityType: 'expense_reports', entityId: id,
      companyId: result.company_id,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    setImmediate(() => queueRefresh(result.project_id, 'expense.update'));

    res.json({ success: true, message: 'Expense report updated.', data: result });
  } catch (error) { next(error); }
});

// ─── POST /api/expenses/:id/approve ──────────────────────────
router.post('/:id/approve', async (req, res, next) => {
  const startTime = Date.now();
  logger.info('[Expenses] POST /:id/approve → request received');

  try {
    const id = parseInt(req.params.id);
    const access = await assertReportAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    const { notes, approved_amount } = req.body;
    const { status } = access.report;
    const role = req.user.role;

    // Determine next status based on current status and role
    let nextStatus, level, levelName;

    if (status === 'submitted' && ['admin','supervisor','manager'].includes(role)) {
      nextStatus = 'ops_approved'; level = 1; levelName = 'ops';
    } else if (status === 'ops_approved' && ['admin','project_manager','manager'].includes(role)) {
      nextStatus = 'pm_approved'; level = 2; levelName = 'pm';
    } else if (status === 'pm_approved' && ['admin','finance'].includes(role)) {
      nextStatus = 'finance_approved'; level = 3; levelName = 'finance';
    } else {
      return res.status(400).json({
        success: false, error: 'invalid_approval',
        message: `Cannot approve report with status '${status}' as role '${role}'`
      });
    }

    const approvedAmt = approved_amount
      ? parseFloat(approved_amount)
      : (await query('SELECT total_amount FROM expense_reports WHERE id = $1', [id])).rows[0].total_amount;

    const result = await withTransaction(async (client) => {
      // Update report status
      const updated = await client.query(`
        UPDATE expense_reports SET
          status = $1,
          total_approved = $2,
          ${levelName}_approved_by = $3,
          ${levelName}_approved_at = NOW(),
          ${levelName}_notes = $4,
          updated_at = NOW()
        WHERE id = $5 RETURNING *
      `, [nextStatus, approvedAmt, req.user.id, notes || null, id]);

      // Log approval
      await client.query(`
        INSERT INTO expense_approvals (report_id, level, level_name, action, approved_by, notes)
        VALUES ($1,$2,$3,'approved',$4,$5)
      `, [id, level, levelName, req.user.id, notes || null]);

      return updated.rows[0];
    });

    logger.info(`[Expenses] approved to ${nextStatus} in ${Date.now() - startTime}ms`);

    writeAudit({
      userId: req.user.id, action: `expense_${levelName}_approved`,
      entityType: 'expense_reports', entityId: id,
      companyId: result.company_id,
      oldValues: { status }, newValues: { status: nextStatus },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    setImmediate(() => queueRefresh(result.project_id, 'expense.approve'));

    res.json({ success: true, message: `Report ${nextStatus}.`, data: result });
  } catch (error) { next(error); }
});

// ─── POST /api/expenses/:id/reject ───────────────────────────
router.post('/:id/reject', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const access = await assertReportAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Rejection reason required.' });
    }

    const { status } = access.report;
    const role = req.user.role;

    let nextStatus, level, levelName;
    if (status === 'submitted' && ['admin','supervisor','manager'].includes(role)) {
      nextStatus = 'ops_rejected'; level = 1; levelName = 'ops';
    } else if (status === 'ops_approved' && ['admin','project_manager','manager'].includes(role)) {
      nextStatus = 'pm_rejected'; level = 2; levelName = 'pm';
    } else if (status === 'pm_approved' && ['admin','finance'].includes(role)) {
      nextStatus = 'finance_rejected'; level = 3; levelName = 'finance';
    } else {
      return res.status(400).json({ success: false, error: 'invalid_rejection', message: `Cannot reject report with status '${status}'` });
    }

    const result = await withTransaction(async (client) => {
      const updated = await client.query(`
        UPDATE expense_reports SET
          status = $1, rejection_reason = $2, updated_at = NOW()
        WHERE id = $3 RETURNING *
      `, [nextStatus, reason, id]);

      await client.query(`
        INSERT INTO expense_approvals (report_id, level, level_name, action, approved_by, notes)
        VALUES ($1,$2,$3,'rejected',$4,$5)
      `, [id, level, levelName, req.user.id, reason]);

      return updated.rows[0];
    });

    writeAudit({
      userId: req.user.id, action: `expense_${levelName}_rejected`,
      entityType: 'expense_reports', entityId: id,
      companyId: result.company_id,
      oldValues: { status }, newValues: { status: nextStatus, reason },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    res.json({ success: true, message: `Report rejected.`, data: result });
  } catch (error) { next(error); }
});

// ─── POST /api/expenses/:id/submit ───────────────────────────
router.post('/:id/submit', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const access = await assertReportAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    if (!['draft','ops_rejected','pm_rejected','finance_rejected'].includes(access.report.status)) {
      return res.status(400).json({ success: false, error: 'invalid_status', message: 'Only draft reports can be submitted.' });
    }

    // Verify has items
    const items = await query('SELECT COUNT(*) AS cnt FROM expense_items WHERE report_id = $1', [id]);
    if (parseInt(items.rows[0].cnt) === 0) {
      return res.status(400).json({ success: false, error: 'no_items', message: 'Cannot submit report with no expense items.' });
    }

    const result = await query(`
      UPDATE expense_reports SET
        status = 'submitted', submitted_at = NOW(), updated_at = NOW()
      WHERE id = $1 RETURNING *
    `, [id]);

    writeAudit({
      userId: req.user.id, action: 'expense_submitted',
      entityType: 'expense_reports', entityId: id,
      companyId: result.rows[0].company_id,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    res.json({ success: true, message: 'Report submitted for approval.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── POST /api/expenses/:id/reimburse ────────────────────────
router.post('/:id/reimburse', async (req, res, next) => {
  const startTime = Date.now();
  logger.info('[Expenses] POST /:id/reimburse → request received');

  try {
    const id = parseInt(req.params.id);

    if (!['admin','finance'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Only finance can process reimbursements.' });
    }

    const access = await assertReportAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    if (access.report.status !== 'finance_approved') {
      return res.status(400).json({ success: false, error: 'not_approved', message: 'Report must be finance_approved before reimbursement.' });
    }

    const { amount, payment_method, reference, payment_date, notes } = req.body;
    if (!amount || !payment_date) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: amount, payment_date' });
    }

    const report = await query('SELECT * FROM expense_reports WHERE id = $1', [id]);
    const r = report.rows[0];

    const result = await withTransaction(async (client) => {

      // 1. Create reimbursement record
      const reimb = await client.query(`
        INSERT INTO expense_reimbursements (
          report_id, company_id, project_id, employee_id,
          amount, currency, payment_method, reference, payment_date, notes, paid_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
      `, [id, r.company_id, r.project_id, r.employee_id,
          parseFloat(amount), r.currency,
          payment_method || null, reference || null,
          payment_date, notes || null, req.user.id]);

      // 2. Update report
      const newTotalPaid = parseFloat(r.total_paid) + parseFloat(amount);
      const newStatus = newTotalPaid >= parseFloat(r.total_approved) ? 'paid' : 'finance_approved';

      const updated = await client.query(`
        UPDATE expense_reports SET
          total_paid = $1, status = $2,
          paid_at = CASE WHEN $2 = 'paid' THEN NOW() ELSE paid_at END,
          paid_by = CASE WHEN $2 = 'paid' THEN $3::uuid ELSE paid_by END,
          updated_at = NOW()
        WHERE id = $4 RETURNING *
      `, [newTotalPaid, newStatus, req.user.id, id]);

      return { reimbursement: reimb.rows[0], report: updated.rows[0] };
    });

    logger.info(`[Expenses] reimbursement committed in ${Date.now() - startTime}ms`);

    writeAudit({
      userId: req.user.id, action: 'expense_reimbursed',
      entityType: 'expense_reports', entityId: id,
      companyId: r.company_id,
      newValues: { amount, payment_date, status: result.report.status },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Expenses] audit failed:', err.message));

    setImmediate(() => queueRefresh(r.project_id, 'expense.reimburse'));

    logger.info(`[Expenses] reimburse response sent in ${Date.now() - startTime}ms`);
    res.status(201).json({ success: true, message: 'Reimbursement processed.', data: result });
  } catch (error) { next(error); }
});

module.exports = router;
