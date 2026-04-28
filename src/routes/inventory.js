'use strict';

const express = require('express');
const router = express.Router();

const Inventory = require('../models/Inventory');
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { authorize } = require('../middleware/authorization');
const { validate, schemas } = require('../middleware/validation');
const { auditLog } = require('../middleware/audit');
const { exportInventoryReport } = require('../utils/excelExporter');
const { getPagination, buildPaginatedResponse } = require('../utils/helpers');

router.use(verifyToken, auditLog);

// ─── MATERIALS ───────────────────────────────────────────────────────────────

router.get('/materials', async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req.query);
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const result = await Inventory.findAllMaterials({
      companyId, category: req.query.category, search: req.query.search,
      lowStock: req.query.low_stock === 'true', page, limit,
    });
    res.json({ success: true, ...buildPaginatedResponse(result.data, result.total, page, limit) });
  } catch (error) { next(error); }
});

router.get('/materials/:id', async (req, res, next) => {
  try {
    const material = await Inventory.findMaterialById(parseInt(req.params.id));
    if (!material) return res.status(404).json({ success: false, error: 'not_found', message: 'Material no encontrado.' });
    res.json({ success: true, data: material });
  } catch (error) { next(error); }
});

router.post('/materials',
  authorize('admin', 'manager', 'project_manager', 'supervisor'),
  validate(schemas.createMaterial),
  async (req, res, next) => {
    try {
      const material = await Inventory.createMaterial(req.body);
      res.status(201).json({ success: true, message: 'Material creado.', data: material });
    } catch (error) { next(error); }
  }
);

router.put('/materials/:id', async (req, res, next) => {
  try {
    const allowed = ['name', 'category', 'quantity_min', 'quantity_max', 'unit_of_measure', 'cost_last_purchase', 'supplier_id', 'location'];
    const updates = {};
    allowed.forEach((k) => { if (k in req.body) updates[k] = req.body[k]; });
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'validation_error', message: 'Sin datos para actualizar.' });
    const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(', ');
    const result = await query(
      `UPDATE inventory_materials SET ${fields}, updated_at = NOW() WHERE id = $${Object.keys(updates).length + 1} RETURNING *`,
      [...Object.values(updates), parseInt(req.params.id)]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Material no encontrado.' });
    res.json({ success: true, message: 'Material actualizado.', data: result.rows[0] });
  } catch (error) { next(error); }
});

router.post('/materials/:id/movement',
  validate(schemas.inventoryMovement),
  async (req, res, next) => {
    try {
      const result = await Inventory.registerMovement(parseInt(req.params.id), req.body, req.user.id);
      res.status(201).json({ success: true, message: 'Movimiento registrado.', data: result });
    } catch (error) { next(error); }
  }
);

// ─── TOOLS ───────────────────────────────────────────────────────────────────

router.get('/tools', async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req.query);
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const result = await Inventory.findAllTools({ companyId, status: req.query.status, search: req.query.search, page, limit });
    res.json({ success: true, ...buildPaginatedResponse(result.data, result.total, page, limit) });
  } catch (error) { next(error); }
});

router.post('/tools', authorize('admin', 'manager'), async (req, res, next) => {
  try {
    const result = await query(
      `INSERT INTO inventory_tools (code, name, category, brand, model, serial_number, company_id, status, purchase_date, purchase_cost, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.body.code, req.body.name, req.body.category || null, req.body.brand || null,
       req.body.model || null, req.body.serial_number || null,
       req.body.company_id || req.user.company_id, 'disponible',
       req.body.purchase_date || null, req.body.purchase_cost || null, req.body.notes || null]
    );
    res.status(201).json({ success: true, message: 'Herramienta creada.', data: result.rows[0] });
  } catch (error) { next(error); }
});

router.put('/tools/:id/location', async (req, res, next) => {
  try {
    const { current_project, status } = req.body;
    const result = await query(
      `UPDATE inventory_tools SET current_project = $1, status = COALESCE($2, status), updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [current_project || null, status || null, parseInt(req.params.id)]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Herramienta no encontrada.' });
    res.json({ success: true, message: 'Herramienta actualizada.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── VEHICLES ────────────────────────────────────────────────────────────────

router.get('/vehicles', async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req.query);
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const result = await Inventory.findAllVehicles({ companyId, status: req.query.status, page, limit });
    res.json({ success: true, ...buildPaginatedResponse(result.data, result.total, page, limit) });
  } catch (error) { next(error); }
});

router.post('/vehicles', authorize('admin', 'manager'), async (req, res, next) => {
  try {
    const result = await query(
      `INSERT INTO inventory_vehicles (plates, brand, model, year, vin, company_id, fuel_type, insurance_expiry, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.body.plates, req.body.brand, req.body.model, req.body.year || null,
       req.body.vin || null, req.body.company_id || req.user.company_id,
       req.body.fuel_type || null, req.body.insurance_expiry || null, req.body.notes || null]
    );
    res.status(201).json({ success: true, message: 'Vehículo creado.', data: result.rows[0] });
  } catch (error) { next(error); }
});

router.put('/vehicles/:id', async (req, res, next) => {
  try {
    const allowed = ['status', 'current_project', 'assigned_driver', 'odometer', 'insurance_expiry', 'next_service_km', 'notes'];
    const updates = {};
    allowed.forEach((k) => { if (k in req.body) updates[k] = req.body[k]; });
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'validation_error', message: 'Sin datos.' });
    const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(', ');
    const result = await query(
      `UPDATE inventory_vehicles SET ${fields}, updated_at = NOW() WHERE id = $${Object.keys(updates).length + 1} RETURNING *`,
      [...Object.values(updates), parseInt(req.params.id)]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Vehículo no encontrado.' });
    res.json({ success: true, message: 'Vehículo actualizado.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── REPORTS ─────────────────────────────────────────────────────────────────

router.get('/report', async (req, res, next) => {
  try {
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;
    const data = await Inventory.getInventoryReport(companyId);

    if (req.query.format === 'excel') {
      const materials = await Inventory.findAllMaterials({ companyId, limit: 10000 });
      const buffer = exportInventoryReport(materials.data.map((m) => ({ ...m, valuation: parseFloat(m.valuation) || 0 })));
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="inventario.xlsx"' });
      return res.send(buffer);
    }

    res.json({ success: true, data });
  } catch (error) { next(error); }
});

module.exports = router;
