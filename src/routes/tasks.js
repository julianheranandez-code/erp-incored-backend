'use strict';

const express = require('express');
const router = express.Router();

const Task = require('../models/Task');
const { verifyToken } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validation');
const { auditLog } = require('../middleware/audit');
const { getPagination, buildPaginatedResponse } = require('../utils/helpers');

router.use(verifyToken, auditLog);

// GET /api/tasks
/**
 * @swagger
 * /:
 *   get:
 *     summary: GET /
 *     tags:
 *       - Tasks
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit } = getPagination(req.query);
    const result = await Task.findAll({
      projectId: req.query.project_id,
      assignedTo: req.query.assigned_to,
      status: req.query.status,
      priority: req.query.priority,
      search: req.query.search,
      page, limit,
      companyId: req.user.company_id,
      userRole: req.user.role,
      userId: req.user.id,
    });
    res.json({ success: true, ...buildPaginatedResponse(result.data, result.total, page, limit) });
  } catch (error) { next(error); }
});

// GET /api/tasks/:id
/**
 * @swagger
 * /:id:
 *   get:
 *     summary: GET /:id
 *     tags:
 *       - Tasks
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/:id', async (req, res, next) => {
  try {
    const task = await Task.findById(parseInt(req.params.id));
    if (!task) return res.status(404).json({ success: false, error: 'not_found', message: 'Tarea no encontrada.' });
    res.json({ success: true, data: task });
  } catch (error) { next(error); }
});

// POST /api/tasks
/**
 * @swagger
 * /:
 *   post:
 *     summary: POST /
 *     tags:
 *       - Tasks
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/', validate(schemas.createTask), async (req, res, next) => {
  try {
    const task = await Task.create(req.body, req.user.id);
    res.status(201).json({ success: true, message: 'Tarea creada.', data: task });
  } catch (error) { next(error); }
});

// PUT /api/tasks/:id
/**
 * @swagger
 * /:id:
 *   put:
 *     summary: PUT /:id
 *     tags:
 *       - Tasks
 *     responses:
 *       200:
 *         description: Success
 */
router.put('/:id', validate(schemas.updateTask), async (req, res, next) => {
  try {
    const task = await Task.findById(parseInt(req.params.id));
    if (!task) return res.status(404).json({ success: false, error: 'not_found', message: 'Tarea no encontrada.' });

    // Only assignee, creator, or managers can update
    const canUpdate = req.user.role === 'admin' ||
      ['manager', 'project_manager', 'supervisor'].includes(req.user.role) ||
      task.assigned_to === req.user.id ||
      task.created_by === req.user.id;

    if (!canUpdate) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'No tienes permisos para modificar esta tarea.' });
    }

    const updated = await Task.update(parseInt(req.params.id), req.body);
    res.json({ success: true, message: 'Tarea actualizada.', data: updated });
  } catch (error) { next(error); }
});

// DELETE /api/tasks/:id
/**
 * @swagger
 * /:id:
 *   delete:
 *     summary: DELETE /:id
 *     tags:
 *       - Tasks
 *     responses:
 *       200:
 *         description: Success
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const updated = await Task.softDelete(parseInt(req.params.id));
    if (!updated) return res.status(404).json({ success: false, error: 'not_found', message: 'Tarea no encontrada.' });
    res.json({ success: true, message: 'Tarea cancelada.' });
  } catch (error) { next(error); }
});

// PUT /api/tasks/:id/status
/**
 * @swagger
 * /:id/status:
 *   put:
 *     summary: PUT /:id/status
 *     tags:
 *       - Tasks
 *     responses:
 *       200:
 *         description: Success
 */
router.put('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ['no_iniciada', 'pendiente', 'en_proceso', 'bloqueada', 'en_revision', 'completada', 'cancelada'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Estado inválido.' });
    }
    const updated = await Task.updateStatus(parseInt(req.params.id), status);
    if (!updated) return res.status(404).json({ success: false, error: 'not_found', message: 'Tarea no encontrada.' });
    res.json({ success: true, message: 'Estado actualizado.', data: updated });
  } catch (error) { next(error); }
});

// PUT /api/tasks/:id/assignee
/**
 * @swagger
 * /:id/assignee:
 *   put:
 *     summary: PUT /:id/assignee
 *     tags:
 *       - Tasks
 *     responses:
 *       200:
 *         description: Success
 */
router.put('/:id/assignee', async (req, res, next) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'validation_error', message: 'user_id requerido.' });
    const updated = await Task.update(parseInt(req.params.id), { assigned_to: user_id });
    if (!updated) return res.status(404).json({ success: false, error: 'not_found', message: 'Tarea no encontrada.' });
    res.json({ success: true, message: 'Asignado actualizado.', data: updated });
  } catch (error) { next(error); }
});

// POST /api/tasks/:id/comments
/**
 * @swagger
 * /:id/comments:
 *   post:
 *     summary: POST /:id/comments
 *     tags:
 *       - Tasks
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/:id/comments', async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ success: false, error: 'validation_error', message: 'El contenido del comentario es requerido.' });
    const comment = await Task.addComment(parseInt(req.params.id), req.user.id, content.trim());
    res.status(201).json({ success: true, message: 'Comentario agregado.', data: comment });
  } catch (error) { next(error); }
});

// GET /api/tasks/:id/comments
/**
 * @swagger
 * /:id/comments:
 *   get:
 *     summary: GET /:id/comments
 *     tags:
 *       - Tasks
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/:id/comments', async (req, res, next) => {
  try {
    const comments = await Task.getComments(parseInt(req.params.id));
    res.json({ success: true, data: comments });
  } catch (error) { next(error); }
});

// POST /api/tasks/:id/time-entries
/**
 * @swagger
 * /:id/time-entries:
 *   post:
 *     summary: POST /:id/time-entries
 *     tags:
 *       - Tasks
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/:id/time-entries', validate(schemas.timeEntry), async (req, res, next) => {
  try {
    const entry = await Task.addTimeEntry(parseInt(req.params.id), req.user.id, req.body);
    res.status(201).json({ success: true, message: 'Tiempo registrado.', data: entry });
  } catch (error) { next(error); }
});

// GET /api/tasks/:id/time-entries
/**
 * @swagger
 * /:id/time-entries:
 *   get:
 *     summary: GET /:id/time-entries
 *     tags:
 *       - Tasks
 *     responses:
 *       200:
 *         description: Success
 */
router.get('/:id/time-entries', async (req, res, next) => {
  try {
    const entries = await Task.getTimeEntries(parseInt(req.params.id));
    res.json({ success: true, data: entries });
  } catch (error) { next(error); }
});

module.exports = router;
