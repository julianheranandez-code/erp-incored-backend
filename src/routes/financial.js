'use strict';

/**
 * Financial API Routes — Sprint 6.1C
 * =====================================
 * Version-ready: mount at /api/financial
 * Future: mount at /api/v1/financial without route changes.
 *
 * ALL routes require authentication (verifyToken).
 * ALL routes enforce company scope (controller level).
 */

const express    = require('express');
const router     = express.Router();
const { verifyToken } = require('../middleware/auth');
const ctrl       = require('../controllers/financial-controller');

router.use(verifyToken);

// ── Summary (Full P&L overview) ──────────────────────────────
router.get('/summary',              ctrl.getSummary);

// ── Individual dimensions ────────────────────────────────────
router.get('/revenue',              ctrl.getRevenue);
router.get('/expenses',             ctrl.getExpenses);
router.get('/cash-flow',            ctrl.getCashFlow);
router.get('/liabilities',          ctrl.getLiabilities);
router.get('/commitments',          ctrl.getCommitments);

// ── Project scoped ───────────────────────────────────────────
router.get('/project/:projectId',   ctrl.getProjectSummary);

// ── Trends (chart data) ──────────────────────────────────────
router.get('/trends',               ctrl.getTrends);
router.get('/pnl',                  ctrl.getPnL);

module.exports = router;
