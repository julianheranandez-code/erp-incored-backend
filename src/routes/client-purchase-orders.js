'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

const COMPANY_CODES = { 1:'INC', 2:'ZHA', 3:'INT', 4:'MIK' };

// GET /api/client-pos
router.get('/', async (req, res, next) => {
  try {
    const { company_id, client_id, project_id, status } = req.query;
    let conditions = ['cpo.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (client_id) { conditions.push(`cpo.client_id = $${idx++}`); values.push(parseInt(client_id)); }
    if (project_id) { conditions.push(`cpo.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (status) { conditions.push(`cpo.status = $${idx++}`); values.push(status); }
    const result = await query(`
      SELECT cpo.*, c.name AS client_name, p.name AS project_name, p.code AS project_code
      FROM client_purchase_orders cpo
      LEFT JOIN clients c ON c.id = cpo.client_id
      LEFT JOIN projects p ON p.id = cpo.project_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY cpo.created_at DESC
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/client-pos/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT cpo.*, c.name AS client_name, p.name AS project_name, p.code AS project_code
      FROM client_purchase_orders cpo
      LEFT JOIN clients c ON c.id = cpo.client_id
      LEFT JOIN projects p ON p.id = cpo.project_id
      WHERE cpo.id = $1
    `, [parseInt(req.params.id)]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// POST /api/client-pos
router.post('/', async (req, res, next) => {
  try {
    const { company_id, client_id, project_id, client_po_number,
      description, total_amount, currency, exchange_rate,
      issue_date, start_date, end_date, payment_conditions,
      advance_percent, notes } = req.body;

    if (!company_id || !client_id || !total_amount)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, client_id, total_amount' });

    const compCode = COMPANY_CODES[parseInt(company_id)] || 'INC';
    const now = new Date();
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const yy = String(now.getFullYear()).slice(-2);
    const countResult = await query(
      'SELECT COUNT(*) as cnt FROM client_purchase_orders WHERE company_id=$1', [parseInt(company_id)]
    );
    const seq = String(parseInt(countResult.rows[0].cnt) + 1).padStart(3,'0');
    const folio = `OR-${compCode}-${mm}${yy}-${seq}`;

    const result = await query(`
      INSERT INTO client_purchase_orders
        (company_id, client_id, project_id, folio, po_number, client_po_number,
         description, total_amount, invoiced_amount, remaining_amount,
         currency, exchange_rate, issue_date, start_date, end_date,
         payment_conditions, advance_percent, advance_amount, status, notes, created_by)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7,0,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active',$16,$17)
      RETURNING *
    `, [parseInt(company_id), parseInt(client_id),
        project_id ? parseInt(project_id) : null,
        folio, client_po_number || null, description || null,
        parseFloat(total_amount), currency || 'MXN', parseFloat(exchange_rate||1),
        issue_date || null, start_date || null, end_date || null,
        payment_conditions || null, parseFloat(advance_percent||0),
        advance_percent ? (parseFloat(total_amount)*parseFloat(advance_percent)/100) : 0,
        notes || null, req.user.id]);

    res.status(201).json({ success: true, data: result.rows[0],
      message: `Orden de compra ${folio} creada exitosamente.` });
  } catch(e) { next(e); }
});

// PUT /api/client-pos/:id
router.put('/:id', async (req, res, next) => {
  try {
    const allowed = ['project_id','description','total_amount','currency',
      'start_date','end_date','payment_conditions','advance_percent','notes','status'];
    const fields = [];
    const params = [];
    let idx = 1;
    for (const key of allowed) {
      if (key in req.body) { fields.push(`${key} = $${idx++}`); params.push(req.body[key]); }
    }
    if (!fields.length) return res.status(400).json({ success: false, error: 'no_fields' });
    params.push(parseInt(req.params.id));
    const result = await query(
      `UPDATE client_purchase_orders SET ${fields.join(', ')}, updated_at=NOW() WHERE id=$${idx} RETURNING *`, params);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

module.exports = router;
