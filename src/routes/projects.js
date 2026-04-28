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
    const companyId = req.user.role === 'admin' ? req.query.company_id : req.user.company_id;

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
    if (req.user.role !== 'admin' && project.company_id !== req.user.company_id) {
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
        req.body.code = generateProjectCode(req.body.company_id, count);
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

      if (req.user.role !== 'admin' && project.company_id !== req.user.company_id) {
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
