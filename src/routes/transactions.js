'use strict';

const express = require('express');
const router = express.Router();

const Transaction = require('../models/Transaction');
const { verifyToken } = require('../middleware/auth');
const { authorize } = require('../middleware/authorization');
const { validate, schemas } = require('../middleware/validation');
const { auditLog } = require('../middleware/audit');
const { getPagination, buildPaginatedResponse } = require('../utils/helpers');

router.use(verifyToken, auditLog);

// GET /api/transactions
/**
 * @swagger
 * /:
 *   get:
 *     summary: GET /
 *     tags:
 *       - Transactions
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req.query);
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const result = await Transaction.findAll({
      companyId, type: req.query.type, category: req.query.category,
      projectId: req.query.project_id, clientId: req.query.client_id,
      dateFrom: req.query.date_from, dateTo: req.query.date_to,
      search: req.query.search, page, limit,
    });
    res.json({
      success: true,
      summary: result.summary,
      ...buildPaginatedResponse(result.data, result.total, page, limit),
    });
  } catch (error) { next(error); }
});

// GET /api/transactions/:id
/**
 * @swagger
 * /:id:
 *   get:
 *     summary: GET /:id
 *     tags:
 *       - Transactions
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/:id', async (req, res, next) => {
  try {
    const tx = await Transaction.findById(parseInt(req.params.id));
    if (!tx) return res.status(404).json({ success: false, error: 'not_found', message: 'Transacción no encontrada.' });
    if (req.user.role !== 'admin' && tx.company_id !== req.user.company_id) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Acceso denegado.' });
    }
    res.json({ success: true, data: tx });
  } catch (error) { next(error); }
});

// POST /api/transactions
/**
 * @swagger
 * /:
 *   post:
 *     summary: POST /
 *     tags:
 *       - Transactions
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/',
  authorize('admin', 'manager', 'finance', 'project_manager'),
  validate(schemas.createTransaction),
  async (req, res, next) => {
    try {
      const tx = await Transaction.create(req.body, req.user.id);
      res.status(201).json({ success: true, message: 'Transacción registrada.', data: tx });
    } catch (error) { next(error); }
  }
);

// PUT /api/transactions/:id
/**
 * @swagger
 * /:id:
 *   put:
 *     summary: PUT /:id
 *     tags:
 *       - Transactions
 *     responses:
 *       200:
 *         description: Success
 */
router.put('/:id',
  authorize('admin', 'manager', 'finance'),
  async (req, res, next) => {
    try {
      const updated = await Transaction.update(parseInt(req.params.id), req.body);
      if (!updated) return res.status(404).json({ success: false, error: 'not_found', message: 'Transacción no encontrada.' });
      res.json({ success: true, message: 'Transacción actualizada.', data: updated });
    } catch (error) { next(error); }
  }
);

// GET /api/dashboards/pnl
/**
 * @swagger
 * /reports/pnl:
 *   get:
 *     summary: GET /reports/pnl
 *     tags:
 *       - Transactions
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/reports/pnl', async (req, res, next) => {
  try {
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const year = req.query.year || new Date().getFullYear();
    const data = await Transaction.getPnL({ companyId, year, month: req.query.month });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// GET /api/dashboards/cash-flow
/**
 * @swagger
 * /reports/cash-flow:
 *   get:
 *     summary: GET /reports/cash-flow
 *     tags:
 *       - Transactions
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/reports/cash-flow', async (req, res, next) => {
  try {
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const data = await Transaction.getCashFlow({ companyId, months: parseInt(req.query.months) || 3 });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// GET /api/transactions categories
/**
 * @swagger
 * /meta/categories:
 *   get:
 *     summary: GET /meta/categories
 *     tags:
 *       - Transactions
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/meta/categories', (req, res) => {
  res.json({
    success: true,
    data: {
      ingreso: ['servicios', 'venta_materiales', 'anticipos', 'finiquitos', 'otros_ingresos'],
      egreso: [
        'materiales', 'mano_obra', 'subcontratistas', 'equipos_herramientas',
        'transporte', 'combustible', 'hospedaje', 'viáticos', 'nomina',
        'impuestos', 'servicios_profesionales', 'mantenimiento', 'otros_gastos',
      ],
    },
  });
});

module.exports = router;
