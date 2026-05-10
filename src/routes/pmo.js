'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

router.use(verifyToken);

// ─── ISOLATION HELPERS ────────────────────────────────────────
function getAuthorizedCompanyId(user, requestedCompanyId) {
  if (user.role === 'admin') return requestedCompanyId ? parseInt(requestedCompanyId) : null;
  return parseInt(user.company_id);
}

// ─── TASKS ────────────────────────────────────────────────────

// GET /api/pmo/tasks
router.get('/tasks', async (req, res, next) => {
  try {
    const { project_id, status, priority, assigned_user_id,
            page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`t.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (project_id)          { conditions.push(`t.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (status)              { conditions.push(`t.status = $${idx++}`);     values.push(status); }
    if (priority)            { conditions.push(`t.priority = $${idx++}`);   values.push(priority); }
    if (assigned_user_id)    { conditions.push(`t.assigned_user_id = $${idx++}`); values.push(assigned_user_id); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [tasks, summary, total] = await Promise.all([
      query(`
        SELECT t.*,
          p.name AS project_name, p.code AS project_code,
          m.name AS milestone_name,
          CONCAT(u.first_name,' ',u.last_name) AS assigned_user_name,
          cr.crew_name
        FROM project_tasks t
        LEFT JOIN projects p         ON p.id = t.project_id
        LEFT JOIN project_milestones m ON m.id = t.milestone_id
        LEFT JOIN users u            ON u.id = t.assigned_user_id
        LEFT JOIN project_crews cr   ON cr.id = t.assigned_crew_id
        ${where}
        ORDER BY
          CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
          t.planned_end_date ASC NULLS LAST
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...values, parseInt(limit), offset]),

      query(`
        SELECT
          COUNT(*) AS total_tasks,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
          COUNT(*) FILTER (WHERE status = 'blocked') AS blocked,
          COUNT(*) FILTER (WHERE status = 'delayed') AS delayed,
          COUNT(*) FILTER (WHERE status = 'not_started') AS not_started,
          ROUND(AVG(progress_percent),1) AS avg_progress
        FROM project_tasks t ${where}
      `, values),

      query(`SELECT COUNT(*) AS total FROM project_tasks t ${where}`, values)
    ]);

    res.json({
      success: true,
      data: {
        tasks: tasks.rows,
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

// GET /api/pmo/tasks/:id
router.get('/tasks/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const [task, comments, attachments, dependencies] = await Promise.all([
      query(`
        SELECT t.*,
          p.name AS project_name,
          m.name AS milestone_name,
          CONCAT(u.first_name,' ',u.last_name) AS assigned_user_name,
          cr.crew_name
        FROM project_tasks t
        LEFT JOIN projects p           ON p.id = t.project_id
        LEFT JOIN project_milestones m ON m.id = t.milestone_id
        LEFT JOIN users u              ON u.id = t.assigned_user_id
        LEFT JOIN project_crews cr     ON cr.id = t.assigned_crew_id
        WHERE t.id = $1
      `, [id]),
      query(`
        SELECT c.*, CONCAT(u.first_name,' ',u.last_name) AS user_name
        FROM project_task_comments c
        LEFT JOIN users u ON u.id = c.created_by
        WHERE c.task_id = $1 ORDER BY c.created_at DESC
      `, [id]),
      query('SELECT * FROM project_task_attachments WHERE task_id = $1 ORDER BY created_at DESC', [id]),
      query(`
        SELECT d.*,
          pt.task_name AS predecessor_name,
          st.task_name AS successor_name
        FROM project_task_dependencies d
        LEFT JOIN project_tasks pt ON pt.id = d.predecessor_id
        LEFT JOIN project_tasks st ON st.id = d.successor_id
        WHERE d.predecessor_id = $1 OR d.successor_id = $1
      `, [id])
    ]);

    if (!task.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Task not found.' });

    res.json({
      success: true,
      data: { task: task.rows[0], comments: comments.rows, attachments: attachments.rows, dependencies: dependencies.rows }
    });
  } catch (error) { next(error); }
});

// POST /api/pmo/tasks
router.post('/tasks', async (req, res, next) => {
  const startTime = Date.now();
  try {
    const {
      project_id, company_id, milestone_id, parent_task_id,
      task_name, description, category,
      assigned_user_id, assigned_crew_id,
      priority = 'medium', status = 'not_started',
      planned_start_date, planned_end_date,
      estimated_hours, client_visible = false,
      location, notes
    } = req.body;

    if (!project_id || !company_id || !task_name) {
      return res.status(400).json({
        success: false, error: 'validation_error',
        message: 'Required: project_id, company_id, task_name'
      });
    }

    if (req.user.role !== 'admin' && parseInt(company_id) !== parseInt(req.user.company_id)) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Company access denied.' });
    }

    const result = await query(`
      INSERT INTO project_tasks (
        project_id, company_id, milestone_id, parent_task_id,
        task_name, description, category,
        assigned_user_id, assigned_crew_id,
        priority, status,
        planned_start_date, planned_end_date,
        estimated_hours, client_visible, location, notes, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *
    `, [
      parseInt(project_id), parseInt(company_id),
      milestone_id ? parseInt(milestone_id) : null,
      parent_task_id ? parseInt(parent_task_id) : null,
      task_name, description || null, category || null,
      assigned_user_id || null,
      assigned_crew_id ? parseInt(assigned_crew_id) : null,
      priority, status,
      planned_start_date || null, planned_end_date || null,
      estimated_hours ? parseFloat(estimated_hours) : null,
      client_visible, location || null, notes || null,
      req.user.id
    ]);

    logger.info(`[PMO] Task created id=${result.rows[0].id} in ${Date.now()-startTime}ms`);

    writeAudit({
      userId: req.user.id, action: 'task_created',
      entityType: 'project_tasks', entityId: result.rows[0].id,
      companyId: parseInt(company_id), newValues: { task_name, status, priority },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[PMO] audit failed:', err.message));

    res.status(201).json({ success: true, message: 'Task created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// PUT /api/pmo/tasks/:id
router.put('/tasks/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const {
      task_name, description, status, priority,
      progress_percent, assigned_user_id, assigned_crew_id,
      planned_start_date, planned_end_date,
      actual_start_date, actual_end_date,
      blocked_reason, notes, milestone_id,
      estimated_hours, actual_hours, location
    } = req.body;

    // Auto-set actual dates based on status
    let autoActualStart = actual_start_date;
    let autoActualEnd   = actual_end_date;
    let completedBy     = null;
    let completedAt     = null;

    if (status === 'in_progress' && !actual_start_date) autoActualStart = new Date().toISOString().split('T')[0];
    if (status === 'completed') {
      if (!actual_end_date) autoActualEnd = new Date().toISOString().split('T')[0];
      completedBy = req.user.id;
      completedAt = new Date().toISOString();
    }

    const result = await query(`
      UPDATE project_tasks SET
        task_name           = COALESCE($1, task_name),
        description         = COALESCE($2, description),
        status              = COALESCE($3, status),
        priority            = COALESCE($4, priority),
        progress_percent    = COALESCE($5, progress_percent),
        assigned_user_id    = COALESCE($6, assigned_user_id),
        assigned_crew_id    = COALESCE($7::integer, assigned_crew_id),
        planned_start_date  = COALESCE($8, planned_start_date),
        planned_end_date    = COALESCE($9, planned_end_date),
        actual_start_date   = COALESCE($10, actual_start_date),
        actual_end_date     = COALESCE($11, actual_end_date),
        blocked_reason      = COALESCE($12, blocked_reason),
        notes               = COALESCE($13, notes),
        milestone_id        = COALESCE($14::integer, milestone_id),
        estimated_hours     = COALESCE($15::numeric, estimated_hours),
        actual_hours        = COALESCE($16::numeric, actual_hours),
        location            = COALESCE($17, location),
        completed_by        = COALESCE($18::uuid, completed_by),
        completed_at        = COALESCE($19::timestamp, completed_at),
        updated_at          = NOW()
      WHERE id = $20 RETURNING *
    `, [
      task_name || null, description || null,
      status || null, priority || null,
      progress_percent !== undefined ? parseInt(progress_percent) : null,
      assigned_user_id || null,
      assigned_crew_id || null,
      planned_start_date || null, planned_end_date || null,
      autoActualStart || null, autoActualEnd || null,
      blocked_reason || null, notes || null,
      milestone_id || null,
      estimated_hours || null, actual_hours || null,
      location || null,
      completedBy, completedAt,
      id
    ]);

    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Task not found.' });

    writeAudit({
      userId: req.user.id, action: 'task_updated',
      entityType: 'project_tasks', entityId: id,
      companyId: result.rows[0].company_id,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[PMO] audit failed:', err.message));

    res.json({ success: true, message: 'Task updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// POST /api/pmo/tasks/:id/comments
router.post('/tasks/:id/comments', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { comment, is_internal = true } = req.body;
    if (!comment) return res.status(400).json({ success: false, error: 'validation_error', message: 'Comment required.' });

    const task = await query('SELECT project_id FROM project_tasks WHERE id = $1', [id]);
    if (!task.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Task not found.' });

    const result = await query(`
      INSERT INTO project_task_comments (task_id, project_id, comment, is_internal, created_by)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [id, task.rows[0].project_id, comment, is_internal, req.user.id]);

    res.status(201).json({ success: true, message: 'Comment added.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── MILESTONES ───────────────────────────────────────────────

// GET /api/pmo/milestones
router.get('/milestones', async (req, res, next) => {
  try {
    const { project_id, status } = req.query;
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`m.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (project_id)          { conditions.push(`m.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (status)              { conditions.push(`m.status = $${idx++}`);     values.push(status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT m.*,
        p.name AS project_name, p.code AS project_code,
        COUNT(t.id) AS total_tasks,
        COUNT(t.id) FILTER (WHERE t.status = 'completed') AS completed_tasks
      FROM project_milestones m
      LEFT JOIN projects p ON p.id = m.project_id
      LEFT JOIN project_tasks t ON t.milestone_id = m.id
      ${where}
      GROUP BY m.id, p.name, p.code
      ORDER BY m.planned_date ASC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// POST /api/pmo/milestones
router.post('/milestones', async (req, res, next) => {
  try {
    const { project_id, company_id, name, description, planned_date, client_visible = false } = req.body;
    if (!project_id || !company_id || !name || !planned_date) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: project_id, company_id, name, planned_date' });
    }

    const result = await query(`
      INSERT INTO project_milestones (project_id, company_id, name, description, planned_date, client_visible, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [parseInt(project_id), parseInt(company_id), name, description || null, planned_date, client_visible, req.user.id]);

    res.status(201).json({ success: true, message: 'Milestone created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// PUT /api/pmo/milestones/:id
router.put('/milestones/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, planned_date, actual_date, progress_percent, status } = req.body;

    const result = await query(`
      UPDATE project_milestones SET
        name             = COALESCE($1, name),
        description      = COALESCE($2, description),
        planned_date     = COALESCE($3, planned_date),
        actual_date      = COALESCE($4, actual_date),
        progress_percent = COALESCE($5::integer, progress_percent),
        status           = COALESCE($6, status),
        updated_at       = NOW()
      WHERE id = $7 RETURNING *
    `, [name||null, description||null, planned_date||null, actual_date||null, progress_percent||null, status||null, id]);

    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Milestone not found.' });
    res.json({ success: true, message: 'Milestone updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── DAILY REPORTS ────────────────────────────────────────────

// GET /api/pmo/daily-reports
router.get('/daily-reports', async (req, res, next) => {
  try {
    const { project_id, date_from, date_to } = req.query;
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`r.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (project_id)          { conditions.push(`r.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (date_from)           { conditions.push(`r.report_date >= $${idx++}`); values.push(date_from); }
    if (date_to)             { conditions.push(`r.report_date <= $${idx++}`); values.push(date_to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT r.*,
        p.name AS project_name,
        cr.crew_name,
        CONCAT(u.first_name,' ',u.last_name) AS submitted_by_name
      FROM project_daily_reports r
      LEFT JOIN projects p     ON p.id = r.project_id
      LEFT JOIN project_crews cr ON cr.id = r.crew_id
      LEFT JOIN users u        ON u.id = r.submitted_by
      ${where}
      ORDER BY r.report_date DESC
      LIMIT 100
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// POST /api/pmo/daily-reports
router.post('/daily-reports', async (req, res, next) => {
  const startTime = Date.now();
  try {
    const {
      project_id, company_id, crew_id, report_date,
      work_completed, planned_tomorrow, incidents,
      weather_impact = false, weather_notes,
      crew_count, productivity_rating,
      materials_used, equipment_used, notes
    } = req.body;

    if (!project_id || !company_id) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: project_id, company_id' });
    }

    const result = await query(`
      INSERT INTO project_daily_reports (
        project_id, company_id, crew_id, report_date,
        work_completed, planned_tomorrow, incidents,
        weather_impact, weather_notes,
        crew_count, productivity_rating,
        materials_used, equipment_used, notes, submitted_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (project_id, crew_id, report_date)
      DO UPDATE SET
        work_completed     = EXCLUDED.work_completed,
        planned_tomorrow   = EXCLUDED.planned_tomorrow,
        incidents          = EXCLUDED.incidents,
        weather_impact     = EXCLUDED.weather_impact,
        productivity_rating = EXCLUDED.productivity_rating,
        notes              = EXCLUDED.notes,
        updated_at         = NOW()
      RETURNING *
    `, [
      parseInt(project_id), parseInt(company_id),
      crew_id ? parseInt(crew_id) : null,
      report_date || new Date().toISOString().split('T')[0],
      work_completed || null, planned_tomorrow || null,
      incidents || null, weather_impact, weather_notes || null,
      crew_count ? parseInt(crew_count) : null,
      productivity_rating ? parseInt(productivity_rating) : null,
      materials_used ? JSON.stringify(materials_used) : null,
      equipment_used || null, notes || null,
      req.user.id
    ]);

    logger.info(`[PMO] Daily report submitted in ${Date.now()-startTime}ms`);
    res.status(201).json({ success: true, message: 'Daily report submitted.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── TICKETS ──────────────────────────────────────────────────

// GET /api/pmo/tickets
router.get('/tickets', async (req, res, next) => {
  try {
    const { project_id, status, type, priority } = req.query;
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`tk.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (project_id)          { conditions.push(`tk.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (status)              { conditions.push(`tk.status = $${idx++}`);     values.push(status); }
    if (type)                { conditions.push(`tk.type = $${idx++}`);       values.push(type); }
    if (priority)            { conditions.push(`tk.priority = $${idx++}`);   values.push(priority); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT tk.*,
        p.name AS project_name,
        t.task_name,
        CONCAT(u.first_name,' ',u.last_name) AS assigned_to_name,
        CONCAT(uc.first_name,' ',uc.last_name) AS created_by_name
      FROM project_tickets tk
      LEFT JOIN projects p     ON p.id = tk.project_id
      LEFT JOIN project_tasks t ON t.id = tk.task_id
      LEFT JOIN users u        ON u.id = tk.assigned_to
      LEFT JOIN users uc       ON uc.id = tk.created_by
      ${where}
      ORDER BY
        CASE tk.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        tk.created_at DESC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// POST /api/pmo/tickets
router.post('/tickets', async (req, res, next) => {
  try {
    const {
      project_id, company_id, task_id,
      title, description, type = 'issue',
      priority = 'medium', assigned_to, client_visible = false
    } = req.body;

    if (!project_id || !company_id || !title) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: project_id, company_id, title' });
    }

    const count = await query('SELECT COUNT(*)+1 AS next FROM project_tickets WHERE project_id = $1', [parseInt(project_id)]);
    const ticketNumber = `TKT-${String(project_id).padStart(3,'0')}-${String(count.rows[0].next).padStart(4,'0')}`;

    const result = await query(`
      INSERT INTO project_tickets (
        project_id, company_id, task_id, ticket_number,
        title, description, type, priority,
        assigned_to, client_visible, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      parseInt(project_id), parseInt(company_id),
      task_id ? parseInt(task_id) : null,
      ticketNumber, title, description || null,
      type, priority, assigned_to || null,
      client_visible, req.user.id
    ]);

    writeAudit({
      userId: req.user.id, action: 'ticket_created',
      entityType: 'project_tickets', entityId: result.rows[0].id,
      companyId: parseInt(company_id),
      newValues: { title, type, priority },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(err => logger.error('[PMO] audit failed:', err.message));

    res.status(201).json({ success: true, message: 'Ticket created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// PUT /api/pmo/tickets/:id
router.put('/tickets/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { status, priority, assigned_to, resolution_notes } = req.body;

    const resolvedBy  = status === 'resolved' ? req.user.id : null;
    const resolvedAt  = status === 'resolved' ? new Date().toISOString() : null;

    const result = await query(`
      UPDATE project_tickets SET
        status           = COALESCE($1, status),
        priority         = COALESCE($2, priority),
        assigned_to      = COALESCE($3::uuid, assigned_to),
        resolution_notes = COALESCE($4, resolution_notes),
        resolved_by      = COALESCE($5::uuid, resolved_by),
        resolved_at      = COALESCE($6::timestamp, resolved_at),
        updated_at       = NOW()
      WHERE id = $7 RETURNING *
    `, [status||null, priority||null, assigned_to||null, resolution_notes||null, resolvedBy, resolvedAt, id]);

    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found', message: 'Ticket not found.' });
    res.json({ success: true, message: 'Ticket updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── CREWS ────────────────────────────────────────────────────

// GET /api/pmo/crews
router.get('/crews', async (req, res, next) => {
  try {
    const { project_id } = req.query;
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`c.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (project_id)          { conditions.push(`c.project_id = $${idx++}`); values.push(parseInt(project_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT c.*,
        p.name AS project_name,
        CONCAT(u.first_name,' ',u.last_name) AS supervisor_name
      FROM project_crews c
      LEFT JOIN projects p ON p.id = c.project_id
      LEFT JOIN users u    ON u.id = c.supervisor_id
      ${where}
      ORDER BY c.crew_name ASC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// POST /api/pmo/crews
router.post('/crews', async (req, res, next) => {
  try {
    const { project_id, company_id, crew_name, supervisor_id, crew_size, specialty, notes } = req.body;
    if (!project_id || !company_id || !crew_name) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: project_id, company_id, crew_name' });
    }

    const result = await query(`
      INSERT INTO project_crews (project_id, company_id, crew_name, supervisor_id, crew_size, specialty, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [parseInt(project_id), parseInt(company_id), crew_name, supervisor_id || null,
        crew_size ? parseInt(crew_size) : 1, specialty || null, notes || null, req.user.id]);

    res.status(201).json({ success: true, message: 'Crew created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── PMO DASHBOARD ────────────────────────────────────────────

// GET /api/pmo/dashboard
router.get('/dashboard', async (req, res, next) => {
  try {
    const { project_id } = req.query;
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const companyFilter = authorizedCompanyId ? `AND company_id = ${authorizedCompanyId}` : '';
    const projectFilter = project_id ? `AND project_id = ${parseInt(project_id)}` : '';

    const [taskSummary, milestonesSummary, ticketsSummary, alerts] = await Promise.all([
      query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='completed') AS completed,
          COUNT(*) FILTER (WHERE status='in_progress') AS in_progress,
          COUNT(*) FILTER (WHERE status='blocked') AS blocked,
          COUNT(*) FILTER (WHERE status='delayed') AS delayed,
          COUNT(*) FILTER (WHERE status='not_started') AS not_started,
          COUNT(*) FILTER (WHERE planned_end_date < CURRENT_DATE AND status NOT IN ('completed','cancelled')) AS overdue,
          ROUND(AVG(progress_percent),1) AS avg_progress
        FROM project_tasks
        WHERE 1=1 ${companyFilter} ${projectFilter}
      `),
      query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='completed') AS completed,
          COUNT(*) FILTER (WHERE is_delayed = TRUE) AS delayed,
          COUNT(*) FILTER (WHERE status='pending') AS pending
        FROM project_milestones
        WHERE 1=1 ${companyFilter} ${projectFilter}
      `),
      query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='open') AS open,
          COUNT(*) FILTER (WHERE status='escalated') AS escalated,
          COUNT(*) FILTER (WHERE priority='critical') AS critical
        FROM project_tickets
        WHERE 1=1 ${companyFilter} ${projectFilter}
      `),
      query(`
        SELECT * FROM pmo_alerts
        WHERE 1=1 ${companyFilter} ${projectFilter}
        ORDER BY
          CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
          days_overdue DESC NULLS LAST
        LIMIT 20
      `)
    ]);

    res.json({
      success: true,
      data: {
        tasks:      taskSummary.rows[0],
        milestones: milestonesSummary.rows[0],
        tickets:    ticketsSummary.rows[0],
        alerts:     alerts.rows
      }
    });
  } catch (error) { next(error); }
});

// GET /api/pmo/alerts
router.get('/alerts', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (req.query.project_id) { conditions.push(`project_id = $${idx++}`); values.push(parseInt(req.query.project_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT * FROM pmo_alerts ${where} ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, days_overdue DESC NULLS LAST`,
      values
    );

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

module.exports = router;
