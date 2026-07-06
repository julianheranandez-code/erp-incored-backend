'use strict';
/**
 * Executive Intelligence Routes — Sprint 6.4C
 * All routes require authentication. RBAC enforced in controller.
 */
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../middleware/auth');
const ctrl    = require('../controllers/executive-intelligence-controller');

router.get('/health',    ctrl.getHealth);      // no RBAC — monitoring only
router.get('/capabilities', ctrl.getHealth);  // alias

router.use(verifyToken);
router.get('/dashboard', ctrl.getDashboard);
router.get('/insights',  ctrl.getInsights);
router.get('/alerts',    ctrl.getAlerts);
router.get('/rankings',  ctrl.getRankings);
router.get('/trends',    ctrl.getTrends);
router.get('/risk',      ctrl.getRisk);
router.get('/portfolio', ctrl.getPortfolio);

module.exports = router;
