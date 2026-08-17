'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { resolveApprovers, getCompanyApprovalPolicy } = require('../lib/approval-engine');
const { writeAudit } = require('../middleware/audit');
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
    if (req.query.lead_id) { conditions.push(`cpo.lead_id = $${idx++}`); values.push(parseInt(req.query.lead_id)); }
    const result = await query(`
      SELECT cpo.*, c.name AS client_name, p.name AS project_name, p.code AS project_code,
        l.title AS lead_title
      FROM client_purchase_orders cpo
      LEFT JOIN clients c ON c.id = cpo.client_id
      LEFT JOIN projects p ON p.id = cpo.project_id
      LEFT JOIN leads l ON l.id = cpo.lead_id
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
      advance_percent, notes, lead_id } = req.body;

    if (!company_id || !client_id || !total_amount)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, client_id, total_amount' });

    const compCode = COMPANY_CODES[parseInt(company_id)] || 'INC';
    const now = new Date();
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const yy = String(now.getFullYear()).slice(-2);
    const countResult = await query(
      'SELECT COUNT(*) as cnt FROM client_purchase_orders WHERE company_id=$1 AND TO_CHAR(created_at, \'MMYY\') = $2', [parseInt(company_id), mm+yy]
    );
    const seq = String(parseInt(countResult.rows[0].cnt) + 1).padStart(3,'0');
    const folio = `OR-${compCode}-${mm}${yy}-${seq}`;

    const result = await query(`
      INSERT INTO client_purchase_orders
        (company_id, client_id, project_id, folio, po_number,
         description, total_amount, invoiced_amount,
         currency, exchange_rate, issue_date, start_date, end_date,
         payment_conditions, advance_percent, advance_amount, status, notes, created_by, lead_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13,$14,$15,'active',$16,$17,$18)
      RETURNING *
    `, [parseInt(company_id), parseInt(client_id),
        project_id ? parseInt(project_id) : null,
        folio, client_po_number || null, description || null,
        parseFloat(total_amount), currency || 'MXN', parseFloat(exchange_rate||1),
        issue_date || null, start_date || null, end_date || null,
        payment_conditions || null, parseFloat(advance_percent||0),
        advance_percent ? (parseFloat(total_amount)*parseFloat(advance_percent)/100) : 0,
        notes || null, req.user.id, lead_id ? parseInt(lead_id) : null]);

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


// ─── CLIENT PO CLOSE WORKFLOW ─────────────────────────────────

// GET /api/client-pos/:id/close-readiness
router.get('/:id/close-readiness', async (req, res, next) => {
  try {
    const cpo = await query('SELECT * FROM client_purchase_orders WHERE id=$1', [parseInt(req.params.id)]);
    if (!cpo.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const po = cpo.rows[0];
    const cid = po.company_id;
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const [projects, arInvoices, deliverables] = await Promise.all([
      query(`SELECT id, name, code, status FROM projects
             WHERE client_po_id=$1 AND status NOT IN ('completed','cancelled')`, [po.id]),
      query(`SELECT folio, outstanding_balance, status FROM ar_invoices
             WHERE client_po_id=$1 AND outstanding_balance > 0
             AND status NOT IN ('cancelled','rejected')`, [po.id]),
      query(`SELECT uuid, title, status FROM project_deliverables d
             JOIN ar_invoices ai ON ai.deliverable_id = d.id
             WHERE ai.client_po_id=$1 AND d.status != 'invoiced'`, [po.id])
    ]);

    const blockers = [];
    const warnings = [];
    const remainingPct = parseFloat(po.total_amount) > 0
      ? (parseFloat(po.remaining_amount) / parseFloat(po.total_amount)) * 100
      : 0;

    if (projects.rows.length > 0)
      blockers.push({ type: 'projects_open',
        message: `${projects.rows.length} proyecto(s) asociados no completados.`,
        items: projects.rows });

    if (arInvoices.rows.length > 0)
      blockers.push({ type: 'ar_invoices_unpaid',
        message: `${arInvoices.rows.length} factura(s) AR con saldo pendiente.`,
        items: arInvoices.rows });

    if (deliverables.rows.length > 0)
      blockers.push({ type: 'deliverables_pending',
        message: `${deliverables.rows.length} entregable(s) sin facturar.`,
        items: deliverables.rows });

    if (remainingPct > 10)
      blockers.push({ type: 'po_balance',
        message: `PO tiene ${remainingPct.toFixed(2)}% sin facturar (límite 10%).`,
        items: [{ remaining_amount: po.remaining_amount, total_amount: po.total_amount, remaining_pct: remainingPct }] });
    else if (remainingPct > 0)
      warnings.push({ type: 'po_balance_warning',
        message: `PO tiene ${remainingPct.toFixed(2)}% sin facturar — requiere justificación.`,
        items: [{ remaining_amount: po.remaining_amount, total_amount: po.total_amount, remaining_pct: remainingPct }] });

    res.json({ success: true, data: {
      can_request_close: blockers.length === 0,
      requires_justification: warnings.length > 0,
      blockers, warnings,
      summary: {
        total_blockers: blockers.length,
        total_warnings: warnings.length,
        projects_open: projects.rows.length,
        ar_invoices_unpaid: arInvoices.rows.length,
        deliverables_pending: deliverables.rows.length,
        remaining_pct: remainingPct.toFixed(2)
      }
    }});
  } catch(e) { next(e); }
});

// POST /api/client-pos/:id/request-close
router.post('/:id/request-close', async (req, res, next) => {
  try {
    const { justification, notes } = req.body;
    const cpo = await query('SELECT * FROM client_purchase_orders WHERE id=$1', [parseInt(req.params.id)]);
    if (!cpo.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const po = cpo.rows[0];
    const cid = po.company_id;
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    if (po.close_approval_request_id)
      return res.status(400).json({ success: false, error: 'close_already_requested',
        message: 'Ya existe una solicitud de cierre pendiente.' });

    // Run readiness check
    const [projects, arInvoices] = await Promise.all([
      query(`SELECT COUNT(*) as cnt FROM projects WHERE client_po_id=$1 AND status NOT IN ('completed','cancelled')`, [po.id]),
      query(`SELECT COUNT(*) as cnt FROM ar_invoices WHERE client_po_id=$1 AND outstanding_balance > 0 AND status NOT IN ('cancelled','rejected')`, [po.id])
    ]);

    const remainingPct = parseFloat(po.total_amount) > 0
      ? (parseFloat(po.remaining_amount) / parseFloat(po.total_amount)) * 100 : 0;

    const blockerCount = parseInt(projects.rows[0].cnt) + parseInt(arInvoices.rows[0].cnt) +
      (remainingPct > 10 ? 1 : 0);

    if (blockerCount > 0)
      return res.status(400).json({ success: false, error: 'blockers_exist',
        message: `No se puede solicitar cierre: ${blockerCount} item(s) bloqueadores pendientes.` });

    const chain = [
      { level: 1, role: 'accounting_manager' },
      { level: 2, role: 'finance' }
    ];
    const { resolved, missing } = await resolveApprovers(cid, chain);
    if (missing.length > 0)
      return res.status(400).json({ success: false, error: 'missing_approvers', missing });

    let approvalRequestId;
    await withTransaction(async (client) => {
      const arResult = await client.query(`
        INSERT INTO treasury_approval_requests
          (company_id, approval_type, entity_type, entity_id, amount, currency,
           status, requested_by, current_level, final_level, notes)
        VALUES ($1,'CLIENT_PO_CLOSE','CLIENT_PO',$2,$3,$4,'pending',$5,1,$6,$7)
        RETURNING id
      `, [cid, String(po.id), parseFloat(po.total_amount), po.currency||'MXN',
          req.user.id, resolved.length,
          `Cierre PO Cliente ${po.po_number}${justification ? ' | ' + justification : ''}`]);

      approvalRequestId = arResult.rows[0].id;

      for (const step of resolved) {
        await client.query(`
          INSERT INTO treasury_approval_steps
            (request_id, level_number, approver_role, approver_user_id, status)
          VALUES ($1,$2,$3,$4,'pending')
        `, [approvalRequestId, step.level, step.role, step.user_id]);
      }

      await client.query(`
        UPDATE client_purchase_orders SET
          close_requested_at=NOW(), close_requested_by=$1,
          close_justification=$2, close_approval_request_id=$3, updated_at=NOW()
        WHERE id=$4
      `, [req.user.id, justification||null, approvalRequestId, po.id]);
    });

    res.json({ success: true, message: 'Solicitud de cierre de PO enviada a aprobación.',
      data: { approval_request_id: approvalRequestId, levels: resolved.length } });
  } catch(e) { next(e); }
});

// POST /api/client-pos/:id/approve-close
router.post('/:id/approve-close', async (req, res, next) => {
  try {
    const { comments } = req.body;
    const cpo = await query('SELECT * FROM client_purchase_orders WHERE id=$1', [parseInt(req.params.id)]);
    if (!cpo.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const po = cpo.rows[0];
    if (!po.close_approval_request_id)
      return res.status(400).json({ success: false, error: 'no_close_request' });

    const cid = po.company_id;
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const ar = await query('SELECT * FROM treasury_approval_requests WHERE id=$1', [po.close_approval_request_id]);
    if (!ar.rows[0]) return res.status(404).json({ success: false, error: 'approval_not_found' });

    const currentLevel = ar.rows[0].current_level;
    const finalLevel = ar.rows[0].final_level;

    const step = await query(`
      SELECT * FROM treasury_approval_steps
      WHERE request_id=$1 AND level_number=$2 AND status='pending'
    `, [po.close_approval_request_id, currentLevel]);

    if (!step.rows[0]) return res.status(400).json({ success: false, error: 'no_pending_step' });

    if (step.rows[0].approver_user_id !== req.user.id && req.user.role !== 'super_admin')
      return res.status(403).json({ success: false, error: 'forbidden',
        message: 'No tienes autorización para aprobar este nivel.' });

    let isFullyApproved = false;
    await withTransaction(async (client) => {
      await client.query(`
        UPDATE treasury_approval_steps SET status='approved',
          approved_at=NOW(), comments=$1, updated_at=NOW()
        WHERE id=$2
      `, [comments||null, step.rows[0].id]);

      if (currentLevel >= finalLevel) {
        isFullyApproved = true;
        await client.query(`
          UPDATE treasury_approval_requests SET status='approved',
            current_level=$1, updated_at=NOW() WHERE id=$2
        `, [currentLevel, po.close_approval_request_id]);

        await client.query(`
          UPDATE client_purchase_orders SET status='closed',
            close_approved_at=NOW(), close_approved_by=$1, updated_at=NOW()
          WHERE id=$2
        `, [req.user.id, po.id]);
      } else {
        await client.query(`
          UPDATE treasury_approval_requests SET current_level=$1, updated_at=NOW()
          WHERE id=$2
        `, [currentLevel + 1, po.close_approval_request_id]);
      }
    });

    res.json({ success: true,
      message: isFullyApproved ? 'PO Cliente cerrada correctamente.' : `Nivel ${currentLevel} aprobado. Pendiente nivel ${currentLevel + 1}.`,
      data: { fully_approved: isFullyApproved, level_approved: currentLevel } });
  } catch(e) { next(e); }
});

// POST /api/client-pos/:id/reject-close
router.post('/:id/reject-close', async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, error: 'validation_error',
      message: 'Se requiere motivo de rechazo.' });

    const cpo = await query('SELECT * FROM client_purchase_orders WHERE id=$1', [parseInt(req.params.id)]);
    if (!cpo.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const po = cpo.rows[0];
    if (!po.close_approval_request_id)
      return res.status(400).json({ success: false, error: 'no_close_request' });

    const cid = po.company_id;
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    await withTransaction(async (client) => {
      await client.query(`UPDATE treasury_approval_requests SET status='rejected', updated_at=NOW() WHERE id=$1`,
        [po.close_approval_request_id]);
      await client.query(`UPDATE treasury_approval_steps SET status='rejected', rejected_at=NOW(), comments=$1, updated_at=NOW()
        WHERE request_id=$2 AND status='pending'`, [reason, po.close_approval_request_id]);
      await client.query(`UPDATE client_purchase_orders SET
        close_requested_at=NULL, close_requested_by=NULL, close_justification=NULL,
        close_approval_request_id=NULL, updated_at=NOW() WHERE id=$1`, [po.id]);
    });

    res.json({ success: true, message: 'Solicitud de cierre rechazada.', data: { reason } });
  } catch(e) { next(e); }
});

module.exports = router;
