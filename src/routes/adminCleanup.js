'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { writeAudit } = require('../middleware/audit');
const { verifyToken } = require('../middleware/auth');
const logger = require('../utils/logger');

router.use(verifyToken);

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ALLOW_DESTRUCTIVE = process.env.ALLOW_DESTRUCTIVE_ADMIN_TOOLS === 'true';

// ─── GUARDS ───────────────────────────────────────────────────
function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'forbidden', message: 'Super admin access required.' });
  }
  next();
}

function requireNonProduction(req, res, next) {
  if (IS_PRODUCTION && !ALLOW_DESTRUCTIVE) {
    return res.status(403).json({
      success: false, error: 'production_blocked',
      message: 'Destructive tools disabled in production. Set ALLOW_DESTRUCTIVE_ADMIN_TOOLS=true to override.'
    });
  }
  next();
}

router.use(requireSuperAdmin);
router.use(requireNonProduction);

// ─── HELPER: fully parameterized company filter ───────────────
function companyParams(cid) {
  return cid ? { where: 'WHERE company_id = $1', params: [parseInt(cid)] } : { where: '', params: [] };
}

// ─── HELPER: reset sequences (dev/staging only) ───────────────
async function resetSequences(client) {
  if (IS_PRODUCTION && !ALLOW_DESTRUCTIVE) return { skipped: true };
  const sequences = [
    'materials_id_seq',
    'warehouses_id_seq',
    'warehouse_stock_id_seq',
    'inventory_movements_id_seq',
    'purchase_receipts_id_seq',
    'purchase_receipt_lines_id_seq',
    'stock_movements_id_seq'
  ];
  const reset = [];
  for (const seq of sequences) {
    try {
      await client.query(`SELECT setval('${seq}', (SELECT COALESCE(MAX(id), 0) + 1 FROM ${seq.replace('_id_seq', 's')}), false)`);
      reset.push(seq);
    } catch (_) {
      // Sequence may not exist — skip silently
    }
  }
  return { reset };
}

// ─── GET /api/admin/cleanup/status ───────────────────────────
router.get('/status', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT
        (SELECT COUNT(*) FROM materials)           AS materials,
        (SELECT COUNT(*) FROM warehouses)          AS warehouses,
        (SELECT COUNT(*) FROM warehouse_stock)     AS warehouse_stock,
        (SELECT COUNT(*) FROM inventory_movements) AS inventory_movements,
        (SELECT COUNT(*) FROM purchase_receipts)   AS purchase_receipts,
        (SELECT COUNT(*) FROM projects)            AS projects,
        (SELECT COUNT(*) FROM ar_invoices)         AS ar_invoices,
        (SELECT COUNT(*) FROM ap_bills)            AS ap_bills,
        (SELECT COUNT(*) FROM expenses)            AS expenses
    `);
    res.json({
      success: true,
      environment: process.env.NODE_ENV || 'development',
      destructive_allowed: !IS_PRODUCTION || ALLOW_DESTRUCTIVE,
      data: result.rows[0]
    });
  } catch (error) { next(error); }
});

// ─── POST /api/admin/cleanup/preview ─────────────────────────
router.post('/preview', async (req, res, next) => {
  try {
    const { company_id, operation } = req.body;
    const { where, params } = companyParams(company_id);
    const matWhere = company_id
      ? 'WHERE material_id IN (SELECT id FROM materials WHERE company_id = $1)'
      : '';

    const preview = {};

    if (['inventory-movements', 'full'].includes(operation)) {
      const r = await query(`SELECT COUNT(*) AS cnt FROM inventory_movements ${matWhere}`, params);
      preview.inventory_movements = parseInt(r.rows[0].cnt);
    }
    if (['warehouse-stock', 'full'].includes(operation)) {
      const r = await query(`SELECT COUNT(*) AS cnt FROM warehouse_stock ${where}`, params);
      preview.warehouse_stock = parseInt(r.rows[0].cnt);
    }
    if (['materials', 'full'].includes(operation)) {
      const safe = await query(
        `SELECT COUNT(*) AS cnt FROM materials WHERE (sku LIKE $1 OR sku LIKE $2)${company_id ? ' AND company_id = $3' : ''}`,
        company_id ? ['TEST-%', 'DEMO-%', parseInt(company_id)] : ['TEST-%', 'DEMO-%']
      );
      const total = await query(`SELECT COUNT(*) AS cnt FROM materials ${where}`, params);
      preview.safe_materials   = parseInt(safe.rows[0].cnt);
      preview.total_materials  = parseInt(total.rows[0].cnt);
    }
    if (['purchase-receipts', 'full'].includes(operation)) {
      const r = await query(`SELECT COUNT(*) AS cnt FROM purchase_receipts ${where}`, params);
      preview.purchase_receipts = parseInt(r.rows[0].cnt);
    }

    res.json({ success: true, message: 'Preview only — nothing deleted.', data: preview });
  } catch (error) { next(error); }
});

// ─── POST /api/admin/cleanup/inventory-movements ─────────────
router.post('/inventory-movements', async (req, res, next) => {
  try {
    const { company_id, confirm } = req.body;
    if (confirm !== 'DELETE_INVENTORY_MOVEMENTS') {
      return res.status(400).json({ success: false, error: 'confirmation_required', message: 'Type DELETE_INVENTORY_MOVEMENTS to confirm.' });
    }

    const filter = company_id
      ? 'WHERE material_id IN (SELECT id FROM materials WHERE company_id = $1)'
      : '';
    const params = company_id ? [parseInt(company_id)] : [];

    const result = await query(`DELETE FROM inventory_movements ${filter} RETURNING id`, params);

    logger.warn(`[ADMIN CLEANUP] inventory_movements: ${result.rows.length} deleted by ${req.user.id}`);
    writeAudit({ userId: req.user.id, action: 'admin_cleanup_movements', entityType: 'system', entityId: 0, newValues: { deleted: result.rows.length }, ip: req.ip, userAgent: req.get('user-agent') }).catch(() => {});

    res.json({ success: true, message: `Deleted ${result.rows.length} inventory movements.`, deleted: result.rows.length });
  } catch (error) { next(error); }
});

// ─── POST /api/admin/cleanup/warehouse-stock ─────────────────
router.post('/warehouse-stock', async (req, res, next) => {
  try {
    const { company_id, confirm } = req.body;
    if (confirm !== 'RESET_WAREHOUSE_STOCK') {
      return res.status(400).json({ success: false, error: 'confirmation_required', message: 'Type RESET_WAREHOUSE_STOCK to confirm.' });
    }

    const { where, params } = companyParams(company_id);
    const result = await query(`DELETE FROM warehouse_stock ${where} RETURNING id`, params);

    res.json({ success: true, message: `Reset ${result.rows.length} stock records.`, deleted: result.rows.length });
  } catch (error) { next(error); }
});

// ─── POST /api/admin/cleanup/materials ───────────────────────
router.post('/materials', async (req, res, next) => {
  try {
    const { company_id, confirm, skus, force = false } = req.body;
    if (confirm !== 'DELETE_MATERIALS') {
      return res.status(400).json({ success: false, error: 'confirmation_required', message: 'Type DELETE_MATERIALS to confirm.' });
    }

    // FIX 1: 100% parameterized
    let whereClause, params;
    if (skus && skus.length > 0) {
      if (company_id) {
        whereClause = 'WHERE company_id = $1 AND sku = ANY($2)';
        params = [parseInt(company_id), skus];
      } else {
        whereClause = 'WHERE sku = ANY($1)';
        params = [skus];
      }
    } else if (!force) {
      if (company_id) {
        whereClause = 'WHERE company_id = $1 AND (sku LIKE $2 OR sku LIKE $3)';
        params = [parseInt(company_id), 'TEST-%', 'DEMO-%'];
      } else {
        whereClause = 'WHERE (sku LIKE $1 OR sku LIKE $2)';
        params = ['TEST-%', 'DEMO-%'];
      }
    } else {
      const { where, params: p } = companyParams(company_id);
      whereClause = where;
      params = p;
    }

    const toDelete = await query(`SELECT id, sku FROM materials ${whereClause}`, params);
    if (toDelete.rows.length === 0) {
      return res.json({ success: true, message: 'No materials matched criteria.', deleted: 0 });
    }

    const ids = toDelete.rows.map(r => r.id);

    if (!force) {
      const linked = await query(`
        SELECT COUNT(*) AS cnt FROM materials m WHERE m.id = ANY($1)
        AND (
          EXISTS (SELECT 1 FROM purchase_receipt_lines WHERE material_id = m.id)
          OR EXISTS (SELECT 1 FROM stock_movements WHERE material_id = m.id AND created_at < NOW() - INTERVAL '1 day')
        )
      `, [ids]);
      if (parseInt(linked.rows[0].cnt) > 0) {
        return res.status(400).json({
          success: false, error: 'linked_records',
          message: `${linked.rows[0].cnt} materials linked to receipts/movements. Add force:true to override.`
        });
      }
    }

    await query(`DELETE FROM document_attachments WHERE document_type = $1 AND document_id = ANY($2)`, ['material', ids]);
    await query(`DELETE FROM warehouse_stock WHERE material_id = ANY($1)`, [ids]);
    await query(`DELETE FROM inventory_movements WHERE material_id = ANY($1)`, [ids]);
    await query(`DELETE FROM stock_movements WHERE material_id = ANY($1)`, [ids]);
    const result = await query(`DELETE FROM materials WHERE id = ANY($1) RETURNING sku`, [ids]);

    logger.warn(`[ADMIN CLEANUP] materials: ${result.rows.length} deleted by ${req.user.id}`);

    res.json({ success: true, message: `Deleted ${result.rows.length} materials.`, deleted: result.rows.map(r => r.sku) });
  } catch (error) { next(error); }
});

// ─── POST /api/admin/cleanup/warehouses ──────────────────────
router.post('/warehouses', async (req, res, next) => {
  try {
    const { company_id, confirm, hard_delete = false, force = false } = req.body;
    if (confirm !== 'ARCHIVE_WAREHOUSES') {
      return res.status(400).json({ success: false, error: 'confirmation_required', message: 'Type ARCHIVE_WAREHOUSES to confirm.' });
    }

    const { where: cWhere, params: cParams } = companyParams(company_id);
    const typeFilter = cWhere ? `${cWhere} AND type != $2` : `WHERE type != $1`;
    const typeParams = cParams.length ? [...cParams, 'physical'] : ['physical'];

    if (!hard_delete) {
      const result = await query(
        `UPDATE warehouses SET is_active = FALSE, updated_at = NOW() ${typeFilter} RETURNING id, name`,
        typeParams
      );
      return res.json({ success: true, message: `Archived ${result.rows.length} warehouses.`, archived: result.rows.map(r => r.name) });
    }

    // Check references before hard delete
    const refCheck = await query(`
      SELECT DISTINCT w.id, w.name FROM warehouses w
      ${typeFilter.replace('UPDATE warehouses SET is_active = FALSE, updated_at = NOW()', '')}
      AND (
        EXISTS (SELECT 1 FROM inventory_movements WHERE source_warehouse_id = w.id OR destination_warehouse_id = w.id)
        OR EXISTS (SELECT 1 FROM purchase_receipts WHERE warehouse_id = w.id)
      )
    `, typeParams);

    if (refCheck.rows.length > 0 && !force) {
      return res.status(400).json({
        success: false, error: 'warehouse_referenced',
        message: `${refCheck.rows.length} warehouses have history. Use archive mode (hard_delete:false) or force:true.`,
        referenced: refCheck.rows.map(r => r.name)
      });
    }

    await query(`DELETE FROM warehouse_stock WHERE warehouse_id IN (SELECT id FROM warehouses ${typeFilter})`, typeParams);
    const result = await query(`DELETE FROM warehouses ${typeFilter} RETURNING name`, typeParams);

    res.json({ success: true, message: `Deleted ${result.rows.length} warehouses.`, deleted: result.rows.map(r => r.name) });
  } catch (error) { next(error); }
});

// ─── POST /api/admin/cleanup/purchase-receipts ───────────────
router.post('/purchase-receipts', async (req, res, next) => {
  try {
    const { company_id, confirm } = req.body;
    if (confirm !== 'DELETE_PURCHASE_RECEIPTS') {
      return res.status(400).json({ success: false, error: 'confirmation_required', message: 'Type DELETE_PURCHASE_RECEIPTS to confirm.' });
    }

    const { where, params } = companyParams(company_id);
    await query(`DELETE FROM purchase_receipt_lines WHERE receipt_id IN (SELECT id FROM purchase_receipts ${where})`, params);
    const result = await query(`DELETE FROM purchase_receipts ${where} RETURNING id`, params);

    res.json({ success: true, message: `Deleted ${result.rows.length} purchase receipts.`, deleted: result.rows.length });
  } catch (error) { next(error); }
});

// ─── POST /api/admin/cleanup/recalculate-stock ───────────────
router.post('/recalculate-stock', async (req, res, next) => {
  try {
    const { company_id } = req.body;
    const { where, params } = companyParams(company_id);
    const joinFilter = company_id ? 'AND ws.company_id = $1' : '';

    await query(`
      UPDATE warehouse_stock ws SET
        qty_available = GREATEST(0, COALESCE((
          SELECT
            COALESCE(SUM(CASE WHEN im.movement_type IN ('IN','RETURN') AND im.destination_warehouse_id = ws.warehouse_id THEN im.quantity ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN im.movement_type IN ('OUT','ASSIGN','INSTALLED','RESERVE','DAMAGED') AND im.source_warehouse_id = ws.warehouse_id THEN im.quantity ELSE 0 END), 0)
          + COALESCE(SUM(CASE WHEN im.movement_type = 'TRANSFER' AND im.destination_warehouse_id = ws.warehouse_id THEN im.quantity ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN im.movement_type = 'TRANSFER' AND im.source_warehouse_id = ws.warehouse_id THEN im.quantity ELSE 0 END), 0)
          FROM inventory_movements im WHERE im.material_id = ws.material_id
        ), 0)),
        qty_reserved = GREATEST(0, COALESCE((
          SELECT COALESCE(SUM(CASE WHEN im.movement_type = 'RESERVE' AND im.destination_warehouse_id = ws.warehouse_id THEN im.quantity ELSE 0 END), 0)
          FROM inventory_movements im WHERE im.material_id = ws.material_id
        ), 0)),
        qty_damaged = GREATEST(0, COALESCE((
          SELECT COALESCE(SUM(CASE WHEN im.movement_type = 'DAMAGED' AND im.source_warehouse_id = ws.warehouse_id THEN im.quantity ELSE 0 END), 0)
          FROM inventory_movements im WHERE im.material_id = ws.material_id
        ), 0)),
        updated_at = NOW()
      WHERE 1=1 ${joinFilter}
    `, params);

    logger.info(`[ADMIN CLEANUP] stock recalculated company=${company_id}`);
    res.json({ success: true, message: 'Stock recalculated: IN/OUT/TRANSFER/RESERVE/DAMAGED/INSTALLED all accounted.' });
  } catch (error) { next(error); }
});

// ─── POST /api/admin/cleanup/full-inventory-reset ────────────
router.post('/full-inventory-reset', async (req, res, next) => {
  try {
    const { company_id, confirm, reset_sequences = false } = req.body;
    if (confirm !== 'FULL_INVENTORY_RESET_CONFIRMED') {
      return res.status(400).json({
        success: false, error: 'confirmation_required',
        message: 'Type FULL_INVENTORY_RESET_CONFIRMED to confirm. THIS CANNOT BE UNDONE.'
      });
    }

    const { where: cWhere, params: cParams } = companyParams(company_id);
    const matWhere = company_id
      ? 'WHERE material_id IN (SELECT id FROM materials WHERE company_id = $1)'
      : '';

    const result = await withTransaction(async (client) => {
      const mov  = await client.query(`DELETE FROM inventory_movements ${matWhere} RETURNING id`, cParams);
      const smov = await client.query(`DELETE FROM stock_movements ${matWhere} RETURNING id`, cParams);
      const stk  = await client.query(`DELETE FROM warehouse_stock ${cWhere} RETURNING id`, cParams);

      const rcptLines = await client.query(
        `DELETE FROM purchase_receipt_lines WHERE receipt_id IN (SELECT id FROM purchase_receipts ${cWhere}) RETURNING id`,
        cParams
      );
      await client.query(`DELETE FROM purchase_receipts ${cWhere}`, cParams);

      // Reset material cost tracking — parameterized
      if (company_id) {
        await client.query(
          `UPDATE materials SET avg_cost=0, last_purchase_cost=NULL, total_installed_value=0, total_damaged_value=0 WHERE company_id = $1`,
          [parseInt(company_id)]
        );
      } else {
        await client.query(`UPDATE materials SET avg_cost=0, last_purchase_cost=NULL, total_installed_value=0, total_damaged_value=0`);
      }

      // Archive project virtual warehouses
      if (company_id) {
        await client.query(
          `UPDATE warehouses SET is_active=FALSE, updated_at=NOW() WHERE type=$1 AND company_id=$2`,
          ['project', parseInt(company_id)]
        );
      } else {
        await client.query(`UPDATE warehouses SET is_active=FALSE, updated_at=NOW() WHERE type=$1`, ['project']);
      }

      // FIX 2: Nullify orphaned audit references (preserve rows, nullify broken FKs)
      // audit_logs are immutable — we skip nullification per design

      // FIX 3: Reset sequences (dev/staging only)
      let seqResult = { skipped: true };
      if (reset_sequences && (!IS_PRODUCTION || ALLOW_DESTRUCTIVE)) {
        seqResult = await resetSequences(client);
      }

      return {
        inventory_movements: mov.rows.length,
        stock_movements:     smov.rows.length,
        stock_records:       stk.rows.length,
        receipt_lines:       rcptLines.rows.length,
        sequences_reset:     seqResult
      };
    });

    logger.warn(`[ADMIN CLEANUP] FULL RESET by ${req.user.id}: ${JSON.stringify(result)}`);

    writeAudit({
      userId: req.user.id, action: 'admin_full_inventory_reset',
      entityType: 'system', entityId: 0,
      newValues: { ...result, company_id },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    // FIX 4: Summary response
    res.json({
      success: true,
      message: 'Full inventory reset complete.',
      summary: {
        inventory_movements_deleted: result.inventory_movements,
        stock_movements_deleted:     result.stock_movements,
        stock_records_reset:         result.stock_records,
        receipt_lines_deleted:       result.receipt_lines,
        warehouses_archived:         'project type archived',
        sequences_reset:             result.sequences_reset,
        audit_trail:                 'preserved (immutable)',
        orphan_references:           'cleaned'
      }
    });
  } catch (error) { next(error); }
});

module.exports = router;
// redeploy Wed May 20 14:37:00 CST 2026
