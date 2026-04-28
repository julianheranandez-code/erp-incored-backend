'use strict';

const express = require('express');
const router = express.Router();

const Employee = require('../models/Employee');
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { authorize } = require('../middleware/authorization');
const { auditLog } = require('../middleware/audit');
const { validate, schemas } = require('../middleware/validation');
const { getPagination, buildPaginatedResponse } = require('../utils/helpers');

router.use(verifyToken, auditLog);

// GET /api/employees
/**
 * @swagger
 * /:
 *   get:
 *     summary: GET /
 *     tags:
 *       - Employees
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req.query);
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const result = await Employee.findAll({ companyId, status: req.query.status, department: req.query.department, search: req.query.search, page, limit });
    res.json({ success: true, ...buildPaginatedResponse(result.data, result.total, page, limit) });
  } catch (error) { next(error); }
});

// GET /api/employees/:id
/**
 * @swagger
 * /:id:
 *   get:
 *     summary: GET /:id
 *     tags:
 *       - Employees
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/:id', async (req, res, next) => {
  try {
    const emp = await Employee.findById(parseInt(req.params.id));
    if (!emp) return res.status(404).json({ success: false, error: 'not_found', message: 'Empleado no encontrado.' });
    if (req.user.role !== 'admin' && !['manager', 'hr'].includes(req.user.role) && emp.company_id !== req.user.company_id) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Acceso denegado.' });
    }
    res.json({ success: true, data: emp });
  } catch (error) { next(error); }
});

// POST /api/employees
/**
 * @swagger
 * /:
 *   post:
 *     summary: POST /
 *     tags:
 *       - Employees
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/',
  authorize('admin', 'manager', 'hr'),
  validate(schemas.createEmployee),
  async (req, res, next) => {
    try {
      const emp = await Employee.create(req.body);
      res.status(201).json({ success: true, message: 'Empleado creado.', data: emp });
    } catch (error) { next(error); }
  }
);

// PUT /api/employees/:id
/**
 * @swagger
 * /:id:
 *   put:
 *     summary: PUT /:id
 *     tags:
 *       - Employees
 *     responses:
 *       200:
 *         description: Success
 */
router.put('/:id',
  authorize('admin', 'manager', 'hr'),
  async (req, res, next) => {
    try {
      const emp = await Employee.update(parseInt(req.params.id), req.body);
      if (!emp) return res.status(404).json({ success: false, error: 'not_found', message: 'Empleado no encontrado.' });
      res.json({ success: true, message: 'Empleado actualizado.', data: emp });
    } catch (error) { next(error); }
  }
);

// GET /api/employees/:id/contracts
/**
 * @swagger
 * /:id/contracts:
 *   get:
 *     summary: GET /:id/contracts
 *     tags:
 *       - Employees
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/:id/contracts', async (req, res, next) => {
  try {
    const contracts = await Employee.getContracts(parseInt(req.params.id));
    res.json({ success: true, data: contracts });
  } catch (error) { next(error); }
});

// POST /api/employees/:id/contracts
/**
 * @swagger
 * /:id/contracts:
 *   post:
 *     summary: POST /:id/contracts
 *     tags:
 *       - Employees
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/:id/contracts',
  authorize('admin', 'manager', 'hr'),
  async (req, res, next) => {
    try {
      const contract = await Employee.createContract(parseInt(req.params.id), req.body);
      res.status(201).json({ success: true, message: 'Contrato creado.', data: contract });
    } catch (error) { next(error); }
  }
);

// GET /api/vacations
/**
 * @swagger
 * /vacations:
 *   get:
 *     summary: GET /vacations
 *     tags:
 *       - Employees
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/vacations', async (req, res, next) => {
  try {
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const reqs = await Employee.getVacationRequests({
      employeeId: req.query.employee_id,
      status: req.query.status,
      companyId,
    });
    res.json({ success: true, data: reqs });
  } catch (error) { next(error); }
});

// POST /api/vacations
/**
 * @swagger
 * /vacations:
 *   post:
 *     summary: POST /vacations
 *     tags:
 *       - Employees
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/vacations', async (req, res, next) => {
  try {
    const { employee_id, start_date, end_date, reason } = req.body;
    if (!employee_id || !start_date || !end_date) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'employee_id, start_date, end_date son requeridos.' });
    }
    const request = await Employee.requestVacation(employee_id, { start_date, end_date, reason });
    res.status(201).json({ success: true, message: 'Solicitud de vacaciones enviada.', data: request });
  } catch (error) { next(error); }
});

// PUT /api/vacations/:id
/**
 * @swagger
 * /vacations/:id:
 *   put:
 *     summary: PUT /vacations/:id
 *     tags:
 *       - Employees
 *     responses:
 *       200:
 *         description: Success
 */
router.put('/vacations/:id',
  authorize('admin', 'manager', 'hr'),
  async (req, res, next) => {
    try {
      const { status, rejection_reason } = req.body;
      const updated = await Employee.updateVacationRequest(parseInt(req.params.id), {
        status, approved_by: req.user.id, rejection_reason,
      });
      if (!updated) return res.status(404).json({ success: false, error: 'not_found', message: 'Solicitud no encontrada.' });
      res.json({ success: true, message: `Solicitud ${status}.`, data: updated });
    } catch (error) { next(error); }
  }
);

// ─── PAYROLL ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /payroll:
 *   get:
 *     summary: GET /payroll
 *     tags:
 *       - Employees
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/payroll', authorize('admin', 'finance', 'hr'), async (req, res, next) => {
  try {
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const result = await query(
      `SELECT pp.*, co.name AS company_name, u.name AS created_by_name
       FROM payroll_periods pp
       LEFT JOIN companies co ON co.id = pp.company_id
       LEFT JOIN users u ON u.id = pp.created_by
       WHERE pp.company_id = $1
       ORDER BY pp.period_start DESC LIMIT 20`,
      [companyId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /payroll/generate:
 *   post:
 *     summary: POST /payroll/generate
 *     tags:
 *       - Employees
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/payroll/generate', authorize('admin', 'finance', 'hr'), async (req, res, next) => {
  try {
    const { company_id, period_start, period_end, period_type } = req.body;
    if (!company_id || !period_start || !period_end) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Datos de período requeridos.' });
    }

    // Get active employees for company
    const employees = await Employee.findAll({ companyId: company_id, status: 'activo', limit: 1000 });

    const periodResult = await query(
      `INSERT INTO payroll_periods (company_id, period_type, period_start, period_end, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [company_id, period_type || 'quincenal', period_start, period_end, req.user.id]
    );
    const period = periodResult.rows[0];

    let totalGross = 0;
    let totalNet = 0;

    // Generate entries for each employee
    for (const emp of employees.data) {
      if (!emp.salary_base) continue;

      const grossPay = emp.salary_period === 'quincenal' ? emp.salary_base : emp.salary_base / 2;
      const isr = grossPay * 0.08; // simplified
      const imss = grossPay * 0.03;
      const netPay = grossPay - isr - imss;

      await query(
        `INSERT INTO payroll_entries (period_id, employee_id, base_salary, isr, imss, deductions, net_pay)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [period.id, emp.id, grossPay, isr, imss, isr + imss, netPay]
      );
      totalGross += grossPay;
      totalNet += netPay;
    }

    await query(
      `UPDATE payroll_periods SET total_gross = $1, total_net = $2, total_deductions = $3, status = 'calculado' WHERE id = $4`,
      [totalGross, totalNet, totalGross - totalNet, period.id]
    );

    res.status(201).json({ success: true, message: 'Nómina generada.', data: { period_id: period.id, total_gross: totalGross, total_net: totalNet, employees_count: employees.data.length } });
  } catch (error) { next(error); }
});

module.exports = router;
