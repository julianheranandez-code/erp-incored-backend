'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { getApprovalChain, resolveApprovers, getCompanyApprovalPolicy } = require('../lib/approval-engine');

router.use(verifyToken);

const COMPANY_CODES = { 1:'INC', 2:'ZHA', 3:'INT', 4:'MIK' };

// GET /api/rate-cards
router.get('/', async (req, res, next) => {
  try {
    const { company_id, type, status, client_id } = req.query;
    let conditions = ['rc.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (type) { conditions.push(`rc.type = $${idx++}`); values.push(type); }
    if (status) { conditions.push(`rc.status = $${idx++}`); values.push(status); }
    if (client_id) { conditions.push(`rc.client_id = $${idx++}`); values.push(parseInt(client_id)); }

    const result = await query(`
      SELECT rc.*, 
        c.name AS client_name,
        comp.name AS company_name,
        CONCAT(u.first_name,' ',u.last_name) AS created_by_name,
        COUNT(rci.id) AS item_count
      FROM rate_cards rc
      LEFT JOIN clients c ON c.id = rc.client_id
      LEFT JOIN companies comp ON comp.id = rc.company_id
      LEFT JOIN users u ON u.id = rc.created_by
      LEFT JOIN rate_card_items rci ON rci.rate_card_id = rc.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY rc.id, c.name, comp.name, u.first_name, u.last_name
      ORDER BY rc.created_at DESC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/rate-cards/:id
router.get('/:id', async (req, res, next) => {
  try {
    const rc = await query(`
      SELECT rc.*, c.name AS client_name, comp.name AS company_name,
        CONCAT(u.first_name,' ',u.last_name) AS created_by_name
      FROM rate_cards rc
      LEFT JOIN clients c ON c.id = rc.client_id
      LEFT JOIN companies comp ON comp.id = rc.company_id
      LEFT JOIN users u ON u.id = rc.created_by
      WHERE rc.id = $1
    `, [parseInt(req.params.id)]);

    if (!rc.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const items = await query(
      'SELECT * FROM rate_card_items WHERE rate_card_id = $1 ORDER BY id',
      [parseInt(req.params.id)]
    );

    res.json({ success: true, data: { ...rc.rows[0], items: items.rows } });
  } catch(e) { next(e); }
});

// POST /api/rate-cards
router.post('/', async (req, res, next) => {
  try {
    const { company_id, client_id, type, carrier, city, state, country, currency, notes, items } = req.body;

    if (!company_id || !type)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, type' });

    // Auto-generate folio
    const compCode = COMPANY_CODES[parseInt(company_id)] || 'INC';
    const now = new Date();
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const yy = String(now.getFullYear()).slice(-2);
    const countResult = await query(
      'SELECT COUNT(*) as cnt FROM rate_cards WHERE company_id=$1 AND type=$2',
      [parseInt(company_id), type]
    );
    const seq = String(parseInt(countResult.rows[0].cnt) + 1).padStart(3,'0');
    const prefix = type === 'CLIENT' ? 'RCC' : 'RCS';
    const folio = `${prefix}-${compCode}-${mm}${yy}-${seq}`;

    let rateCardId;
    await withTransaction(async (client) => {
      const rcResult = await client.query(`
        INSERT INTO rate_cards
          (company_id, client_id, folio, type, carrier, city, state, country,
           currency, status, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11)
        RETURNING id
      `, [parseInt(company_id), client_id ? parseInt(client_id) : null,
          folio, type, carrier||null, city||null, state||null, country||null,
          currency||'MXN', notes||null, req.user.id]);

      rateCardId = rcResult.rows[0].id;

      if (items && items.length > 0) {
        for (const item of items) {
          await client.query(`
            INSERT INTO rate_card_items
              (rate_card_id, code, description, subcategory, subcategory_custom,
               unit, unit_custom, price, comment)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `, [rateCardId, item.code||null, item.description,
              item.subcategory||null, item.subcategory_custom||null,
              item.unit||null, item.unit_custom||null,
              parseFloat(item.price||0), item.comment||null]);
        }
      }
    });

    const created = await query('SELECT * FROM rate_cards WHERE id=$1', [rateCardId]);
    res.status(201).json({ success: true, data: created.rows[0],
      message: `Rate Card ${folio} creado exitosamente.` });
  } catch(e) { next(e); }
});

// POST /api/rate-cards/:id/submit
router.post('/:id/submit', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const rc = await query('SELECT * FROM rate_cards WHERE id=$1', [id]);
    if (!rc.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    if (rc.rows[0].status !== 'draft')
      return res.status(400).json({ success: false, error: 'invalid_status' });

    const approvalPolicy = await getCompanyApprovalPolicy(rc.rows[0].company_id);
    const chain = getApprovalChain('EXPENSE', rc.rows[0].total_amount || 999999, approvalPolicy);
    const { resolved, missing } = await resolveApprovers(rc.rows[0].company_id, chain);
    if (missing.length > 0)
      return res.status(400).json({ success: false, error: 'missing_approvers', missing });

    let approvalRequestId;
    await withTransaction(async (client) => {
      const arResult = await client.query(`
        INSERT INTO treasury_approval_requests
          (company_id, approval_type, entity_type, entity_id, amount, currency,
           status, requested_by, current_level, final_level, notes)
        VALUES ($1,'RATE_CARD','RATE_CARD',$2,0,$3,'pending',$4,1,$5,$6)
        RETURNING id
      `, [rc.rows[0].company_id, String(id), rc.rows[0].currency||'MXN',
          req.user.id, resolved.length, `Rate Card ${rc.rows[0].folio}`]);

      approvalRequestId = arResult.rows[0].id;

      for (const step of resolved) {
        await client.query(`
          INSERT INTO treasury_approval_steps
            (request_id, level_number, approver_role, approver_user_id, status)
          VALUES ($1,$2,$3,$4,'pending')
        `, [approvalRequestId, step.level, step.role, step.user_id]);
      }

      await client.query(`
        UPDATE rate_cards SET status='pending_approval', approval_request_id=$1, updated_at=NOW()
        WHERE id=$2
      `, [approvalRequestId, id]);
    });

    res.json({ success: true, message: 'Rate Card enviado a aprobación.' });
  } catch(e) { next(e); }
});

// POST /api/rate-cards/:id/approve-step
router.post('/:id/approve-step', async (req, res, next) => {
  try {
    const { comments } = req.body;
    const id = parseInt(req.params.id);
    const rcResult = await query('SELECT * FROM rate_cards WHERE id=$1', [id]);
    if (!rcResult.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const rc = rcResult.rows[0];
    if (rc.status !== 'pending_approval')
      return res.status(400).json({ success: false, error: 'invalid_status' });
    if (rc.created_by === req.user.id)
      return res.status(403).json({ success: false, error: 'segregation_of_duties',
        message: 'No puedes aprobar un Rate Card que tú mismo creaste.' });

    const stepResult = await query(`
      SELECT * FROM treasury_approval_steps
      WHERE request_id=$1 AND approver_user_id=$2 AND status='pending'
      ORDER BY level_number ASC LIMIT 1
    `, [rc.approval_request_id, req.user.id]);

    if (!stepResult.rows[0])
      return res.status(403).json({ success: false, error: 'not_your_turn' });

    const step = stepResult.rows[0];
    let stillPending = 1;

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE treasury_approval_steps SET status='approved', approved_at=NOW(), comments=$1, updated_at=NOW()
        WHERE id=$2
      `, [comments||null, step.id]);

      const pending = await client.query(`
        SELECT COUNT(*) as cnt FROM treasury_approval_steps
        WHERE request_id=$1 AND status='pending'
      `, [rc.approval_request_id]);

      stillPending = parseInt(pending.rows[0].cnt);

      if (stillPending === 0) {
        await client.query(`UPDATE treasury_approval_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [rc.approval_request_id]);
        await client.query(`UPDATE rate_cards SET status='approved', updated_at=NOW() WHERE id=$1`, [id]);
      } else {
        await client.query(`UPDATE treasury_approval_requests SET current_level=$1, updated_at=NOW() WHERE id=$2`, [step.level_number+1, rc.approval_request_id]);
      }
    });

    res.json({ success: true, message: stillPending === 0 ? 'Rate Card aprobado!' : `Nivel ${step.level_number} aprobado.` });
  } catch(e) { next(e); }
});

// POST /api/rate-cards/:id/reject-step
router.post('/:id/reject-step', async (req, res, next) => {
  try {
    const { comments } = req.body;
    const id = parseInt(req.params.id);
    const rcResult = await query('SELECT * FROM rate_cards WHERE id=$1', [id]);
    if (!rcResult.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const rc = rcResult.rows[0];
    if (rc.status !== 'pending_approval')
      return res.status(400).json({ success: false, error: 'invalid_status' });

    await withTransaction(async (client) => {
      if (rc.approval_request_id) {
        await client.query(`UPDATE treasury_approval_steps SET status='rejected', approved_at=NOW(), comments=$1, updated_at=NOW() WHERE request_id=$2 AND approver_user_id=$3 AND status='pending'`, [comments||null, rc.approval_request_id, req.user.id]);
        await client.query(`UPDATE treasury_approval_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [rc.approval_request_id]);
      }
      await client.query(`UPDATE rate_cards SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
    });

    res.json({ success: true, message: 'Rate Card rechazado.' });
  } catch(e) { next(e); }
});

// GET /api/rate-cards/:id/approval-status
router.get('/:id/approval-status', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const rcResult = await query('SELECT * FROM rate_cards WHERE id=$1', [id]);
    if (!rcResult.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const rc = rcResult.rows[0];
    if (!rc.approval_request_id)
      return res.json({ success: true, data: { status: rc.status, steps: [] } });

    const stepsResult = await query(`
      SELECT s.*, CONCAT(u.first_name,' ',u.last_name) AS approver
      FROM treasury_approval_steps s
      LEFT JOIN users u ON u.id = s.approver_user_id
      WHERE s.request_id=$1 ORDER BY s.level_number ASC
    `, [rc.approval_request_id]);

    res.json({ success: true, data: {
      status: rc.status,
      steps: stepsResult.rows.map(s => ({
        level: s.level_number, role: s.approver_role,
        approver: s.approver, approver_id: s.approver_user_id,
        status: s.status, approved_at: s.approved_at, comments: s.comments
      }))
    }});
  } catch(e) { next(e); }
});

// POST /api/rate-cards/:id/items — bulk add items
router.post('/:id/items', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { items } = req.body;
    if (!items || !items.length)
      return res.status(400).json({ success: false, error: 'no_items' });

    for (const item of items) {
      await query(`
        INSERT INTO rate_card_items
          (rate_card_id, code, description, subcategory, subcategory_custom,
           unit, unit_custom, price, comment)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [id, item.code||null, item.description,
          item.subcategory||null, item.subcategory_custom||null,
          item.unit||null, item.unit_custom||null,
          parseFloat(item.price||0), item.comment||null]);
    }

    res.json({ success: true, message: `${items.length} items agregados.` });
  } catch(e) { next(e); }
});

// DELETE /api/rate-cards/:id/items/:itemId
router.delete('/:id/items/:itemId', async (req, res, next) => {
  try {
    await query('DELETE FROM rate_card_items WHERE id=$1 AND rate_card_id=$2',
      [parseInt(req.params.itemId), parseInt(req.params.id)]);
    res.json({ success: true });
  } catch(e) { next(e); }
});

module.exports = router;

// PUT /api/rate-cards/:id
router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const rcResult = await query('SELECT * FROM rate_cards WHERE id=$1', [id]);
    if (!rcResult.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    if (rcResult.rows[0].status === 'approved')
      return res.status(400).json({ success: false, error: 'locked', message: 'Rate Card aprobado no puede editarse.' });

    const allowed = ['client_id','carrier','city','state','country','currency','notes'];
    const fields = [];
    const params = [];
    let idx = 1;
    for (const key of allowed) {
      if (key in req.body) { fields.push(`${key} = $${idx++}`); params.push(req.body[key]); }
    }
    if (!fields.length) return res.status(400).json({ success: false, error: 'no_fields' });
    params.push(id);
    const result = await query(
      `UPDATE rate_cards SET ${fields.join(', ')}, updated_at=NOW() WHERE id=$${idx} RETURNING *`, params);
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// PUT /api/rate-cards/:id/items — replace all items
router.put('/:id/items', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { items } = req.body;

    await withTransaction(async (client) => {
      // Delete existing items
      await client.query('DELETE FROM rate_card_items WHERE rate_card_id=$1', [id]);
      // Insert new items
      if (items && items.length > 0) {
        for (const item of items) {
          await client.query(`
            INSERT INTO rate_card_items
              (rate_card_id, code, description, subcategory, subcategory_custom,
               unit, unit_custom, price, comment)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `, [id, item.code||null, item.description,
              item.subcategory||null, item.subcategory_custom||null,
              item.unit||null, item.unit_custom||null,
              parseFloat(item.price||0), item.comment||null]);
        }
      }
    });

    res.json({ success: true, message: `Items actualizados.` });
  } catch(e) { next(e); }
});
