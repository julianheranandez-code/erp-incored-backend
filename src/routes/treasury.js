'use strict';
/**
 * Treasury Routes — Sprint P4.1C
 * ADR-111: Treasury API
 */
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../middleware/auth');
const ctrl    = require('../controllers/treasury-controller');

// Public — monitoring only (Module 5+6)
router.get('/health',           ctrl.getHealth);
router.get('/capabilities',     ctrl.getCapabilities);

// Authenticated (Module 4)
router.use(verifyToken);
router.get('/dashboard',        ctrl.getDashboard);
router.get('/cash-position',    ctrl.getCashPosition);
router.get('/liquidity',        ctrl.getLiquidity);
router.get('/forecast',         ctrl.getForecast);
router.get('/payments',         ctrl.getPaymentCalendar);
router.get('/collections',      ctrl.getCollectionCalendar);
router.get('/fx-exposure',      ctrl.getFXExposure);
router.get('/working-capital',  ctrl.getWorkingCapital);
router.get('/risk',             ctrl.getRisk);
router.get('/health-status',    ctrl.getHealthStatus);
router.get('/bank-accounts',    ctrl.getBankAccounts);

module.exports = router;
