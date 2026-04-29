'use strict';

const { query, withTransaction } = require('../config/database');

class Inventory {
  // ── Materials ───────────────────────────────────────────────────────────────

  static async findAllMaterials({ companyId, category, search, lowStock, page = 1, limit = 20 }) {
    const conditions = [`m.is_active = true`];
    const params = [];
    let idx = 1;

    if (companyId) { conditions.push(`m.company_id = $${idx++}`); params.push(companyId); }
    if (category) { conditions.push(`m.category = $${idx++}`); params.push(category); }
    if (search) {
      conditions.push(`(m.name ILIKE $${idx} OR m.sku ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }
    if (lowStock) {
      conditions.push(`m.quantity_stock <= m.quantity_min`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT m.*, s.name AS supplier_name, co.name AS company_name,
                (m.quantity_stock * COALESCE(m.cost_average, m.cost_last_purchase, 0)) AS valuation
         FROM inventory_materials m
         LEFT JOIN clients s ON s.id = m.supplier_id
         LEFT JOIN companies co ON co.id = m.company_id
         ${where}
         ORDER BY m.name ASC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) AS total FROM inventory_materials m ${where}`, params),
    ]);

    return { data: rows.rows, total: parseInt(countResult.rows[0].total) };
  }

  static async findMaterialById(id) {
    const [material, movements] = await Promise.all([
      query(
        `SELECT m.*, s.name AS supplier_name, co.name AS company_name
         FROM inventory_materials m
         LEFT JOIN clients s ON s.id = m.supplier_id
         LEFT JOIN companies co ON co.id = m.company_id
         WHERE m.id = $1`,
        [id]
      ),
      query(
        `SELECT mv.*, CONCAT(u.first_name, ' ', u.last_name) AS created_by_name, p.name AS project_name
         FROM inventory_movements mv
         LEFT JOIN users u ON u.id = mv.created_by
         LEFT JOIN projects p ON p.id = mv.project_id
         WHERE mv.material_id = $1
         ORDER BY mv.created_at DESC LIMIT 20`,
        [id]
      ),
    ]);
    if (!material.rows[0]) return null;
    return { ...material.rows[0], recent_movements: movements.rows };
  }

  static async createMaterial(data) {
    const result = await query(
      `INSERT INTO inventory_materials
         (sku, name, category, quantity_min, quantity_max, unit_of_measure,
          cost_last_purchase, company_id, supplier_id, location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        data.sku, data.name, data.category || null,
        data.quantity_min || null, data.quantity_max || null,
        data.unit_of_measure || 'unidad', data.cost_last_purchase || null,
        data.company_id, data.supplier_id || null, data.location || null,
      ]
    );
    return result.rows[0];
  }

  static async registerMovement(materialId, data, createdBy) {
    return withTransaction(async (client) => {
      // Get current stock
      const matResult = await client.query(
        `SELECT quantity_stock, cost_average FROM inventory_materials WHERE id = $1 FOR UPDATE`,
        [materialId]
      );
      if (!matResult.rows[0]) throw new Error('Material no encontrado');

      const current = parseFloat(matResult.rows[0].quantity_stock);
      let newStock;

      switch (data.type) {
        case 'entrada':
        case 'devolucion':
          newStock = current + Math.abs(data.quantity);
          break;
        case 'salida':
          newStock = current - Math.abs(data.quantity);
          if (newStock < 0) throw new Error('Stock insuficiente para esta salida');
          break;
        case 'ajuste':
          newStock = data.quantity; // absolute value for adjustments
          break;
        case 'transferencia':
          newStock = current - Math.abs(data.quantity);
          if (newStock < 0) throw new Error('Stock insuficiente para transferencia');
          break;
        default:
          throw new Error('Tipo de movimiento inválido');
      }

      // Update stock
      const totalCost = data.unit_cost ? Math.abs(data.quantity) * data.unit_cost : null;
      await client.query(
        `UPDATE inventory_materials
         SET quantity_stock = $1, last_movement_date = CURRENT_DATE,
             cost_last_purchase = COALESCE($2, cost_last_purchase),
             updated_at = NOW()
         WHERE id = $3`,
        [newStock, data.unit_cost || null, materialId]
      );

      // Insert movement record
      const movement = await client.query(
        `INSERT INTO inventory_movements
           (material_id, type, quantity, quantity_before, quantity_after, unit_cost, total_cost,
            project_id, company_from, company_to, reference_number, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          materialId, data.type, data.quantity, current, newStock,
          data.unit_cost || null, totalCost,
          data.project_id || null, data.company_from || null, data.company_to || null,
          data.reference_number || null, data.notes || null, createdBy,
        ]
      );

      return { movement: movement.rows[0], new_stock: newStock };
    });
  }

  // ── Tools ───────────────────────────────────────────────────────────────────

  static async findAllTools({ companyId, status, search, page = 1, limit = 20 }) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (companyId) { conditions.push(`t.company_id = $${idx++}`); params.push(companyId); }
    if (status) { conditions.push(`t.status = $${idx++}`); params.push(status); }
    if (search) {
      conditions.push(`(t.name ILIKE $${idx} OR t.code ILIKE $${idx} OR t.serial_number ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT t.*, co.name AS company_name, p.name AS project_name
         FROM inventory_tools t
         LEFT JOIN companies co ON co.id = t.company_id
         LEFT JOIN projects p ON p.id = t.current_project
         ${where} ORDER BY t.name ASC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) AS total FROM inventory_tools t ${where}`, params),
    ]);
    return { data: rows.rows, total: parseInt(countResult.rows[0].total) };
  }

  // ── Vehicles ─────────────────────────────────────────────────────────────────

  static async findAllVehicles({ companyId, status, page = 1, limit = 20 }) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (companyId) { conditions.push(`v.company_id = $${idx++}`); params.push(companyId); }
    if (status) { conditions.push(`v.status = $${idx++}`); params.push(status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT v.*, co.name AS company_name, p.name AS project_name
         FROM inventory_vehicles v
         LEFT JOIN companies co ON co.id = v.company_id
         LEFT JOIN projects p ON p.id = v.current_project
         ${where} ORDER BY v.brand, v.model LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) AS total FROM inventory_vehicles v ${where}`, params),
    ]);
    return { data: rows.rows, total: parseInt(countResult.rows[0].total) };
  }

  static async getInventoryReport(companyId) {
    const result = await query(
      `SELECT category,
              COUNT(*) AS total_skus,
              SUM(quantity_stock) AS total_units,
              SUM(quantity_stock * COALESCE(cost_average, cost_last_purchase, 0)) AS total_value,
              COUNT(CASE WHEN quantity_stock <= quantity_min THEN 1 END) AS low_stock_count
       FROM inventory_materials
       WHERE company_id = $1 AND is_active = true
       GROUP BY category
       ORDER BY total_value DESC`,
      [companyId]
    );
    return result.rows;
  }
}

module.exports = Inventory;
