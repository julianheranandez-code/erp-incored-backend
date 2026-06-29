'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../middleware/auth');
const ctrl    = require('../controllers/portfolio-intelligence-controller');

// Public — monitoring only
router.get('/health',           ctrl.getHealth);
router.get('/capabilities',     ctrl.getCapabilities);

// Authenticated
router.use(verifyToken);
router.get('/dashboard',        ctrl.getDashboard);
router.get('/summary',          ctrl.getSummary);
router.get('/projects',         ctrl.getProjects);
router.get('/projects/:project_id', ctrl.getProjectById);
router.get('/rankings',         ctrl.getRankings);
router.get('/risk',             ctrl.getRisk);
router.get('/allocations',      ctrl.getAllocations);
router.get('/recommendations',  ctrl.getRecommendations);

module.exports = router;
