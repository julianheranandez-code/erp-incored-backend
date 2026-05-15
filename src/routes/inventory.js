'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

router.use(verifyToken);

// ─── ISOLATION ────────────────────────────────────────────────
function getAuthorizedCompanyId(user, requestedCompanyId) {
  if (user.role === 'admin') return requestedCompanyId ? parseInt(requestedCompanyId) : null;
  return parseInt(user.company_id);
}

// ─── WAREHOUSES ───────────────────────────────────────────────

router.get('/warehouses', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`w.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (req.query.type)      { conditions.push(`w.type = $${idx++}`);       values.push(req.query.type); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT w.*,
        COUNT(ws.id) AS stock_lines,
        COALESCE(SUM(ws.qty_available), 0) AS total_available
      FROM warehouses w
      LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id
      ${where}
      GROUP BY w.id
      ORDER BY w.name ASC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

router.post('/warehouses', async (req, res, next) => {
  try {
    const { company_id, code, name, type = 'physical', location, city, state,
            assigned_crew_id, assigned_project_id, notes } = req.body;

    if (!company_id || !code || !name) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, code, name' });
    }

    const result = await query(`
      INSERT INTO warehouses (company_id, code, name, type, location, city, state, assigned_crew_id, assigned_project_id, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [parseInt(company_id), code, name, type, location||null, city||null, state||null,
        assigned_crew_id||null, assigned_project_id||null, notes||null, req.user.id]);

    res.status(201).json({ success: true, message: 'Warehouse created.', data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'duplicate_code', message: 'Warehouse code already exists.' });
    next(error);
  }
});

// ─── MATERIALS ────────────────────────────────────────────────

router.get('/materials', async (req, res, next) => {
  try {
    const { page = 1, limit = 50, category, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`m.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (category)            { conditions.push(`m.category = $${idx++}`);   values.push(category); }
    if (search) {
      conditions.push(`(m.name ILIKE $${idx} OR m.sku ILIKE $${idx} OR m.barcode_internal ILIKE $${idx})`);
      values.push(`%${search}%`); idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')} AND m.is_active = TRUE` : 'WHERE m.is_active = TRUE';

    const [materials, total] = await Promise.all([
      query(`
        SELECT m.*,
          v.name AS vendor_name,
          COALESCE(SUM(ws.qty_available), 0) AS total_stock,
          COALESCE(SUM(ws.qty_reserved), 0) AS total_reserved,
          COALESCE(SUM(ws.qty_damaged), 0) AS total_damaged
        FROM materials m
        LEFT JOIN clients v ON v.id = m.preferred_vendor_id
        LEFT JOIN warehouse_stock ws ON ws.material_id = m.id
        ${where}
        GROUP BY m.id, v.name
        ORDER BY m.name ASC
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, parseInt(limit), offset]),
      query(`SELECT COUNT(*) AS total FROM materials m ${where}`, values)
    ]);

    res.json({
      success: true,
      data: {
        materials: materials.rows,
        pagination: {
          total: parseInt(total.rows[0].total),
          page: parseInt(page), limit: parseInt(limit),
          totalPages: Math.ceil(parseInt(total.rows[0].total) / parseInt(limit))
        }
      }
    });
  } catch (error) { next(error); }
});

router.get('/materials/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const [material, stock, movements] = await Promise.all([
      query(`
        SELECT m.*, v.name AS vendor_name
        FROM materials m
        LEFT JOIN clients v ON v.id = m.preferred_vendor_id
        WHERE m.id = $1
      `, [id]),
      query(`
        SELECT ws.*, w.name AS warehouse_name, w.type AS warehouse_type
        FROM warehouse_stock ws
        JOIN warehouses w ON w.id = ws.warehouse_id
        WHERE ws.material_id = $1
      `, [id]),
      query(`
        SELECT sm.*, w.name AS warehouse_name,
          CONCAT(u.first_name,' ',u.last_name) AS created_by_name
        FROM stock_movements sm
        LEFT JOIN warehouses w ON w.id = sm.warehouse_id
        LEFT JOIN users u ON u.id = sm.created_by
        WHERE sm.material_id = $1
        ORDER BY sm.created_at DESC LIMIT 20
      `, [id])
    ]);

    if (!material.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Material not found.' });

    res.json({ success: true, data: { material: material.rows[0], stock: stock.rows, recent_movements: movements.rows } });
  } catch (error) { next(error); }
});

router.post('/materials', async (req, res, next) => {
  const startTime = Date.now();
  logger.info('[Inventory] POST /materials → payload received', {
    body: { ...req.body, image_url: req.body.image_url ? '[present]' : null }
  });

  // Dynamic category list — no DB constraint needed
  const VALID_CATEGORIES = [
    'fiber_cable','splitter','ont','closure','patch_cord',
    'odf','connector','drop_cable','pole_hardware',
    'duct_conduit','splice_tray','tool','vehicle',
    'safety_equipment','consumable','structured_cabling','other'
  ];

  try {
    const {
      company_id, sku, name, description, category, subcategory,
      fiber_count, reel_length, fiber_type, uom = 'pcs',
      min_stock = 0, reorder_point = 0, standard_cost, currency = 'MXN',
      barcode_supplier, preferred_vendor_id, manufacturer, vendor_reference,
      image_url, thumbnail_url, spec_sheet_url, notes,
      serial_required, requires_serial,
      batch_required,  requires_lot, lot_required
    } = req.body;

    const serialRequired = serial_required ?? requires_serial ?? false;
    const batchRequired  = batch_required  ?? requires_lot    ?? lot_required ?? false;

    if (!company_id || !sku || !name || !category) {
      return res.status(400).json({
        success: false, error: 'validation_error',
        message: 'Required: company_id, sku, name, category',
        missing: ['company_id','sku','name','category'].filter(f => !req.body[f])
      });
    }

    // Soft category validation — warn but don't block unknown categories
    if (!VALID_CATEGORIES.includes(category)) {
      logger.warn(`[Inventory] Unknown category "${category}" — allowing through`);
    }

    if (req.user.role !== 'admin' && parseInt(company_id) !== parseInt(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    const insertPayload = [
      parseInt(company_id), sku, name, description||null, category, subcategory||null,
      fiber_count ? parseInt(fiber_count) : null,
      reel_length ? parseFloat(reel_length) : null,
      fiber_type||null, uom,
      parseFloat(min_stock || 0), parseFloat(reorder_point || 0),
      standard_cost ? parseFloat(standard_cost) : null, currency,
      barcode_supplier||null,
      preferred_vendor_id ? parseInt(preferred_vendor_id) : null,
      manufacturer||null, vendor_reference||null,
      image_url||null, thumbnail_url||null, spec_sheet_url||null,
      Boolean(serialRequired), Boolean(batchRequired),
      notes||null, req.user.id
    ];

    logger.info(`[Inventory] inserting material sku=${sku} category=${category}`);

    const result = await query(`
      INSERT INTO materials (
        company_id, sku, name, description, category, subcategory,
        fiber_count, reel_length, fiber_type, uom,
        min_stock, reorder_point, standard_cost, currency,
        barcode_supplier, preferred_vendor_id, manufacturer, vendor_reference,
        image_url, thumbnail_url, spec_sheet_url,
        serial_required, batch_required, notes, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      RETURNING *
    `, insertPayload);

    logger.info(`[Inventory] material created id=${result.rows[0].id} in ${Date.now()-startTime}ms`);

    writeAudit({
      userId: req.user.id, action: 'material_created',
      entityType: 'materials', entityId: result.rows[0].id,
      companyId: parseInt(company_id), newValues: { sku, name, category },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Inventory] audit failed:', err.message));

    res.status(201).json({ success: true, message: 'Material created.', data: result.rows[0] });
  } catch (error) {
    logger.error('[Inventory] POST /materials error:', { message: error.message, code: error.code });
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'duplicate_sku', message: `SKU "${req.body.sku}" already exists for this company.` });
    if (error.code === '23514') return res.status(400).json({ success: false, error: 'constraint_violation', message: `Invalid value: ${error.message}` });
    if (error.code === '23502') return res.status(400).json({ success: false, error: 'null_violation', message: `Required field missing: ${error.message}` });
    next(error);
  }
});

router.put('/materials/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, min_stock, reorder_point, standard_cost,
            image_url, thumbnail_url, spec_sheet_url, is_active, notes } = req.body;

    const result = await query(`
      UPDATE materials SET
        name          = COALESCE($1, name),
        description   = COALESCE($2, description),
        min_stock     = COALESCE($3::numeric, min_stock),
        reorder_point = COALESCE($4::numeric, reorder_point),
        standard_cost = COALESCE($5::numeric, standard_cost),
        image_url     = COALESCE($6, image_url),
        thumbnail_url = COALESCE($7, thumbnail_url),
        spec_sheet_url= COALESCE($8, spec_sheet_url),
        is_active     = COALESCE($9::boolean, is_active),
        notes         = COALESCE($10, notes),
        updated_at    = NOW()
      WHERE id = $11 RETURNING *
    `, [name||null, description||null, min_stock||null, reorder_point||null,
        standard_cost||null, image_url||null, thumbnail_url||null, spec_sheet_url||null,
        is_active !== undefined ? is_active : null, notes||null, id]);

    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Material not found.' });
    res.json({ success: true, message: 'Material updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── TOOLS ───────────────────────────────────────────────────

router.get('/tools', async (req, res, next) => {
  try {
    const { status, category } = req.query;
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`t.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (status)              { conditions.push(`t.status = $${idx++}`);     values.push(status); }
    if (category)            { conditions.push(`t.category = $${idx++}`);   values.push(category); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT t.*,
        w.name AS warehouse_name,
        cr.crew_name
      FROM tools t
      LEFT JOIN warehouses w ON w.id = t.warehouse_id
      LEFT JOIN project_crews cr ON cr.id = t.assigned_crew_id
      ${where}
      ORDER BY t.name ASC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

router.post('/tools', async (req, res, next) => {
  try {
    const { company_id, code, name, category, serial_number, brand, model,
            warehouse_id, purchase_date, purchase_cost, next_calibration,
            next_maintenance, image_url, notes } = req.body;

    if (!company_id || !code || !name || !category) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, code, name, category' });
    }

    const result = await query(`
      INSERT INTO tools (company_id, code, name, category, serial_number, brand, model,
        warehouse_id, purchase_date, purchase_cost, next_calibration, next_maintenance,
        image_url, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *
    `, [parseInt(company_id), code, name, category, serial_number||null, brand||null, model||null,
        warehouse_id ? parseInt(warehouse_id) : null,
        purchase_date||null, purchase_cost ? parseFloat(purchase_cost) : null,
        next_calibration||null, next_maintenance||null,
        image_url||null, notes||null, req.user.id]);

    res.status(201).json({ success: true, message: 'Tool created.', data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'duplicate_code', message: 'Tool code already exists.' });
    next(error);
  }
});

// ─── FLEET VEHICLES ───────────────────────────────────────────

router.get('/vehicles', async (req, res, next) => {
  try {
    const { status } = req.query;
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`v.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (status)              { conditions.push(`v.status = $${idx++}`);     values.push(status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT v.*, cr.crew_name
      FROM fleet_vehicles v
      LEFT JOIN project_crews cr ON cr.id = v.assigned_crew_id
      ${where}
      ORDER BY v.code ASC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

router.post('/vehicles', async (req, res, next) => {
  try {
    const { company_id, code, plate, brand, model, year, color, type = 'truck',
            next_maintenance, next_verification, insurance_expiry, notes } = req.body;

    if (!company_id || !code) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, code' });
    }

    const result = await query(`
      INSERT INTO fleet_vehicles (company_id, code, plate, brand, model, year, color, type,
        next_maintenance, next_verification, insurance_expiry, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
    `, [parseInt(company_id), code, plate||null, brand||null, model||null,
        year ? parseInt(year) : null, color||null, type,
        next_maintenance||null, next_verification||null, insurance_expiry||null,
        notes||null, req.user.id]);

    res.status(201).json({ success: true, message: 'Vehicle created.', data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'duplicate_code', message: 'Vehicle code already exists.' });
    next(error);
  }
});

// ─── STOCK MOVEMENTS ─────────────────────────────────────────

router.get('/movements', async (req, res, next) => {
  try {
    const { warehouse_id, material_id, movement_type, project_id, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`sm.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (warehouse_id)        { conditions.push(`sm.warehouse_id = $${idx++}`); values.push(parseInt(warehouse_id)); }
    if (material_id)         { conditions.push(`sm.material_id = $${idx++}`); values.push(parseInt(material_id)); }
    if (movement_type)       { conditions.push(`sm.movement_type = $${idx++}`); values.push(movement_type); }
    if (project_id)          { conditions.push(`sm.project_id = $${idx++}`); values.push(parseInt(project_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT sm.*,
        m.name AS material_name, m.sku,
        w.name AS warehouse_name,
        fw.name AS from_warehouse_name,
        tw.name AS to_warehouse_name,
        CONCAT(u.first_name,' ',u.last_name) AS created_by_name
      FROM stock_movements sm
      LEFT JOIN materials m  ON m.id = sm.material_id
      LEFT JOIN warehouses w ON w.id = sm.warehouse_id
      LEFT JOIN warehouses fw ON fw.id = sm.from_warehouse_id
      LEFT JOIN warehouses tw ON tw.id = sm.to_warehouse_id
      LEFT JOIN users u      ON u.id = sm.created_by
      ${where}
      ORDER BY sm.created_at DESC
      LIMIT $${idx} OFFSET $${idx+1}
    `, [...values, parseInt(limit), offset]);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

router.post('/movements', async (req, res, next) => {
  const startTime = Date.now();
  try {
    const {
      company_id, warehouse_id, material_id, movement_type,
      quantity, uom, unit_cost, currency = 'MXN',
      from_warehouse_id, to_warehouse_id, project_id,
      internal_po_id, ap_bill_id,
      batch_number, serial_number, notes, reference
    } = req.body;

    if (!company_id || !warehouse_id || !material_id || !movement_type || !quantity) {
      return res.status(400).json({
        success: false, error: 'validation_error',
        message: 'Required: company_id, warehouse_id, material_id, movement_type, quantity'
      });
    }

    const qty = parseFloat(quantity);
    const totalCost = unit_cost ? qty * parseFloat(unit_cost) : null;

    const result = await withTransaction(async (client) => {
      // 1. Insert movement
      const movement = await client.query(`
        INSERT INTO stock_movements (
          company_id, warehouse_id, material_id, movement_type,
          quantity, uom, unit_cost, total_cost, currency,
          from_warehouse_id, to_warehouse_id, project_id,
          internal_po_id, ap_bill_id,
          batch_number, serial_number, notes, reference, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING *
      `, [
        parseInt(company_id), parseInt(warehouse_id), parseInt(material_id), movement_type,
        qty, uom||null, unit_cost ? parseFloat(unit_cost) : null,
        totalCost, currency,
        from_warehouse_id ? parseInt(from_warehouse_id) : null,
        to_warehouse_id ? parseInt(to_warehouse_id) : null,
        project_id ? parseInt(project_id) : null,
        internal_po_id ? parseInt(internal_po_id) : null,
        ap_bill_id ? parseInt(ap_bill_id) : null,
        batch_number||null, serial_number||null, notes||null, reference||null,
        req.user.id
      ]);

      // 2. Update warehouse_stock based on movement type
      const stockUpdate = {
        'inbound':    { available: qty },
        'outbound':   { available: -qty },
        'damaged':    { available: -qty, damaged: qty },
        'consumed':   { available: -qty, consumed: qty },
        'reserved':   { available: -qty, reserved: qty },
        'unreserved': { available: qty,  reserved: -qty },
        'return':     { available: qty }
      };

      const updates = stockUpdate[movement_type];
      if (updates) {
        await client.query(`
          INSERT INTO warehouse_stock (warehouse_id, material_id, company_id,
            qty_available, qty_reserved, qty_damaged, qty_consumed, last_movement)
          VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
          ON CONFLICT (warehouse_id, material_id) DO UPDATE SET
            qty_available = warehouse_stock.qty_available + $4,
            qty_reserved  = GREATEST(0, warehouse_stock.qty_reserved + $5),
            qty_damaged   = warehouse_stock.qty_damaged + $6,
            qty_consumed  = warehouse_stock.qty_consumed + $7,
            last_movement = NOW(),
            updated_at    = NOW()
        `, [
          parseInt(warehouse_id), parseInt(material_id), parseInt(company_id),
          updates.available || 0,
          updates.reserved  || 0,
          updates.damaged   || 0,
          updates.consumed  || 0
        ]);
      }

      // 3. For transfers: update destination warehouse too
      if (movement_type === 'transfer' && to_warehouse_id) {
        await client.query(`
          INSERT INTO warehouse_stock (warehouse_id, material_id, company_id, qty_available, last_movement)
          VALUES ($1,$2,$3,$4,NOW())
          ON CONFLICT (warehouse_id, material_id) DO UPDATE SET
            qty_available = warehouse_stock.qty_available + $4,
            qty_in_transit = GREATEST(0, warehouse_stock.qty_in_transit - $4),
            last_movement = NOW(), updated_at = NOW()
        `, [parseInt(to_warehouse_id), parseInt(material_id), parseInt(company_id), qty]);

        // Deduct from source
        await client.query(`
          UPDATE warehouse_stock SET
            qty_available = GREATEST(0, qty_available - $1),
            last_movement = NOW(), updated_at = NOW()
          WHERE warehouse_id = $2 AND material_id = $3
        `, [qty, parseInt(warehouse_id), parseInt(material_id)]);
      }

      return movement.rows[0];
    });

    logger.info(`[Inventory] Movement ${movement_type} qty=${qty} in ${Date.now()-startTime}ms`);

    writeAudit({
      userId: req.user.id, action: 'stock_movement',
      entityType: 'stock_movements', entityId: result.id,
      companyId: parseInt(company_id),
      newValues: { movement_type, quantity: qty, material_id, warehouse_id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[Inventory] audit failed:', err.message));

    res.status(201).json({ success: true, message: 'Stock movement recorded.', data: result });
  } catch (error) { next(error); }
});

// ─── TRANSFERS ────────────────────────────────────────────────
router.post('/transfers', async (req, res, next) => {
  try {
    const { company_id, from_warehouse_id, to_warehouse_id, material_id, quantity, notes } = req.body;

    if (!company_id || !from_warehouse_id || !to_warehouse_id || !material_id || !quantity) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, from_warehouse_id, to_warehouse_id, material_id, quantity' });
    }

    // Delegate to movements with type=transfer
    req.body.warehouse_id = from_warehouse_id;
    req.body.movement_type = 'transfer';

    return router.handle(Object.assign(req, { url: '/movements', method: 'POST' }), res, () => {});
  } catch (error) { next(error); }
});

// ─── PURCHASE RECEIPTS ───────────────────────────────────────

router.post('/receipts', async (req, res, next) => {
  const startTime = Date.now();
  try {
    const {
      company_id, warehouse_id, internal_po_id, ap_bill_id,
      receipt_number, receipt_date, vendor_id, notes, lines = []
    } = req.body;

    if (!company_id || !warehouse_id || !receipt_number) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, warehouse_id, receipt_number' });
    }

    const result = await withTransaction(async (client) => {
      // 1. Create receipt header
      const receipt = await client.query(`
        INSERT INTO purchase_receipts (company_id, warehouse_id, internal_po_id, ap_bill_id,
          receipt_number, receipt_date, vendor_id, notes, status, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received',$9) RETURNING *
      `, [parseInt(company_id), parseInt(warehouse_id),
          internal_po_id ? parseInt(internal_po_id) : null,
          ap_bill_id ? parseInt(ap_bill_id) : null,
          receipt_number,
          receipt_date || new Date().toISOString().split('T')[0],
          vendor_id ? parseInt(vendor_id) : null,
          notes||null, req.user.id]);

      // 2. Process each line + create inbound movements
      for (const line of lines) {
        await client.query(`
          INSERT INTO purchase_receipt_lines (receipt_id, material_id, qty_expected, qty_received, unit_cost, notes)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [receipt.rows[0].id, parseInt(line.material_id),
            parseFloat(line.qty_expected || 0),
            parseFloat(line.qty_received || 0),
            line.unit_cost ? parseFloat(line.unit_cost) : null,
            line.notes||null]);

        // Auto-create inbound movement for received qty
        if (parseFloat(line.qty_received) > 0) {
          await client.query(`
            INSERT INTO stock_movements (
              company_id, warehouse_id, material_id, movement_type,
              quantity, unit_cost, reference, created_by
            ) VALUES ($1,$2,$3,'inbound',$4,$5,$6,$7)
          `, [parseInt(company_id), parseInt(warehouse_id), parseInt(line.material_id),
              parseFloat(line.qty_received),
              line.unit_cost ? parseFloat(line.unit_cost) : null,
              receipt_number, req.user.id]);

          // Update stock
          await client.query(`
            INSERT INTO warehouse_stock (warehouse_id, material_id, company_id, qty_available, last_movement)
            VALUES ($1,$2,$3,$4,NOW())
            ON CONFLICT (warehouse_id, material_id) DO UPDATE SET
              qty_available = warehouse_stock.qty_available + $4,
              last_movement = NOW(), updated_at = NOW()
          `, [parseInt(warehouse_id), parseInt(line.material_id), parseInt(company_id), parseFloat(line.qty_received)]);
        }
      }

      return receipt.rows[0];
    });

    logger.info(`[Inventory] Receipt ${receipt_number} processed in ${Date.now()-startTime}ms`);

    res.status(201).json({ success: true, message: 'Receipt processed.', data: result });
  } catch (error) { next(error); }
});

// ─── INVENTORY ALERTS ─────────────────────────────────────────

router.get('/alerts', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`company_id = $${idx++}`); values.push(authorizedCompanyId); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT * FROM inventory_alerts ${where} ORDER BY CASE severity WHEN 'critical' THEN 1 ELSE 2 END`,
      values
    );

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── INVENTORY DASHBOARD ─────────────────────────────────────

router.get('/dashboard', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const companyFilter = authorizedCompanyId ? `WHERE company_id = ${authorizedCompanyId}` : '';
    const companyAnd = authorizedCompanyId ? `AND company_id = ${authorizedCompanyId}` : '';

    const [materials, stock, tools, vehicles, alerts] = await Promise.all([
      query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active) AS active FROM materials ${companyFilter}`),
      query(`
        SELECT
          COUNT(DISTINCT material_id) AS tracked_materials,
          COALESCE(SUM(qty_available), 0) AS total_available,
          COALESCE(SUM(qty_reserved), 0) AS total_reserved,
          COALESCE(SUM(qty_damaged), 0) AS total_damaged
        FROM warehouse_stock WHERE 1=1 ${companyAnd}
      `),
      query(`
        SELECT COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='available') AS available,
          COUNT(*) FILTER (WHERE status='in_use') AS in_use,
          COUNT(*) FILTER (WHERE status='maintenance') AS maintenance
        FROM tools ${companyFilter}
      `),
      query(`
        SELECT COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='active') AS active,
          COUNT(*) FILTER (WHERE status='maintenance') AS maintenance
        FROM fleet_vehicles ${companyFilter}
      `),
      query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE severity='critical') AS critical FROM inventory_alerts ${companyFilter}`)
    ]);

    res.json({
      success: true,
      data: {
        materials: materials.rows[0],
        stock:     stock.rows[0],
        tools:     tools.rows[0],
        vehicles:  vehicles.rows[0],
        alerts:    alerts.rows[0]
      }
    });
  } catch (error) { next(error); }
});

// ─── IMPORT (Excel bulk) ─────────────────────────────────────
router.post('/import', async (req, res, next) => {
  try {
    const { company_id, rows = [] } = req.body;
    if (!company_id || !rows.length) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: company_id, rows[]' });
    }

    const results = { created: 0, updated: 0, errors: [] };

    for (const row of rows) {
      try {
        if (!row.sku || !row.name || !row.category) {
          results.errors.push({ row: row.sku || '?', error: 'Missing sku/name/category' });
          continue;
        }

        const existing = await query('SELECT id FROM materials WHERE company_id = $1 AND sku = $2', [parseInt(company_id), row.sku]);

        if (existing.rows[0]) {
          await query(`
            UPDATE materials SET name=$1, min_stock=COALESCE($2,min_stock),
              standard_cost=COALESCE($3,standard_cost), updated_at=NOW()
            WHERE id=$4
          `, [row.name, row.min_stock||null, row.standard_cost||null, existing.rows[0].id]);
          results.updated++;
        } else {
          await query(`
            INSERT INTO materials (company_id, sku, name, category, uom, min_stock, standard_cost, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          `, [parseInt(company_id), row.sku, row.name, row.category,
              row.uom||'pcs', row.min_stock||0, row.standard_cost||null, req.user.id]);
          results.created++;
        }
      } catch (err) {
        results.errors.push({ row: row.sku, error: err.message });
      }
    }

    res.json({ success: true, message: `Import complete: ${results.created} created, ${results.updated} updated, ${results.errors.length} errors.`, data: results });
  } catch (error) { next(error); }
});

// ─── IMPORT TEMPLATE ─────────────────────────────────────────
router.get('/import/template', async (req, res, next) => {
  try {
    const template = {
      headers: [
        'sku','name','category','subcategory','uom','min_stock',
        'reorder_point','standard_cost','currency','fiber_count',
        'reel_length','fiber_type','manufacturer','barcode_supplier','notes'
      ],
      example_rows: [
        {
          sku: 'FIB-96F-001', name: 'Cable Fibra 96F OS2',
          category: 'fiber_cable', subcategory: 'backbone',
          uom: 'm', min_stock: 500, reorder_point: 1000,
          standard_cost: 18.50, currency: 'MXN',
          fiber_count: 96, reel_length: 2000, fiber_type: 'OS2',
          manufacturer: 'Corning', barcode_supplier: '', notes: ''
        },
        {
          sku: 'SPL-1X8-SC', name: 'Splitter 1x8 SC/APC',
          category: 'splitter', subcategory: '',
          uom: 'pcs', min_stock: 20, reorder_point: 50,
          standard_cost: 85, currency: 'MXN',
          fiber_count: '', reel_length: '', fiber_type: '',
          manufacturer: 'PLC Multimode', barcode_supplier: '', notes: ''
        },
        {
          sku: 'ONT-HUA-001', name: 'ONT Huawei HG8310M',
          category: 'ont', subcategory: '',
          uom: 'pcs', min_stock: 10, reorder_point: 25,
          standard_cost: 450, currency: 'MXN',
          fiber_count: '', reel_length: '', fiber_type: '',
          manufacturer: 'Huawei', barcode_supplier: '', notes: ''
        }
      ],
      valid_categories: [
        'fiber_cable','splitter','ont','closure','patch_cord',
        'odf','connector','drop_cable','pole_hardware',
        'duct_conduit','splice_tray','tool','vehicle',
        'safety_equipment','consumable','other'
      ],
      valid_uom: ['m','ft','pcs','reel','box','unit','kg','lt','roll','pair'],
      valid_currencies: ['MXN','USD'],
      required_fields: ['sku','name','category','uom']
    };

    res.json({ success: true, data: template });
  } catch (error) { next(error); }
});

module.exports = router;
