'use strict';

const express = require('express');
const router = express.Router();

const Project = require('../models/Project');
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { authorize, authorizePermission } = require('../middleware/authorization');
const { validate, schemas } = require('../middleware/validation');
const { auditLog } = require('../middleware/audit');
const { getPagination, buildPaginatedResponse, generateProjectCode } = require('../utils/helpers');

router.use(verifyToken, auditLog);

// GET /api/projects
/**
 * @swagger
 * /:
 *   get:
 *     summary: GET /
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req.query);
    const companyId = req.query.company_id || req.user.company_id;

    const result = await Project.findAll({
      companyId,
      status: req.query.status,
      clientId: req.query.client_id,
      pmId: req.query.pm_id,
      search: req.query.search,
      page,
      limit,
      userRole: req.user.role,
    });

    res.json({ success: true, ...buildPaginatedResponse(result.data, result.total, page, limit) });
  } catch (error) { next(error); }
});

// GET /api/projects/:id
/**
 * @swagger
 * /:id:
 *   get:
 *     summary: GET /:id
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/:id', async (req, res, next) => {
  try {
    const project = await Project.findById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ success: false, error: 'not_found', message: 'Proyecto no encontrado.' });

    // Enforce company isolation
    if (req.user.role !== 'admin' && req.user.role !== 'super_admin' && project.company_id !== req.user.company_id) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Acceso denegado.' });
    }

    res.json({ success: true, data: project });
  } catch (error) { next(error); }
});

// POST /api/projects
/**
 * @swagger
 * /:
 *   post:
 *     summary: POST /
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/',
  authorize('admin', 'manager', 'project_manager'),
  validate(schemas.createProject),
  async (req, res, next) => {
    try {
      // Auto-generate code if not provided
      if (!req.body.code) {
        const count = await Project.getCount(req.body.company_id);
        let clientCode = 'GEN';
        if (req.body.client_id) {
          const clientResult = await query(
            'SELECT name FROM clients WHERE id = $1', [parseInt(req.body.client_id)]
          );
          if (clientResult.rows[0]) {
            clientCode = clientResult.rows[0].name
              .replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 3);
          }
        }
        req.body.code = generateProjectCode(req.body.company_id, count, clientCode);
      }

      const project = await Project.create(req.body, req.user.id);

      // Add PM as team member if specified
      if (project.pm_id) {
        await query(
          `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [project.id, project.pm_id, 'Project Manager']
        );
      }

      res.status(201).json({ success: true, message: 'Proyecto creado.', data: project });
    } catch (error) { next(error); }
  }
);

// PUT /api/projects/:id
/**
 * @swagger
 * /:id:
 *   put:
 *     summary: PUT /:id
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: Success
 */
router.put('/:id',
  authorize('admin', 'manager', 'project_manager'),
  validate(schemas.updateProject),
  async (req, res, next) => {
    try {
      const project = await Project.findById(parseInt(req.params.id));
      if (!project) return res.status(404).json({ success: false, error: 'not_found', message: 'Proyecto no encontrado.' });

      if (req.user.role !== 'admin' && req.user.role !== 'super_admin' && project.company_id !== req.user.company_id) {
        return res.status(403).json({ success: false, error: 'forbidden', message: 'Acceso denegado.' });
      }

      const updated = await Project.update(parseInt(req.params.id), req.body);
      res.json({ success: true, message: 'Proyecto actualizado.', data: updated });
    } catch (error) { next(error); }
  }
);

// DELETE /api/projects/:id
/**
 * @swagger
 * /:id:
 *   delete:
 *     summary: DELETE /:id
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: Success
 */
router.delete('/:id',
  authorize('admin', 'manager'),
  async (req, res, next) => {
    try {
      const updated = await Project.update(parseInt(req.params.id), { status: 'cancelled' });
      if (!updated) return res.status(404).json({ success: false, error: 'not_found', message: 'Proyecto no encontrado.' });
      res.json({ success: true, message: 'Proyecto cancelado.', data: updated });
    } catch (error) { next(error); }
  }
);

// PUT /api/projects/:id/status
/**
 * @swagger
 * /:id/status:
 *   put:
 *     summary: PUT /:id/status
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: Success
 */
router.put('/:id/status', async (req, res, next) => {
  try {
    const { status, progress_percent } = req.body;
    const validStatuses = ['planning', 'executing', 'paused', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Estado inválido.' });
    }
    const updates = { status };
    if (progress_percent !== undefined) updates.progress_percent = progress_percent;
    if (status === 'completed') updates.end_date_real = new Date().toISOString().split('T')[0];

    const updated = await Project.update(parseInt(req.params.id), updates);
    if (!updated) return res.status(404).json({ success: false, error: 'not_found', message: 'Proyecto no encontrado.' });

    res.json({ success: true, message: 'Estado de proyecto actualizado.', data: updated });
  } catch (error) { next(error); }
});

// GET /api/projects/:id/finances
/**
 * @swagger
 * /:id/finances:
 *   get:
 *     summary: GET /:id/finances
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/:id/finances', async (req, res, next) => {
  try {
    const finances = await Project.getFinances(parseInt(req.params.id));
    res.json({ success: true, data: finances });
  } catch (error) { next(error); }
});

// GET /api/projects/:id/kanban
/**
 * @swagger
 * /:id/kanban:
 *   get:
 *     summary: GET /:id/kanban
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/:id/kanban', async (req, res, next) => {
  try {
    const kanban = await Project.getKanban(parseInt(req.params.id));
    res.json({ success: true, data: kanban });
  } catch (error) { next(error); }
});

// GET /api/projects/:id/gantt
/**
 * @swagger
 * /:id/gantt:
 *   get:
 *     summary: GET /:id/gantt
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/:id/gantt', async (req, res, next) => {
  try {
    const gantt = await Project.getGantt(parseInt(req.params.id));
    res.json({ success: true, data: gantt });
  } catch (error) { next(error); }
});

// GET /api/projects/:id/team
/**
 * @swagger
 * /:id/team:
 *   get:
 *     summary: GET /:id/team
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/:id/team', async (req, res, next) => {
  try {
    const team = await Project.getTeam(parseInt(req.params.id));
    res.json({ success: true, data: team });
  } catch (error) { next(error); }
});

// POST /api/projects/:id/team
/**
 * @swagger
 * /:id/team:
 *   post:
 *     summary: POST /:id/team
 *     tags:
 *       - Projects
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/:id/team',
  authorize('admin', 'manager', 'project_manager'),
  async (req, res, next) => {
    try {
      const { user_id, role } = req.body;
      await query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = $3`,
        [parseInt(req.params.id), user_id, role || null]
      );
      res.status(201).json({ success: true, message: 'Miembro agregado al proyecto.' });
    } catch (error) { next(error); }
  }
);

module.exports = router;

// ─── PROJECT APPROVAL ENDPOINTS ───────────────────────────────

// POST /api/projects/:id/submit
router.post('/:id/submit', async (req, res, next) => {
  try {
    const project = await Project.findById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ success: false, error: 'not_found' });
    if (project.approval_status !== 'draft')
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Proyecto en estado ${project.approval_status} no puede enviarse a aprobación.` });

    const approvalPolicy = await getCompanyApprovalPolicy(project.company_id);
    const budget = parseFloat(project.budget_amount || project.estimated_cost || 0);
    const chain = getApprovalChain('PROJECT', budget, approvalPolicy);
    const { resolved, missing } = await resolveApprovers(project.company_id, chain);

    if (missing.length > 0)
      return res.status(400).json({ success: false, error: 'missing_approvers', missing });

    let approvalRequestId;
    await withTransaction(async (client) => {
      const arResult = await client.query(`
        INSERT INTO treasury_approval_requests
          (company_id, approval_type, entity_type, entity_id, amount, currency,
           status, requested_by, current_level, final_level, notes)
        VALUES ($1,'PROJECT','PROJECT',$2,$3,$4,'pending',$5,1,$6,$7)
        RETURNING id
      `, [project.company_id, String(project.id), budget,
          project.currency || 'MXN', req.user.id, resolved.length,
          `Proyecto ${project.code}: ${project.name}`]);

      approvalRequestId = arResult.rows[0].id;

      for (const step of resolved) {
        await client.query(`
          INSERT INTO treasury_approval_steps
            (request_id, level_number, approver_role, approver_user_id, status)
          VALUES ($1,$2,$3,$4,'pending')
        `, [approvalRequestId, step.level, step.role, step.user_id]);
      }

      await client.query(`
        UPDATE projects SET approval_status='pending_approval',
          approval_request_id=$1, submitted_at=NOW(), updated_at=NOW()
        WHERE id=$2
      `, [approvalRequestId, project.id]);
    });

    writeAudit({ userId: req.user.id, action: 'project_submitted',
      entityType: 'projects', entityId: String(project.id),
      companyId: project.company_id,
      newValues: { approval_request_id: approvalRequestId },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(() => {});

    res.json({ success: true, message: 'Proyecto enviado a aprobación.',
      data: { approval_request_id: approvalRequestId, levels: resolved.length } });
  } catch (e) { next(e); }
});

// POST /api/projects/:id/approve-step
router.post('/:id/approve-step', async (req, res, next) => {
  try {
    const { comments } = req.body;
    const project = await Project.findById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ success: false, error: 'not_found' });
    if (project.approval_status !== 'pending_approval')
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: 'Proyecto no está pendiente de aprobación.' });

    const ar = await query(
      'SELECT * FROM treasury_approval_requests WHERE id=$1', [project.approval_request_id]);
    if (!ar.rows[0]) return res.status(404).json({ success: false, error: 'approval_not_found' });

    const currentLevel = ar.rows[0].current_level;
    const finalLevel   = ar.rows[0].final_level;

    const step = await query(`
      SELECT * FROM treasury_approval_steps
      WHERE request_id=$1 AND level_number=$2 AND status='pending'
    `, [project.approval_request_id, currentLevel]);

    if (!step.rows[0])
      return res.status(400).json({ success: false, error: 'no_pending_step' });

    if (step.rows[0].approver_user_id !== req.user.id &&
        req.user.role !== 'super_admin')
      return res.status(403).json({ success: false, error: 'forbidden',
        message: 'No tienes autorización para aprobar este nivel.' });

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE treasury_approval_steps SET status='approved',
          approved_at=NOW(), comments=$1, updated_at=NOW()
        WHERE id=$2
      `, [comments || null, step.rows[0].id]);

      if (currentLevel >= finalLevel) {
        await client.query(`
          UPDATE treasury_approval_requests SET status='approved',
            current_level=$1, updated_at=NOW()
          WHERE id=$2
        `, [currentLevel, project.approval_request_id]);

        await client.query(`
          UPDATE projects SET approval_status='approved',
            approved_at=NOW(), approved_by=$1, updated_at=NOW()
          WHERE id=$2
        `, [req.user.id, project.id]);
      } else {
        await client.query(`
          UPDATE treasury_approval_requests SET current_level=$1, updated_at=NOW()
          WHERE id=$2
        `, [currentLevel + 1, project.approval_request_id]);
      }
    });

    const isFullyApproved = currentLevel >= finalLevel;
    writeAudit({ userId: req.user.id, action: 'project_approved_step',
      entityType: 'projects', entityId: String(project.id),
      companyId: project.company_id,
      newValues: { level: currentLevel, fully_approved: isFullyApproved },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(() => {});

    res.json({ success: true,
      message: isFullyApproved ? 'Proyecto aprobado completamente.' : `Nivel ${currentLevel} aprobado. Pendiente nivel ${currentLevel + 1}.`,
      data: { fully_approved: isFullyApproved, level_approved: currentLevel } });
  } catch (e) { next(e); }
});

// POST /api/projects/:id/reject
router.post('/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, error: 'validation_error',
      message: 'Se requiere motivo de rechazo.' });

    const project = await Project.findById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ success: false, error: 'not_found' });
    if (project.approval_status !== 'pending_approval')
      return res.status(400).json({ success: false, error: 'invalid_status' });

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE treasury_approval_requests SET status='rejected', updated_at=NOW()
        WHERE id=$1
      `, [project.approval_request_id]);

      await client.query(`
        UPDATE treasury_approval_steps SET status='rejected',
          rejected_at=NOW(), comments=$1, updated_at=NOW()
        WHERE request_id=$2 AND status='pending'
      `, [reason, project.approval_request_id]);

      await client.query(`
        UPDATE projects SET approval_status='draft',
          rejected_at=NOW(), rejection_reason=$1,
          approval_request_id=NULL, submitted_at=NULL, updated_at=NOW()
        WHERE id=$2
      `, [reason, project.id]);
    });

    res.json({ success: true, message: 'Proyecto rechazado — vuelve a draft.',
      data: { reason } });
  } catch (e) { next(e); }
});

module.exports = router;
