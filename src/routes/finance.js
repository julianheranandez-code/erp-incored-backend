'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

// ─── GET /api/finance/project-financials ─────────────────────
router.get('/project-financials', async (req, res, next) => {
  try {
    const { company_id, project_id } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (company_id) { conditions.push(`owner_company_id = $${idx++}`); values.push(parseInt(company_id)); }
    if (project_id) { conditions.push(`project_id = $${idx++}`); values.push(parseInt(project_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT * FROM project_financials ${where} ORDER BY gross_profit DESC NULLS LAST`,
      values
    );

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/finance/company-revenue ────────────────────────
router.get('/company-revenue', async (req, res, next) => {
  try {
    const { company_id } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (company_id) { conditions.push(`company_id = $${idx++}`); values.push(parseInt(company_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT * FROM company_revenue ${where} ORDER BY total_invoiced DESC NULLS LAST`,
      values
    );

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/finance/company-costs ──────────────────────────
router.get('/company-costs', async (req, res, next) => {
  try {
    const { company_id, cost_type } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (company_id) { conditions.push(`company_id = $${idx++}`); values.push(parseInt(company_id)); }
    if (cost_type)  { conditions.push(`cost_type = $${idx++}`); values.push(cost_type); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT * FROM company_costs ${where} ORDER BY total_amount DESC NULLS LAST`,
      values
    );

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/finance/po-utilization ─────────────────────────
router.get('/po-utilization', async (req, res, next) => {
  try {
    const { company_id, project_id, alert } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (company_id) { conditions.push(`company_id = $${idx++}`); values.push(parseInt(company_id)); }
    if (project_id) { conditions.push(`project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (alert)      { conditions.push(`utilization_alert = $${idx++}`); values.push(alert); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT * FROM project_po_summary ${where} ORDER BY invoiced_pct DESC NULLS LAST`,
      values
    );

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/finance/cash-flow ───────────────────────────────
router.get('/cash-flow', async (req, res, next) => {
  try {
    const { company_id, project_id, date_from, date_to, is_projected, period } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    // FIX: each view has different date column
    let viewName   = 'cash_flow_view';
    let dateColumn = 'flow_date';

    if (period === 'weekly')  { viewName = 'cash_flow_weekly';  dateColumn = 'week_start'; }
    if (period === 'monthly') { viewName = 'cash_flow_monthly'; dateColumn = 'month_start'; }

    if (company_id) { conditions.push(`company_id = $${idx++}`); values.push(parseInt(company_id)); }
    if (project_id) { conditions.push(`project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (date_from)  { conditions.push(`${dateColumn} >= $${idx++}`); values.push(date_from); }
    if (date_to)    { conditions.push(`${dateColumn} <= $${idx++}`); values.push(date_to); }

    // is_projected only applies to cash_flow_view (not weekly/monthly)
    if (is_projected !== undefined && !period) {
      conditions.push(`is_projected = $${idx++}`);
      values.push(is_projected === 'true');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT * FROM ${viewName} ${where} ORDER BY ${dateColumn} ASC`,
      values
    );

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/finance/cash-flow-running ──────────────────────
router.get('/cash-flow-running', async (req, res, next) => {
  try {
    const { company_id, project_id, date_from, date_to } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (company_id) { conditions.push(`company_id = $${idx++}`); values.push(parseInt(company_id)); }
    if (project_id) { conditions.push(`project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (date_from)  { conditions.push(`flow_date >= $${idx++}`); values.push(date_from); }
    if (date_to)    { conditions.push(`flow_date <= $${idx++}`); values.push(date_to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT * FROM cash_flow_running ${where} ORDER BY flow_date ASC`,
      values
    );

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/finance/dashboard ──────────────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    const { company_id } = req.query;

    // FIX: use parameterized queries (no string interpolation)
    const companyParams  = company_id ? [parseInt(company_id)] : [];
    const companyFilter  = company_id ? 'WHERE owner_company_id = $1' : '';
    const companyFilterCR = company_id ? 'WHERE company_id = $1' : '';

    const [kpis, alerts, poUtilization] = await Promise.all([
      query(`
        SELECT
          COUNT(*)                            AS total_projects,
          COALESCE(SUM(total_invoiced), 0)    AS total_revenue,
          COALESCE(SUM(total_billed), 0)      AS total_costs,
          COALESCE(SUM(total_expenses), 0)    AS total_expenses,
          COALESCE(SUM(gross_profit), 0)      AS total_profit,
          COALESCE(SUM(outstanding_ar), 0)    AS total_outstanding_ar,
          COALESCE(SUM(outstanding_ap), 0)    AS total_outstanding_ap,
          ROUND(AVG(profit_margin_pct), 2)    AS avg_margin_pct
        FROM project_financials ${companyFilter}
      `, companyParams),

      query(`
        SELECT project_id, project_name, owner_company_name,
          profit_margin_pct, gross_profit, outstanding_ar,
          budget_remaining, po_remaining,
          CASE
            WHEN profit_margin_pct < 0  THEN 'negative_profit'
            WHEN profit_margin_pct < 15 THEN 'low_margin'
            WHEN budget_remaining < 0   THEN 'over_budget'
            ELSE 'ok'
          END AS alert_type
        FROM project_financials
        ${companyFilter}
        ${companyFilter ? 'AND' : 'WHERE'} (profit_margin_pct < 15 OR budget_remaining < 0)
        ORDER BY profit_margin_pct ASC NULLS LAST
        LIMIT 10
      `, companyParams),

      query(`
        SELECT po_id, po_number, project_name, company_name,
          po_total, invoiced_amount, remaining_amount,
          invoiced_pct, utilization_alert
        FROM project_po_summary
        ${companyFilterCR}
        ${companyFilterCR ? 'AND' : 'WHERE'} utilization_alert IN ('critical','warning')
        ORDER BY invoiced_pct DESC
        LIMIT 10
      `, companyParams)
    ]);

    res.json({
      success: true,
      data: {
        kpis:      kpis.rows[0],
        alerts:    alerts.rows,
        po_alerts: poUtilization.rows
      }
    });
  } catch (error) { next(error); }
});

// ─── POST /api/finance/refresh ────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    await query('SELECT refresh_project_financials()');
    res.json({ success: true, message: 'project_financials refreshed successfully.' });
  } catch (error) { next(error); }
});

// ─── POST /api/finance/mark-overdue ──────────────────────────
router.post('/mark-overdue', async (req, res, next) => {
  try {
    await query('SELECT mark_overdue()');
    res.json({ success: true, message: 'Overdue invoices and bills updated.' });
  } catch (error) { next(error); }
});

module.exports = router;
