'use strict';

const express = require('express');
const router = express.Router();

const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { authorize } = require('../middleware/authorization');
const { auditLog } = require('../middleware/audit');
const { exportProjectsReport, exportTransactionsReport, exportTimesheetReport } = require('../utils/excelExporter');
const { exportLimiter } = require('../middleware/rateLimit');

router.use(verifyToken, auditLog);

// Helper: get company ID respecting multi-company admin access
const getCompanyId = (req) => req.user.role === 'admin' ? (req.query.company_id || null) : req.user.company_id;

// ─── DASHBOARDS ───────────────────────────────────────────────────────────────

// GET /api/dashboards/executive
/**
 * @swagger
 * /dashboards/executive:
 *   get:
 *     summary: GET /dashboards/executive
 *     tags:
 *       - Reports
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/dashboards/executive', async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const cond = companyId ? `AND company_id = ${parseInt(companyId)}` : '';

    const [projects, tasks, finance, inventory] = await Promise.all([
      query(`SELECT
               COUNT(*) FILTER (WHERE status = 'executing') AS active_projects,
               COUNT(*) FILTER (WHERE status = 'completed') AS completed_projects,
               COUNT(*) FILTER (WHERE status = 'paused') AS paused_projects,
               AVG(progress_percent) AS avg_progress
             FROM projects WHERE 1=1 ${cond}`),
      query(`SELECT
               COUNT(*) FILTER (WHERE status NOT IN ('completada','cancelada')) AS open_tasks,
               COUNT(*) FILTER (WHERE priority = 'critica' AND status NOT IN ('completada','cancelada')) AS critical_tasks,
               COUNT(*) FILTER (WHERE due_date < NOW() AND status NOT IN ('completada','cancelada')) AS overdue_tasks
             FROM tasks t
             LEFT JOIN projects p ON p.id = t.project_id
             WHERE 1=1 ${companyId ? `AND (p.company_id = ${parseInt(companyId)} OR t.project_id IS NULL)` : ''}`),
      query(`SELECT
               COALESCE(SUM(amount) FILTER (WHERE type = 'ingreso'), 0) AS month_income,
               COALESCE(SUM(amount) FILTER (WHERE type = 'egreso'), 0)  AS month_expense
             FROM transactions
             WHERE DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', NOW())
             AND status != 'cancelada' ${cond}`),
      query(`SELECT COUNT(*) AS low_stock FROM inventory_materials
             WHERE quantity_stock <= quantity_min AND is_active = true ${cond}`),
    ]);

    res.json({
      success: true,
      data: {
        projects: projects.rows[0],
        tasks: tasks.rows[0],
        finance: finance.rows[0],
        alerts: {
          low_stock: parseInt(inventory.rows[0].low_stock),
          overdue_tasks: parseInt(tasks.rows[0].overdue_tasks),
          critical_tasks: parseInt(tasks.rows[0].critical_tasks),
        },
      },
    });
  } catch (error) { next(error); }
});

// GET /api/dashboards/operations
/**
 * @swagger
 * /dashboards/operations:
 *   get:
 *     summary: GET /dashboards/operations
 *     tags:
 *       - Reports
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/dashboards/operations', async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const cond = companyId ? `WHERE company_id = ${parseInt(companyId)}` : '';

    const [projects, tasksByStatus, tasksByPriority] = await Promise.all([
      query(`SELECT status, COUNT(*) AS count FROM projects ${cond} GROUP BY status`),
      query(`SELECT t.status, COUNT(*) AS count FROM tasks t
             LEFT JOIN projects p ON p.id = t.project_id
             ${companyId ? `WHERE p.company_id = ${parseInt(companyId)} OR t.project_id IS NULL` : ''}
             GROUP BY t.status`),
      query(`SELECT t.priority, COUNT(*) AS count FROM tasks t
             LEFT JOIN projects p ON p.id = t.project_id
             WHERE t.status NOT IN ('completada','cancelada')
             ${companyId ? `AND (p.company_id = ${parseInt(companyId)} OR t.project_id IS NULL)` : ''}
             GROUP BY t.priority`),
    ]);

    res.json({
      success: true,
      data: {
        projects_by_status: projects.rows,
        tasks_by_status: tasksByStatus.rows,
        tasks_by_priority: tasksByPriority.rows,
      },
    });
  } catch (error) { next(error); }
});

// GET /api/dashboards/finance
/**
 * @swagger
 * /dashboards/finance:
 *   get:
 *     summary: GET /dashboards/finance
 *     tags:
 *       - Reports
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/dashboards/finance', authorize('admin', 'finance', 'manager'), async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const cond = companyId ? `AND company_id = ${parseInt(companyId)}` : '';

    const [monthly, byCategory] = await Promise.all([
      query(`SELECT
               DATE_TRUNC('month', transaction_date) AS month,
               SUM(CASE WHEN type = 'ingreso' THEN amount ELSE 0 END) AS income,
               SUM(CASE WHEN type = 'egreso'  THEN amount ELSE 0 END) AS expense
             FROM transactions WHERE status != 'cancelada' ${cond}
             AND transaction_date >= NOW() - INTERVAL '12 months'
             GROUP BY DATE_TRUNC('month', transaction_date)
             ORDER BY month ASC`),
      query(`SELECT category, type, SUM(amount) AS total
             FROM transactions WHERE status != 'cancelada' ${cond}
             AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', NOW())
             GROUP BY category, type ORDER BY total DESC`),
    ]);

    res.json({
      success: true,
      data: {
        monthly_trend: monthly.rows,
        this_month_by_category: byCategory.rows,
      },
    });
  } catch (error) { next(error); }
});

// GET /api/dashboards/hr
/**
 * @swagger
 * /dashboards/hr:
 *   get:
 *     summary: GET /dashboards/hr
 *     tags:
 *       - Reports
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/dashboards/hr', authorize('admin', 'hr', 'manager'), async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const cond = companyId ? `WHERE company_id = ${parseInt(companyId)}` : '';

    const [employees, vacations] = await Promise.all([
      query(`SELECT status, COUNT(*) AS count FROM employees ${cond} GROUP BY status`),
      query(`SELECT status, COUNT(*) AS count FROM vacation_requests vr
             LEFT JOIN employees e ON e.id = vr.employee_id
             ${companyId ? `WHERE e.company_id = ${parseInt(companyId)}` : ''}
             GROUP BY status`),
    ]);

    res.json({
      success: true,
      data: {
        employees_by_status: employees.rows,
        vacations_by_status: vacations.rows,
      },
    });
  } catch (error) { next(error); }
});

// ─── REPORTS ─────────────────────────────────────────────────────────────────

// GET /api/reports/projects
/**
 * @swagger
 * /reports/projects:
 *   get:
 *     summary: GET /reports/projects
 *     tags:
 *       - Reports
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/reports/projects', async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await query(
      `SELECT p.*, c.name AS client_name, co.name AS company_name, u.name AS pm_name
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN companies co ON co.id = p.company_id
       LEFT JOIN users u ON u.id = p.pm_id
       ${companyId ? `WHERE p.company_id = ${parseInt(companyId)}` : ''}
       ORDER BY p.created_at DESC LIMIT 500`
    );

    if (req.query.format === 'excel') {
      const buffer = exportProjectsReport(result.rows);
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="proyectos.xlsx"' });
      return res.send(buffer);
    }

    res.json({ success: true, data: result.rows, total: result.rows.length });
  } catch (error) { next(error); }
});

// GET /api/reports/tasks
/**
 * @swagger
 * /reports/tasks:
 *   get:
 *     summary: GET /reports/tasks
 *     tags:
 *       - Reports
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/reports/tasks', async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const result = await query(
      `SELECT t.*, u.name AS assignee_name, p.name AS project_name, p.code AS project_code
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assigned_to
       LEFT JOIN projects p ON p.id = t.project_id
       ${companyId ? `WHERE p.company_id = ${parseInt(companyId)} OR t.project_id IS NULL` : ''}
       ORDER BY t.due_date ASC NULLS LAST LIMIT 1000`
    );
    res.json({ success: true, data: result.rows, total: result.rows.length });
  } catch (error) { next(error); }
});

// GET /api/reports/timesheet
/**
 * @swagger
 * /reports/timesheet:
 *   get:
 *     summary: GET /reports/timesheet
 *     tags:
 *       - Reports
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/reports/timesheet', exportLimiter, async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const dateFrom = req.query.date_from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const dateTo = req.query.date_to || new Date().toISOString().split('T')[0];

    const result = await query(
      `SELECT te.*, u.name AS user_name, t.title AS task_title, p.name AS project_name
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       JOIN tasks t ON t.id = te.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE DATE(te.start_time) BETWEEN $1 AND $2
       ${companyId ? `AND (p.company_id = ${parseInt(companyId)} OR t.project_id IS NULL)` : ''}
       ORDER BY te.start_time DESC LIMIT 5000`,
      [dateFrom, dateTo]
    );

    if (req.query.format === 'excel') {
      const buffer = exportTimesheetReport(result.rows);
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="timesheet.xlsx"' });
      return res.send(buffer);
    }

    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

// GET /api/reports/income-statement
/**
 * @swagger
 * /reports/income-statement:
 *   get:
 *     summary: GET /reports/income-statement
 *     tags:
 *       - Reports
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/reports/income-statement', authorize('admin', 'finance', 'manager'), async (req, res, next) => {
  try {
    const companyId = getCompanyId(req);
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const result = await query(
      `SELECT
         EXTRACT(MONTH FROM transaction_date)::INT AS month,
         category, type,
         SUM(amount) AS total
       FROM transactions
       WHERE status != 'cancelada'
       AND EXTRACT(YEAR FROM transaction_date) = $1
       ${companyId ? `AND company_id = ${parseInt(companyId)}` : ''}
       GROUP BY EXTRACT(MONTH FROM transaction_date), category, type
       ORDER BY month, type, category`,
      [year]
    );

    res.json({ success: true, data: result.rows, year });
  } catch (error) { next(error); }
});

// GET /api/reports/audit
/**
 * @swagger
 * /reports/audit:
 *   get:
 *     summary: GET /reports/audit
 *     tags:
 *       - Reports
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/reports/audit', authorize('admin'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT al.*, u.name AS user_name, u.email AS user_email
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE al.created_at >= NOW() - INTERVAL '30 days'
       ORDER BY al.created_at DESC LIMIT 500`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

module.exports = router;
