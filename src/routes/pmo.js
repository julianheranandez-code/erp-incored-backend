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
  if (user.role === 'super_admin') return requestedCompanyId ? parseInt(requestedCompanyId) : null;
  if (requestedCompanyId) {
    const userCompanies = (user.company_access || [parseInt(user.company_id)]).map(Number);
    const requested = parseInt(requestedCompanyId);
    if (userCompanies.includes(requested)) return requested;
  }
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

    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.map(Number).includes(parseInt(company_id))) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Company access denied.' });
    }

    const result = await query(`
      INSERT INTO project_tasks (
        project_id, company_id, milestone_id,
        name, task_name, description,
        assigned_user_id, assigned_crew_id,
        priority, status,
        planned_start_date, planned_end_date
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      parseInt(project_id), parseInt(company_id),
      milestone_id ? parseInt(milestone_id) : null,
      task_name, task_name, description || null,
      assigned_user_id || null,
      assigned_crew_id ? parseInt(assigned_crew_id) : null,
      priority, status,
      planned_start_date || null, planned_end_date || null
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
        name                = COALESCE($1, name),
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
        milestone_id        = COALESCE($12::integer, milestone_id),
        updated_at          = NOW()
      WHERE id = $13 RETURNING *
    `, [
      task_name || null, description || null,
      status || null, priority || null,
      progress_percent !== undefined ? parseInt(progress_percent) : null,
      assigned_user_id || null,
      assigned_crew_id || null,
      planned_start_date || null, planned_end_date || null,
      autoActualStart || null, autoActualEnd || null,
      milestone_id || null,
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
      INSERT INTO project_milestones (project_id, company_id, name, description, planned_date)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [parseInt(project_id), parseInt(company_id), name, description || null, planned_date]);

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

        status           = COALESCE($5, status),
        updated_at       = NOW()
      WHERE id = $6 RETURNING *
    `, [name||null, description||null, planned_date||null, actual_date||null, status||null, id]);

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
      materials_used, equipment_used, notes,
      // v2 fields
      crew, supervisor, activity_id, activity,
      quantity_done, unit, productivity,
      site_access, weather, allocation_ticket, municipal_permit,
      stopper_category, stopper_severity, stopper, has_stopper = false,
      affected_tasks, date
    } = req.body;

    if (!project_id || !company_id) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: project_id, company_id' });
    }

    const authorizedCompanyId = getAuthorizedCompanyId(req.user, company_id);
    if (!authorizedCompanyId && req.user.role !== 'super_admin')
      return res.status(403).json({ success: false, error: 'forbidden' });

    const rDate = date || report_date || new Date().toISOString().split('T')[0];

    // Auto-generate report_number: DR-{CO_ID}-{PR_ID}-{DATE}-{SEQ}
    const counterResult = await query(`
      INSERT INTO pmo_daily_report_counters (project_id, report_date, last_seq)
      VALUES ($1, $2, 1)
      ON CONFLICT (project_id, report_date)
      DO UPDATE SET last_seq = pmo_daily_report_counters.last_seq + 1
      RETURNING last_seq
    `, [parseInt(project_id), rDate]);
    const seq = counterResult.rows[0].last_seq;
    const report_number = \`DR-\${company_id}-\${project_id}-\${rDate.replace(/-/g,'')}-\${String(seq).padStart(2,'0')}\`;

    const result = await query(`
      INSERT INTO project_daily_reports (
        project_id, company_id, crew_id, report_date, date,
        work_completed, planned_tomorrow, incidents,
        weather_impact, weather_notes,
        crew_count, productivity_rating,
        materials_used, equipment_used, notes, submitted_by, created_by,
        report_number, crew, supervisor, activity_id, activity,
        quantity_done, unit, productivity,
        site_access, weather, allocation_ticket, municipal_permit,
        stopper_category, stopper_severity, stopper, has_stopper, affected_tasks,
        status
      ) VALUES (
        $1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,'submitted'
      )
      RETURNING *
    `, [
      parseInt(project_id), parseInt(company_id),
      crew_id ? parseInt(crew_id) : null,
      rDate,
      work_completed || null, planned_tomorrow || null,
      incidents || null, weather_impact, weather_notes || null,
      crew_count ? parseInt(crew_count) : null,
      productivity_rating ? parseInt(productivity_rating) : null,
      materials_used ? (typeof materials_used === 'string' ? materials_used : JSON.stringify(materials_used)) : null,
      equipment_used || null, notes || null,
      req.user.id,
      report_number,
      crew || null, supervisor || null,
      activity_id ? parseInt(activity_id) : null, activity || null,
      quantity_done ? parseFloat(quantity_done) : null, unit || null,
      productivity ? parseFloat(productivity) : null,
      site_access || null, weather || null,
      allocation_ticket || null, municipal_permit || null,
      stopper_category || null, stopper_severity || null,
      stopper || null, has_stopper,
      affected_tasks || null
    ]);

    writeAudit({
      userId: req.user.id, action: 'daily_report_created',
      entityType: 'project_daily_reports', entityId: String(result.rows[0].id),
      companyId: parseInt(company_id),
      newValues: { report_number, project_id, date: rDate },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    logger.info(\`[PMO] Daily report \${report_number} submitted in \${Date.now()-startTime}ms\`);
    res.status(201).json({ success: true, message: 'Daily report submitted.',
      data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── DAILY REPORTS V2 ────────────────────────────────────────

// GET /api/pmo/daily-reports/catalogs
router.get('/daily-reports/catalogs', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT field, value, sort_order
      FROM pmo_daily_report_catalogs
      WHERE active = true
      ORDER BY field, sort_order
    `);
    // Group by field
    const catalogs = {};
    for (const row of result.rows) {
      if (!catalogs[row.field]) catalogs[row.field] = [];
      catalogs[row.field].push({ value: row.value, sort_order: row.sort_order });
    }
    res.json({ success: true, data: catalogs });
  } catch (error) { next(error); }
});

// GET /api/pmo/daily-reports/:id
router.get('/daily-reports/:id', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const result = await query(`
      SELECT r.*,
        p.name AS project_name, p.code AS project_code_ref,
        cr.crew_name,
        CONCAT(u.first_name,' ',u.last_name) AS submitted_by_name,
        CONCAT(cu.first_name,' ',cu.last_name) AS created_by_name
      FROM project_daily_reports r
      LEFT JOIN projects p ON p.id = r.project_id
      LEFT JOIN project_crews cr ON cr.id = r.crew_id
      LEFT JOIN users u ON u.id = r.submitted_by
      LEFT JOIN users cu ON cu.id = r.created_by
      WHERE r.id = $1 ${authorizedCompanyId ? 'AND r.company_id = $2' : ''}
    `, authorizedCompanyId ? [parseInt(req.params.id), authorizedCompanyId] : [parseInt(req.params.id)]);

    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    // Get attachments
    const attachments = await query(`
      SELECT a.*, pd.file_url, pd.original_name, pd.mime_type AS doc_mime
      FROM pmo_daily_report_attachments a
      LEFT JOIN project_documents pd ON pd.id = a.project_document_id
      WHERE a.daily_report_id = $1
      ORDER BY a.created_at ASC
    `, [parseInt(req.params.id)]);

    res.json({ success: true, data: { ...result.rows[0], attachments: attachments.rows } });
  } catch (error) { next(error); }
});

// PATCH /api/pmo/daily-reports/:id
router.patch('/daily-reports/:id', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const id = parseInt(req.params.id);

    const existing = await query(
      'SELECT * FROM project_daily_reports WHERE id=$1', [id]
    );
    if (!existing.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    if (authorizedCompanyId && existing.rows[0].company_id !== authorizedCompanyId)
      return res.status(403).json({ success: false, error: 'forbidden' });

    const allowed = [
      'work_completed','planned_tomorrow','incidents','weather_impact','weather_notes',
      'crew_count','productivity_rating','materials_used','equipment_used','notes',
      'crew','supervisor','activity','quantity_done','unit','productivity',
      'site_access','weather','allocation_ticket','municipal_permit',
      'stopper_category','stopper_severity','stopper','has_stopper','affected_tasks',
      'status','date'
    ];

    const fields = [];
    const params = [];
    let idx = 1;
    for (const key of allowed) {
      if (key in req.body) {
        fields.push(`${key} = $${idx++}`);
        params.push(req.body[key]);
      }
    }
    if (!fields.length) return res.status(400).json({ success: false, error: 'no_fields' });

    params.push(id);
    const result = await query(
      `UPDATE project_daily_reports SET ${fields.join(', ')}, updated_at=NOW() WHERE id=$${idx} RETURNING *`,
      params
    );

    writeAudit({
      userId: req.user.id, action: 'daily_report_updated',
      entityType: 'project_daily_reports', entityId: String(id),
      companyId: existing.rows[0].company_id,
      newValues: req.body,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Daily report updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// POST /api/pmo/daily-reports/:id/attachments
router.post('/daily-reports/:id/attachments', async (req, res, next) => {
  try {
    const { project_document_id, tag, file_name, mime_type, size_bytes } = req.body;
    const dailyReportId = parseInt(req.params.id);

    const reportCheck = await query(
      'SELECT id, company_id, project_id FROM project_daily_reports WHERE id=$1', [dailyReportId]
    );
    if (!reportCheck.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const report = reportCheck.rows[0];
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.body.company_id);
    if (authorizedCompanyId && report.company_id !== authorizedCompanyId)
      return res.status(403).json({ success: false, error: 'forbidden' });

    const VALID_TAGS = ['Reporte de site','Reporte de instalación','Site Survey',
      'Orden de servicio','Plano modificado','Adecuación','Ingeniería',
      'Protocolo de aceptación','Reporte de incidencia','Otro'];
    if (tag && !VALID_TAGS.includes(tag))
      return res.status(400).json({ success: false, error: 'invalid_tag',
        message: `tag must be one of: ${VALID_TAGS.join(', ')}` });

    const result = await query(`
      INSERT INTO pmo_daily_report_attachments
        (daily_report_id, project_document_id, company_id, project_id,
         tag, file_name, mime_type, size_bytes, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      dailyReportId,
      project_document_id ? parseInt(project_document_id) : null,
      report.company_id, report.project_id,
      tag || 'Otro', file_name || null, mime_type || null,
      size_bytes ? parseInt(size_bytes) : null,
      req.user.id
    ]);

    res.status(201).json({ success: true, message: 'Attachment linked.', data: result.rows[0] });
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

    // When project_id is provided, return crews assigned to that project
    // OR unassigned crews (pool available for assignment) — both are selectable
    let where = '';
    if (conditions.length && project_id) {
      where = `WHERE ${conditions.join(' AND ')} AND (c.project_id = $${idx++} OR c.project_id IS NULL)`;
      values.push(parseInt(project_id));
    } else if (conditions.length) {
      where = `WHERE ${conditions.join(' AND ')}`;
    }

    const result = await query(`
      SELECT c.*,
        p.name AS project_name,
        CONCAT(u.first_name,' ',u.last_name) AS supervisor_name,
        u.email AS supervisor_email,
        sc.name AS subcontractor_name,
        (SELECT COUNT(*) FROM project_activities pa WHERE pa.crew_id = c.id) AS activities_count
      FROM project_crews c
      LEFT JOIN projects p  ON p.id = c.project_id
      LEFT JOIN users u    ON u.id = c.supervisor_id
      LEFT JOIN clients sc ON sc.id = c.subcontractor_id
      ${where}
      ORDER BY c.crew_name ASC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// POST /api/pmo/crews
router.post('/crews', async (req, res, next) => {
  try {
    const { project_id, company_id, crew_name, supervisor_id, crew_size, specialty, notes,
            crew_type, subcontractor_id, start_date, end_date } = req.body;
    if (!project_id || !company_id || !crew_name) {
      return res.status(400).json({ success: false, error: 'validation_error', message: 'Required: project_id, company_id, crew_name' });
    }

    const result = await query(`
      INSERT INTO project_crews (project_id, company_id, crew_name, supervisor_id, crew_size, specialty, notes, crew_type, subcontractor_id, start_date, end_date, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
    `, [parseInt(project_id), parseInt(company_id), crew_name, supervisor_id || null,
        crew_size ? parseInt(crew_size) : 1, specialty || null, notes || null,
        crew_type || null, subcontractor_id ? parseInt(subcontractor_id) : null,
        start_date || null, end_date || null, req.user.id]);

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

    const safeQuery = async (sql) => { try { return await query(sql); } catch(e) { return { rows: [{}] }; } };
    const [taskSummary, milestonesSummary, ticketsSummary, alerts] = await Promise.all([
      safeQuery(`
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
      safeQuery(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='completed') AS completed,
          COUNT(*) FILTER (WHERE is_delayed = TRUE) AS delayed,
          COUNT(*) FILTER (WHERE status='pending') AS pending
        FROM project_milestones
        WHERE 1=1 ${companyFilter} ${projectFilter}
      `),
      safeQuery(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='open') AS open,
          COUNT(*) FILTER (WHERE status='escalated') AS escalated,
          COUNT(*) FILTER (WHERE priority='critical') AS critical
        FROM project_tickets
        WHERE 1=1 ${companyFilter} ${projectFilter}
      `),
      safeQuery(`
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


// ─── PMO RISKS ────────────────────────────────────────────────

router.get('/risks', async (req, res, next) => {
  try {
    const { project_id, company_id, status, severity, category } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id_required' });
    const userCompanies = req.user.company_access || [req.user.company_id];
    const cid = parseInt(company_id);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });
    let conditions = ['r.company_id = $1'];
    let values = [cid];
    let idx = 2;
    if (project_id) {
      const proj = await query('SELECT id FROM projects WHERE id=$1 AND company_id=$2', [parseInt(project_id), cid]);
      if (!proj.rows[0]) return res.status(403).json({ success: false, error: 'project_company_mismatch' });
      conditions.push(`r.project_id = $${idx++}`);
      values.push(parseInt(project_id));
    }
    if (status)   { conditions.push(`r.status = $${idx++}`);   values.push(status); }
    if (severity) { conditions.push(`r.severity = $${idx++}`); values.push(severity); }
    if (category) { conditions.push(`r.category = $${idx++}`); values.push(category); }
    const result = await query(`
      SELECT r.uuid, r.title, r.description, r.category,
        r.probability, r.impact, r.probability_score, r.impact_score,
        r.risk_score, r.severity, r.mitigation_plan, r.status,
        r.identified_at, r.target_resolution_date, r.resolved_at, r.notes,
        r.project_id, r.company_id, r.created_at, r.updated_at,
        p.code AS project_code, p.name AS project_name,
        CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal, e.last_name,'')) AS owner_name
      FROM project_risks r
      LEFT JOIN projects p ON p.id = r.project_id
      LEFT JOIN employees e ON e.id = r.owner_employee_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.risk_score DESC, r.created_at DESC
    `, values);
    const summary = {
      total: result.rows.length,
      critical: result.rows.filter(r => r.severity === 'critical').length,
      high: result.rows.filter(r => r.severity === 'high').length,
      open: result.rows.filter(r => ['identified','mitigating'].includes(r.status)).length,
    };
    res.json({ success: true, count: result.rows.length, summary, data: result.rows });
  } catch(e) { next(e); }
});

// ─── PMO DELIVERABLES ─────────────────────────────────────────

router.get('/deliverables', async (req, res, next) => {
  try {
    const { project_id, company_id, status, deliverable_type } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id_required' });
    const userCompanies = req.user.company_access || [req.user.company_id];
    const cid = parseInt(company_id);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });
    let conditions = ['d.company_id = $1'];
    let values = [cid];
    let idx = 2;
    if (project_id) {
      const proj = await query('SELECT id FROM projects WHERE id=$1 AND company_id=$2', [parseInt(project_id), cid]);
      if (!proj.rows[0]) return res.status(403).json({ success: false, error: 'project_company_mismatch' });
      conditions.push(`d.project_id = $${idx++}`);
      values.push(parseInt(project_id));
    }
    if (status)           { conditions.push(`d.status = $${idx++}`);           values.push(status); }
    if (deliverable_type) { conditions.push(`d.deliverable_type = $${idx++}`); values.push(deliverable_type); }
    const result = await query(`
      SELECT d.uuid, d.title, d.description, d.deliverable_type,
        d.due_date, d.status, d.submitted_at, d.accepted_at, d.rejected_at,
        d.ready_to_bill_at, d.invoiced_at, d.requires_client_approval,
        d.client_approval_status, d.client_approval_method,
        d.client_approved_by, d.client_approved_at,
        d.rejection_reason, d.notes,
        d.project_id, d.company_id, d.created_at, d.updated_at,
        p.code AS project_code, p.name AS project_name,
        CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal, e.last_name,'')) AS owner_name,
        CONCAT(ab.first_name,' ',COALESCE(ab.last_name,'')) AS accepted_by_name,
        CONCAT(rb.first_name,' ',COALESCE(rb.last_name,'')) AS ready_to_bill_by_name,
        ai.folio AS invoice_folio, ai.total_amount AS invoice_amount, ai.status AS invoice_status
      FROM project_deliverables d
      LEFT JOIN projects p ON p.id = d.project_id
      LEFT JOIN employees e ON e.id = d.owner_employee_id
      LEFT JOIN users ab ON ab.id = d.accepted_by
      LEFT JOIN users rb ON rb.id = d.ready_to_bill_by
      LEFT JOIN ar_invoices ai ON ai.deliverable_id = d.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.due_date ASC NULLS LAST, d.created_at DESC
    `, values);
    const summary = {
      total:         result.rows.length,
      pending:       result.rows.filter(r => r.status === 'pending').length,
      submitted:     result.rows.filter(r => r.status === 'submitted').length,
      accepted:      result.rows.filter(r => r.status === 'accepted').length,
      ready_to_bill: result.rows.filter(r => r.status === 'ready_to_bill').length,
      invoiced:      result.rows.filter(r => r.status === 'invoiced').length,
    };
    res.json({ success: true, count: result.rows.length, summary, data: result.rows });
  } catch(e) { next(e); }
});

router.get('/deliverables/:uuid/events', async (req, res, next) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id_required' });
    const userCompanies = req.user.company_access || [req.user.company_id];
    const cid = parseInt(company_id);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });
    const del = await query(
      'SELECT id FROM project_deliverables WHERE uuid=$1 AND company_id=$2',
      [req.params.uuid, cid]
    );
    if (!del.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT de.uuid, de.event_type, de.previous_status, de.new_status,
        de.performed_at, de.notes, de.metadata,
        CONCAT(u.first_name,' ',COALESCE(u.last_name,'')) AS performed_by_name
      FROM deliverable_events de
      LEFT JOIN users u ON u.id = de.performed_by
      WHERE de.deliverable_id = $1
      ORDER BY de.performed_at ASC
    `, [del.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

router.get('/deliverables/:uuid/evidence', async (req, res, next) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id_required' });
    const userCompanies = req.user.company_access || [req.user.company_id];
    const cid = parseInt(company_id);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });
    const del = await query(`
      SELECT d.id, d.uuid, d.client_approval_status, d.client_approval_method,
        d.client_approved_by, d.client_approved_at, d.client_approval_reference,
        d.client_approval_document_id, d.requires_client_approval,
        da.original_filename AS file_name, da.storage_path AS file_url, da.uploaded_at
      FROM project_deliverables d
      LEFT JOIN document_attachments da ON da.id = d.client_approval_document_id
      WHERE d.uuid=$1 AND d.company_id=$2
    `, [req.params.uuid, cid]);
    if (!del.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: del.rows[0] });
  } catch(e) { next(e); }
});


// ─── PHASE 2: RISKS CREATE/EDIT ───────────────────────────────

// POST /api/pmo/risks
router.post('/risks', async (req, res, next) => {
  try {
    const {
      company_id, project_id, title, description, category = 'operational',
      probability = 'medium', impact = 'medium', mitigation_plan,
      owner_employee_id, status = 'identified',
      target_resolution_date, notes
    } = req.body;

    if (!company_id || !project_id || !title)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, project_id, title' });

    const cid = parseInt(company_id);
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    // Validate project belongs to company
    const proj = await query('SELECT id FROM projects WHERE id=$1 AND company_id=$2',
      [parseInt(project_id), cid]);
    if (!proj.rows[0])
      return res.status(400).json({ success: false, error: 'project_company_mismatch',
        message: 'Project does not belong to this company.' });

    // Validate owner employee belongs to company
    if (owner_employee_id) {
      const emp = await query('SELECT id FROM employees WHERE id=$1 AND company_id=$2',
        [parseInt(owner_employee_id), cid]);
      if (!emp.rows[0])
        return res.status(400).json({ success: false, error: 'employee_company_mismatch',
          message: 'Owner employee does not belong to this company.' });
    }

    const result = await query(`
      INSERT INTO project_risks
        (company_id, project_id, title, description, category, probability, impact,
         mitigation_plan, owner_employee_id, status, target_resolution_date, notes,
         created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
      RETURNING uuid, title, category, probability, impact,
                probability_score, impact_score, risk_score, severity, status
    `, [cid, parseInt(project_id), title, description||null, category,
        probability, impact, mitigation_plan||null,
        owner_employee_id ? parseInt(owner_employee_id) : null,
        status, target_resolution_date||null, notes||null, req.user.id]);

    res.status(201).json({ success: true, data: result.rows[0],
      message: 'Risk registered.' });
  } catch(e) { next(e); }
});

// PUT /api/pmo/risks/:uuid
router.put('/risks/:uuid', async (req, res, next) => {
  try {
    const risk = await query(
      'SELECT id, company_id, status FROM project_risks WHERE uuid=$1',
      [req.params.uuid]);
    if (!risk.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const cid = risk.rows[0].company_id;
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const {
      title, description, category, probability, impact,
      mitigation_plan, owner_employee_id, status,
      target_resolution_date, resolved_at, notes
    } = req.body;

    // Validate owner employee if provided
    if (owner_employee_id) {
      const emp = await query('SELECT id FROM employees WHERE id=$1 AND company_id=$2',
        [parseInt(owner_employee_id), cid]);
      if (!emp.rows[0])
        return res.status(400).json({ success: false, error: 'employee_company_mismatch' });
    }

    const result = await query(`
      UPDATE project_risks SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        category = COALESCE($3, category),
        probability = COALESCE($4, probability),
        impact = COALESCE($5, impact),
        mitigation_plan = COALESCE($6, mitigation_plan),
        owner_employee_id = COALESCE($7, owner_employee_id),
        status = COALESCE($8, status),
        target_resolution_date = COALESCE($9, target_resolution_date),
        resolved_at = COALESCE($10, resolved_at),
        notes = COALESCE($11, notes),
        updated_by = $12,
        updated_at = NOW()
      WHERE id = $13
      RETURNING uuid, title, probability, impact,
                probability_score, impact_score, risk_score, severity, status
    `, [title||null, description||null, category||null,
        probability||null, impact||null, mitigation_plan||null,
        owner_employee_id ? parseInt(owner_employee_id) : null,
        status||null, target_resolution_date||null,
        resolved_at||null, notes||null,
        req.user.id, risk.rows[0].id]);

    res.json({ success: true, data: result.rows[0], message: 'Risk updated.' });
  } catch(e) { next(e); }
});

// ─── PHASE 2: DELIVERABLES CREATE/EDIT ────────────────────────

// POST /api/pmo/deliverables
router.post('/deliverables', async (req, res, next) => {
  try {
    const {
      company_id, project_id, title, description,
      deliverable_type = 'document', due_date,
      owner_employee_id, requires_client_approval = false, notes
    } = req.body;

    if (!company_id || !project_id || !title)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, project_id, title' });

    const cid = parseInt(company_id);
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    // Validate project belongs to company
    const proj = await query('SELECT id FROM projects WHERE id=$1 AND company_id=$2',
      [parseInt(project_id), cid]);
    if (!proj.rows[0])
      return res.status(400).json({ success: false, error: 'project_company_mismatch',
        message: 'Project does not belong to this company.' });

    // Validate owner employee belongs to company
    if (owner_employee_id) {
      const emp = await query('SELECT id FROM employees WHERE id=$1 AND company_id=$2',
        [parseInt(owner_employee_id), cid]);
      if (!emp.rows[0])
        return res.status(400).json({ success: false, error: 'employee_company_mismatch',
          message: 'Owner employee does not belong to this company.' });
    }

    const result = await withTransaction(async (client) => {
      const ins = await client.query(`
        INSERT INTO project_deliverables
          (company_id, project_id, title, description, deliverable_type,
           due_date, owner_employee_id, requires_client_approval,
           notes, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        RETURNING id, uuid, title, status, deliverable_type
      `, [cid, parseInt(project_id), title, description||null,
          deliverable_type, due_date||null,
          owner_employee_id ? parseInt(owner_employee_id) : null,
          requires_client_approval, notes||null, req.user.id]);

      // Append created event
      await client.query(`
        INSERT INTO deliverable_events
          (deliverable_id, company_id, project_id, event_type,
           previous_status, new_status, performed_by, notes)
        VALUES ($1,$2,$3,'created',null,'pending',$4,'Deliverable created')
      `, [ins.rows[0].id, cid, parseInt(project_id), req.user.id]);

      return ins.rows[0];
    });

    res.status(201).json({ success: true, data: result, message: 'Deliverable created.' });
  } catch(e) { next(e); }
});

// PUT /api/pmo/deliverables/:uuid
router.put('/deliverables/:uuid', async (req, res, next) => {
  try {
    const del = await query(
      'SELECT id, company_id, project_id, status FROM project_deliverables WHERE uuid=$1',
      [req.params.uuid]);
    if (!del.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const cid = del.rows[0].company_id;
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    // Block edit on controlled statuses
    const lockedStatuses = ['accepted','ready_to_bill','invoiced'];
    if (lockedStatuses.includes(del.rows[0].status) && req.user.role !== 'super_admin')
      return res.status(400).json({ success: false, error: 'locked',
        message: `Deliverable in status '${del.rows[0].status}' cannot be edited.` });

    const { title, description, deliverable_type, due_date,
            owner_employee_id, requires_client_approval, notes } = req.body;

    if (owner_employee_id) {
      const emp = await query('SELECT id FROM employees WHERE id=$1 AND company_id=$2',
        [parseInt(owner_employee_id), cid]);
      if (!emp.rows[0])
        return res.status(400).json({ success: false, error: 'employee_company_mismatch' });
    }

    const result = await query(`
      UPDATE project_deliverables SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        deliverable_type = COALESCE($3, deliverable_type),
        due_date = COALESCE($4, due_date),
        owner_employee_id = COALESCE($5, owner_employee_id),
        requires_client_approval = COALESCE($6, requires_client_approval),
        notes = COALESCE($7, notes),
        updated_by = $8,
        updated_at = NOW()
      WHERE id = $9
      RETURNING uuid, title, status, deliverable_type, due_date
    `, [title||null, description||null, deliverable_type||null,
        due_date||null,
        owner_employee_id ? parseInt(owner_employee_id) : null,
        requires_client_approval !== undefined ? requires_client_approval : null,
        notes||null, req.user.id, del.rows[0].id]);

    res.json({ success: true, data: result.rows[0], message: 'Deliverable updated.' });
  } catch(e) { next(e); }
});

// ─── PHASE 2: SUBMIT / REJECT ─────────────────────────────────

// POST /api/pmo/deliverables/:uuid/submit
router.post('/deliverables/:uuid/submit', async (req, res, next) => {
  try {
    const { notes } = req.body;
    const del = await query(
      'SELECT id, company_id, project_id, status FROM project_deliverables WHERE uuid=$1',
      [req.params.uuid]);
    if (!del.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const cid = del.rows[0].company_id;
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const allowedFromStatuses = ['pending','rejected'];
    if (!allowedFromStatuses.includes(del.rows[0].status))
      return res.status(400).json({ success: false, error: 'invalid_transition',
        message: `Cannot submit from status '${del.rows[0].status}'. Allowed: pending, rejected.` });

    const prevStatus = del.rows[0].status;

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE project_deliverables SET
          status = 'submitted', submitted_at = NOW(),
          updated_by = $1, updated_at = NOW()
        WHERE id = $2
      `, [req.user.id, del.rows[0].id]);

      await client.query(`
        INSERT INTO deliverable_events
          (deliverable_id, company_id, project_id, event_type,
           previous_status, new_status, performed_by, notes)
        VALUES ($1,$2,$3,'submitted',$4,'submitted',$5,$6)
      `, [del.rows[0].id, cid, del.rows[0].project_id,
          prevStatus, req.user.id, notes||null]);
    });

    res.json({ success: true, message: 'Deliverable submitted.',
      data: { status: 'submitted', submitted_at: new Date() } });
  } catch(e) { next(e); }
});

// POST /api/pmo/deliverables/:uuid/reject
router.post('/deliverables/:uuid/reject', async (req, res, next) => {
  try {
    const { reason, notes } = req.body;
    if (!reason) return res.status(400).json({ success: false, error: 'validation_error',
      message: 'rejection_reason is required.' });

    const del = await query(
      'SELECT id, company_id, project_id, status FROM project_deliverables WHERE uuid=$1',
      [req.params.uuid]);
    if (!del.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const cid = del.rows[0].company_id;
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    if (del.rows[0].status !== 'submitted')
      return res.status(400).json({ success: false, error: 'invalid_transition',
        message: `Cannot reject from status '${del.rows[0].status}'. Only submitted deliverables can be rejected.` });

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE project_deliverables SET
          status = 'rejected', rejected_at = NOW(),
          rejection_reason = $1, updated_by = $2, updated_at = NOW()
        WHERE id = $3
      `, [reason, req.user.id, del.rows[0].id]);

      await client.query(`
        INSERT INTO deliverable_events
          (deliverable_id, company_id, project_id, event_type,
           previous_status, new_status, performed_by, notes, metadata)
        VALUES ($1,$2,$3,'rejected','submitted','rejected',$4,$5,$6)
      `, [del.rows[0].id, cid, del.rows[0].project_id,
          req.user.id, notes||null,
          JSON.stringify({ rejection_reason: reason })]);
    });

    res.json({ success: true, message: 'Deliverable rejected — can be resubmitted.',
      data: { status: 'rejected', rejection_reason: reason } });
  } catch(e) { next(e); }
});


// ─── PHASE 3: ACCEPT / READY-TO-BILL ─────────────────────────

// POST /api/pmo/deliverables/:uuid/accept
router.post('/deliverables/:uuid/accept', async (req, res, next) => {
  try {
    const { notes } = req.body;
    const del = await query(
      'SELECT id, company_id, project_id, status FROM project_deliverables WHERE uuid=$1',
      [req.params.uuid]);
    if (!del.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const cid = del.rows[0].company_id;
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    if (del.rows[0].status !== 'submitted')
      return res.status(400).json({ success: false, error: 'invalid_transition',
        message: `Cannot accept from status '${del.rows[0].status}'. Only submitted deliverables can be accepted.` });

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE project_deliverables SET
          status = 'accepted', accepted_at = NOW(),
          accepted_by = $1, updated_by = $1, updated_at = NOW()
        WHERE id = $2
      `, [req.user.id, del.rows[0].id]);

      await client.query(`
        INSERT INTO deliverable_events
          (deliverable_id, company_id, project_id, event_type,
           previous_status, new_status, performed_by, notes)
        VALUES ($1,$2,$3,'accepted','submitted','accepted',$4,$5)
      `, [del.rows[0].id, cid, del.rows[0].project_id, req.user.id, notes||null]);
    });

    res.json({ success: true, message: 'Deliverable accepted.',
      data: { status: 'accepted', accepted_at: new Date() } });
  } catch(e) { next(e); }
});

// POST /api/pmo/deliverables/:uuid/ready-to-bill
router.post('/deliverables/:uuid/ready-to-bill', async (req, res, next) => {
  try {
    const { notes } = req.body;
    const del = await query(
      'SELECT id, company_id, project_id, status FROM project_deliverables WHERE uuid=$1',
      [req.params.uuid]);
    if (!del.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const cid = del.rows[0].company_id;
    const userCompanies = req.user.company_access || [req.user.company_id];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(cid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    if (del.rows[0].status !== 'accepted')
      return res.status(400).json({ success: false, error: 'invalid_transition',
        message: `Cannot mark ready-to-bill from status '${del.rows[0].status}'. Only accepted deliverables can be marked ready to bill.` });

    // Validate no existing invoice linked
    const existingInv = await query(
      'SELECT id FROM ar_invoices WHERE deliverable_id=$1', [del.rows[0].id]);
    if (existingInv.rows[0])
      return res.status(400).json({ success: false, error: 'already_invoiced',
        message: 'Deliverable is already linked to an AR Invoice.' });

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE project_deliverables SET
          status = 'ready_to_bill', ready_to_bill_at = NOW(),
          ready_to_bill_by = $1, updated_by = $1, updated_at = NOW()
        WHERE id = $2
      `, [req.user.id, del.rows[0].id]);

      await client.query(`
        INSERT INTO deliverable_events
          (deliverable_id, company_id, project_id, event_type,
           previous_status, new_status, performed_by, notes)
        VALUES ($1,$2,$3,'ready_to_bill','accepted','ready_to_bill',$4,$5)
      `, [del.rows[0].id, cid, del.rows[0].project_id, req.user.id, notes||null]);
    });

    res.json({ success: true, message: 'Deliverable marked as ready to bill.',
      data: { status: 'ready_to_bill', ready_to_bill_at: new Date() } });
  } catch(e) { next(e); }
});

module.exports = router;

// PUT /api/pmo/crews/:id
router.put('/crews/:id', async (req, res, next) => {
  try {
    const { crew_name, crew_type, supervisor_id, crew_size, specialty, status, notes, subcontractor_id } = req.body;
    const result = await query(`
      UPDATE project_crews SET
        crew_name        = COALESCE($1, crew_name),
        supervisor_id    = $2,
        crew_size        = COALESCE($3, crew_size),
        specialty        = COALESCE($4, specialty),
        status           = COALESCE($5, status),
        notes            = COALESCE($6, notes),
        crew_type        = COALESCE($7, crew_type),
        subcontractor_id = $8,
        updated_at       = NOW()
      WHERE id = $9
      RETURNING *`,
      [crew_name||null, supervisor_id||null,
       crew_size?parseInt(crew_size):null, specialty||null,
       status||null, notes||null,
       crew_type||null, subcontractor_id?parseInt(subcontractor_id):null,
       parseInt(req.params.id)]
    );
    if (!result.rows[0]) return res.status(404).json({ success:false,
      error:'not_found', message:'Crew not found' });
    res.json({ success:true, data:result.rows[0] });
  } catch(e) { next(e); }
});

// PATCH /api/pmo/crews/:id (alias for PUT)
router.patch('/crews/:id', async (req, res, next) => {
  req.method = 'PUT';
  const { crew_name, crew_type, supervisor_id, crew_size, specialty, status, notes, subcontractor_id, start_date, end_date } = req.body;
  try {
    const result = await query(`
      UPDATE project_crews SET
        crew_name        = COALESCE($1, crew_name),
        supervisor_id    = $2,
        crew_size        = COALESCE($3, crew_size),
        specialty        = COALESCE($4, specialty),
        status           = COALESCE($5, status),
        notes            = COALESCE($6, notes),
        crew_type        = COALESCE($7, crew_type),
        subcontractor_id = $8,
        start_date       = COALESCE($9, start_date),
        end_date         = COALESCE($10, end_date),
        updated_at       = NOW()
      WHERE id = $11
      RETURNING *`,
      [crew_name||null, supervisor_id||null,
       crew_size?parseInt(crew_size):null, specialty||null,
       status||null, notes||null,
       crew_type||null, subcontractor_id?parseInt(subcontractor_id):null,
       start_date||null, end_date||null,
       parseInt(req.params.id)]
    );
    if (!result.rows[0]) return res.status(404).json({ success:false, error:'not_found', message:'Crew not found' });
    res.json({ success:true, data:result.rows[0] });
  } catch(e) { next(e); }
});
