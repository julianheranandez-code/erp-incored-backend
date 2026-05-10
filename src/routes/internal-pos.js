'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { auditInvoiceCreated, writeAudit } = require('../middleware/audit');
const { queueRefresh, afterMutation } = require('../services/financeRefresh');

router.use(verifyToken);

// ─── MULTI-COMPANY ISOLATION ──────────────────────────────────
function getAuthorizedCompanyId(user, requestedCompanyId) {
  if (user.role === 'admin') {
    return requestedCompanyId ? parseInt(requestedCompanyId) : null;
  }
  return parseInt(user.company_id);
}

async function assertIPOAccess(poId, user) {
  const result = await query(
    'SELECT id, company_id, project_id, status FROM internal_purchase_orders WHERE id = $1',
    [poId]
  );
  if (!result.rows[0]) return { error: 'not_found', message: 'Purchase order not found.' };
  if (user.role !== 'admin' && result.rows[0].company_id !== parseInt(user.company_id)) {
    return { error: 'forbidden', message: 'Access denied to this purchase order.' };
  }
  return { po: result.rows[0] };
}

// ─── GET /api/internal-pos ────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, sort = 'created_at', order = 'DESC',
            project_id, status, category, vendor_id } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`p.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (project_id)          { conditions.push(`p.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (status)              { conditions.push(`p.status = $${idx++}`);     values.push(status); }
    if (category)            { conditions.push(`p.category = $${idx++}`);   values.push(category); }
    if (vendor_id)           { conditions.push(`p.vendor_id = $${idx++}`);  values.push(parseInt(vendor_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const validSorts = ['created_at','issue_date','total_amount','status','po_number'];
    const sortField = validSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'ASC' ? 'ASC' : 'DESC';

    const [pos, summary, total] = await Promise.all([
      query(`
        SELECT
          p.*,
          v.name AS vendor_name,
          pr.name AS project_name, pr.code AS project_code,
          co.name AS company_name,
          CONCAT(u.first_name, ' ', u.last_name) AS created_by_name,
          CONCAT(ua.first_name, ' ', ua.last_name) AS approved_by_name
        FROM internal_purchase_orders p
        LEFT JOIN clients v    ON v.id = p.vendor_id
        LEFT JOIN projects pr  ON pr.id = p.project_id
        LEFT JOIN companies co ON co.id = p.company_id
        LEFT JOIN users u      ON u.id = p.created_by
        LEFT JOIN users ua     ON ua.id = p.approved_by
        ${where}
        ORDER BY p.${sortField} ${sortOrder}
        LIMIT $${idx} OFFSET $${idx + 1}
      `, [...values, parseInt(limit), offset]),

      query(`
        SELECT
          COUNT(*) AS total_pos,
          COALESCE(SUM(total_amount), 0) AS total_committed,
          COALESCE(SUM(total_amount) FILTER (WHERE status = 'approved'), 0) AS total_approved,
          COALESCE(SUM(total_amount) FILTER (WHERE status = 'draft'), 0) AS total_draft,
          COALESCE(SUM(total_amount) FILTER (WHERE status = 'pending_approval'), 0) AS total_pending
        FROM internal_purchase_orders p
        ${where}
      `, values),

      query(`SELECT COUNT(*) AS total FROM internal_purchase_orders p ${where}`, values)
    ]);

    res.json({
      success: true,
      data: {
        purchase_orders: pos.rows,
        summary: summary.rows[0],
        pagination: {
          total: parseInt(total.rows[0].total),
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(parseInt(total.rows[0].total) / parseInt(limit))
        }
      }
    });
  } catch (error) { next(error); }
});

// ─── GET /api/internal-pos/:id ────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const access = await assertIPOAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    const [po, items] = await Promise.all([
      query(`
        SELECT
          p.*,
          v.name AS vendor_name, v.rfc AS vendor_rfc,
          pr.name AS project_name, pr.code AS project_code,
          co.name AS company_name, co.short_code AS company_code,
          CONCAT(u.first_name, ' ', u.last_name) AS created_by_name,
          CONCAT(ua.first_name, ' ', ua.last_name) AS approved_by_name
        FROM internal_purchase_orders p
        LEFT JOIN clients v    ON v.id = p.vendor_id
        LEFT JOIN projects pr  ON pr.id = p.project_id
        LEFT JOIN companies co ON co.id = p.company_id
        LEFT JOIN users u      ON u.id = p.created_by
        LEFT JOIN users ua     ON ua.id = p.approved_by
        WHERE p.id = $1
      `, [id]),
      query(`
        SELECT * FROM internal_purchase_order_items
        WHERE internal_po_id = $1
        ORDER BY line_order ASC
      `, [id])
    ]);

    res.json({
      success: true,
      data: { purchase_order: po.rows[0], items: items.rows }
    });
  } catch (error) { next(error); }
});

// ─── POST /api/internal-pos ───────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const {
      company_id, project_id, vendor_id, po_number, category,
      currency = 'MXN', exchange_rate = 1,
      subtotal, tax_percent = 16,
      issue_date, expected_delivery_date, notes,
      items = []
    } = req.body;

    if (!company_id || !project_id || !po_number || !category || !subtotal) {
      return res.status(400).json({
        success: false, error: 'validation_error',
        message: 'Required: company_id, project_id, po_number, category, subtotal'
      });
    }

    // Multi-company isolation
    if (req.user.role !== 'admin' && parseInt(company_id) !== parseInt(req.user.company_id)) {
      return res.status(403).json({
        success: false, error: 'forbidden',
        message: 'You can only create POs for your own company.'
      });
    }

    const tax_amount   = parseFloat(subtotal) * (parseFloat(tax_percent) / 100);
    const total_amount = parseFloat(subtotal) + tax_amount;
    const created_by   = req.user.id;

    const result = await withTransaction(async (client) => {
      // 1. Create PO
      const po = await client.query(`
        INSERT INTO internal_purchase_orders (
          company_id, project_id, vendor_id, po_number, category,
          currency, exchange_rate,
          subtotal, tax_percent, tax_amount, total_amount,
          issue_date, expected_delivery_date, notes,
          status, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15)
        RETURNING *
      `, [
        parseInt(company_id), parseInt(project_id),
        vendor_id ? parseInt(vendor_id) : null,
        po_number, category,
        currency, parseFloat(exchange_rate),
        parseFloat(subtotal), parseFloat(tax_percent), tax_amount, total_amount,
        issue_date || new Date().toISOString().split('T')[0],
        expected_delivery_date || null, notes || null,
        created_by
      ]);

      // 2. Insert line items if provided
      if (items.length > 0) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const itemTotal = parseFloat(item.quantity) * parseFloat(item.unit_cost);
          await client.query(`
            INSERT INTO internal_purchase_order_items
              (internal_po_id, description, quantity, unit, unit_cost, total_cost, line_order)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
          `, [po.rows[0].id, item.description, item.quantity, item.unit || null,
              item.unit_cost, itemTotal, i + 1]);
        }
      }

      // 3. Queue finance refresh
      await client.query(`
        INSERT INTO finance_refresh_queue (project_id, reason)
        VALUES ($1, 'internal_po.create') ON CONFLICT DO NOTHING
      `, [parseInt(project_id)]);

      return po.rows[0];
    });

    // Audit log
    await writeAudit({
      userId: req.user.id, action: 'internal_po_created',
      entityType: 'internal_purchase_orders', entityId: result.id,
      companyId: result.company_id, newValues: result,
      ip: req.ip, userAgent: req.get('user-agent')
    });

    // Background refresh
    queueRefresh(result.project_id, 'internal_po.create');

    res.status(201).json({
      success: true, message: 'Purchase order created.', data: result
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false, error: 'duplicate_po_number',
        message: 'PO number already exists for this company.'
      });
    }
    next(error);
  }
});

// ─── PUT /api/internal-pos/:id ────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const access = await assertIPOAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    const { status } = access.po;
    if (['completed','cancelled'].includes(status)) {
      return res.status(400).json({
        success: false, error: 'po_closed',
        message: `Cannot edit a ${status} purchase order.`
      });
    }

    const {
      vendor_id, category, subtotal, tax_percent,
      expected_delivery_date, notes, items
    } = req.body;

    const existing = await query('SELECT * FROM internal_purchase_orders WHERE id = $1', [id]);
    const po = existing.rows[0];

    const newSubtotal    = subtotal    ? parseFloat(subtotal)    : parseFloat(po.subtotal);
    const newTaxPercent  = tax_percent ? parseFloat(tax_percent) : parseFloat(po.tax_percent);
    const newTaxAmount   = newSubtotal * (newTaxPercent / 100);
    const newTotalAmount = newSubtotal + newTaxAmount;

    const result = await withTransaction(async (client) => {
      const updated = await client.query(`
        UPDATE internal_purchase_orders SET
          vendor_id              = COALESCE($1, vendor_id),
          category               = COALESCE($2, category),
          subtotal               = $3,
          tax_percent            = $4,
          tax_amount             = $5,
          total_amount           = $6,
          expected_delivery_date = COALESCE($7, expected_delivery_date),
          notes                  = COALESCE($8, notes),
          updated_at             = NOW()
        WHERE id = $9 RETURNING *
      `, [
        vendor_id ? parseInt(vendor_id) : null,
        category || null,
        newSubtotal, newTaxPercent, newTaxAmount, newTotalAmount,
        expected_delivery_date || null, notes || null, id
      ]);

      // Update items if provided
      if (items && items.length > 0) {
        await client.query('DELETE FROM internal_purchase_order_items WHERE internal_po_id = $1', [id]);
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const itemTotal = parseFloat(item.quantity) * parseFloat(item.unit_cost);
          await client.query(`
            INSERT INTO internal_purchase_order_items
              (internal_po_id, description, quantity, unit, unit_cost, total_cost, line_order)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
          `, [id, item.description, item.quantity, item.unit || null,
              item.unit_cost, itemTotal, i + 1]);
        }
      }

      return updated.rows[0];
    });

    // Audit
    await writeAudit({
      userId: req.user.id, action: 'internal_po_updated',
      entityType: 'internal_purchase_orders', entityId: id,
      companyId: result.company_id,
      oldValues: { subtotal: po.subtotal, total_amount: po.total_amount, status: po.status },
      newValues: { subtotal: result.subtotal, total_amount: result.total_amount },
      ip: req.ip, userAgent: req.get('user-agent')
    });

    queueRefresh(result.project_id, 'internal_po.update');

    res.json({ success: true, message: 'Purchase order updated.', data: result });
  } catch (error) { next(error); }
});

// ─── POST /api/internal-pos/:id/approve ──────────────────────
router.post('/:id/approve', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);

    // Only admin, manager, finance can approve
    if (!['admin','manager','finance','director'].includes(req.user.role)) {
      return res.status(403).json({
        success: false, error: 'forbidden',
        message: 'Insufficient permissions to approve purchase orders.'
      });
    }

    const access = await assertIPOAccess(id, req.user);
    if (access.error) {
      return res.status(access.error === 'not_found' ? 404 : 403).json({
        success: false, error: access.error, message: access.message
      });
    }

    if (access.po.status !== 'pending_approval') {
      return res.status(400).json({
        success: false, error: 'invalid_status',
        message: `Only pending_approval POs can be approved. Current: ${access.po.status}`
      });
    }

    const { approved_amount, notes } = req.body;

    const result = await query(`
      UPDATE internal_purchase_orders SET
        status          = 'approved',
        approved_by     = $1,
        approved_at     = NOW(),
        approved_amount = COALESCE($2, total_amount),
        notes           = COALESCE($3, notes),
        updated_at      = NOW()
      WHERE id = $4
      RETURNING *
    `, [
      req.user.id,
      approved_amount ? parseFloat(approved_amount) : null,
      notes || null,
      id
    ]);

    // Audit
    await writeAudit({
      userId: req.user.id, action: 'internal_po_approved',
      entityType: 'internal_purchase_orders', entityId: id,
      companyId: result.rows[0].company_id,
      oldValues: { status: 'pending_approval' },
      newValues: { status: 'approved', approved_by: req.user.id, approved_amount: result.rows[0].approved_amount },
      ip: req.ip, userAgent: req.get('user-agent')
    });

    // Refresh — approved POs affect committed costs
    queueRefresh(result.rows[0].project_id, 'internal_po.approve');

    res.json({ success: true, message: 'Purchase order approved.', data: result.rows[0] });
  } catch (error) { next(error); }
});

module.exports = router;
