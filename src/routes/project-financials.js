'use strict';

/**
 * Project Financial Routes — Sprint 4A
 * ======================================
 * Endpoints:
 *   GET /api/projects/:id/financial-summary
 *   GET /api/projects/:id/financial-alerts
 *   GET /api/projects/financial-dashboard
 *   POST /api/projects/:id/financial-alerts/:alertId/acknowledge
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const {
  getProjectFinancialSummary,
  generateProjectAlerts,
  getPortfolioDashboard
} = require('../services/project-financial-service');

router.use(verifyToken);

// ─── GET /api/project-financials/dashboard ────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    const { company_id } = req.query;
    const roles = req.user.roles?.length ? req.user.roles : [req.user.role];
    const companyId = roles.includes('super_admin') && company_id
      ? parseInt(company_id)
      : parseInt(req.user.active_company_id || req.user.company_id);

    const dashboard = await getPortfolioDashboard(companyId);
    res.json({ success: true, data: dashboard });
  } catch(error) { next(error); }
});

// ─── GET /api/project-financials/:id/summary ──────────────────
router.get('/:id/summary', async (req, res, next) => {
  try {
    const summary = await getProjectFinancialSummary(parseInt(req.params.id));
    if (!summary)
      return res.status(404).json({ success: false, error: 'not_found' });

    // Generate alerts on-demand (non-blocking)
    generateProjectAlerts(parseInt(req.params.id)).catch(() => {});

    res.json({ success: true, data: summary });
  } catch(error) { next(error); }
});

// ─── GET /api/project-financials/:id/alerts ───────────────────
router.get('/:id/alerts', async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id);
    const { acknowledged } = req.query;

    const conditions = ['project_id = $1'];
    const values = [projectId];
    if (acknowledged === 'false') conditions.push('is_acknowledged = FALSE');
    if (acknowledged === 'true')  conditions.push('is_acknowledged = TRUE');

    const result = await query(`
      SELECT pfa.*, p.code AS project_code, p.name AS project_name
      FROM project_financial_alerts pfa
      JOIN projects p ON p.id = pfa.project_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY pfa.created_at DESC
      LIMIT 50
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(error) { next(error); }
});

// ─── POST /api/project-financials/:id/alerts/:alertId/acknowledge
router.post('/:id/alerts/:alertId/acknowledge', async (req, res, next) => {
  try {
    const result = await query(`
      UPDATE project_financial_alerts SET
        is_acknowledged = TRUE,
        acknowledged_by = $1,
        acknowledged_at = NOW()
      WHERE id = $2 AND project_id = $3
      RETURNING *
    `, [req.user.id, parseInt(req.params.alertId), parseInt(req.params.id)]);

    if (!result.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    res.json({ success: true, message: 'Alert acknowledged.', data: result.rows[0] });
  } catch(error) { next(error); }
});

module.exports = router;
