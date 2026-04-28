'use strict';

const { query } = require('../config/database');

class Task {
  static async findAll({ projectId, assignedTo, status, priority, search, page = 1, limit = 20, companyId, userRole, userId }) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (projectId) { conditions.push(`t.project_id = $${idx++}`); params.push(projectId); }
    if (status) { conditions.push(`t.status = $${idx++}`); params.push(status); }
    if (priority) { conditions.push(`t.priority = $${idx++}`); params.push(priority); }

    // Operatives only see their own tasks
    if (userRole === 'operative' || userRole === 'technician') {
      conditions.push(`t.assigned_to = $${idx++}`);
      params.push(userId);
    } else if (assignedTo) {
      conditions.push(`t.assigned_to = $${idx++}`);
      params.push(assignedTo);
    }

    if (search) {
      conditions.push(`t.title ILIKE $${idx++}`);
      params.push(`%${search}%`);
    }

    // Company scoping
    if (userRole !== 'admin' && !projectId) {
      conditions.push(`(t.project_id IS NULL OR t.project_id IN (SELECT id FROM projects WHERE company_id = $${idx++}))`);
      params.push(companyId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT t.*, u.name AS assignee_name, cr.name AS creator_name,
                p.name AS project_name, p.code AS project_code
         FROM tasks t
         LEFT JOIN users u ON u.id = t.assigned_to
         LEFT JOIN users cr ON cr.id = t.created_by
         LEFT JOIN projects p ON p.id = t.project_id
         ${where}
         ORDER BY
           CASE t.priority WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 WHEN 'media' THEN 3 ELSE 4 END,
           t.due_date ASC NULLS LAST
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) AS total FROM tasks t ${where}`, params),
    ]);

    return { data: rows.rows, total: parseInt(countResult.rows[0].total) };
  }

  static async findById(id) {
    const result = await query(
      `SELECT t.*, u.name AS assignee_name, u.email AS assignee_email,
              cr.name AS creator_name, p.name AS project_name, p.code AS project_code
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assigned_to
       LEFT JOIN users cr ON cr.id = t.created_by
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  static async create(data, createdBy) {
    const result = await query(
      `INSERT INTO tasks
         (title, description, project_id, assigned_to, created_by, priority, status, due_date, estimated_hours)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        data.title, data.description || null, data.project_id || null,
        data.assigned_to, createdBy, data.priority || 'media',
        data.status || 'no_iniciada', data.due_date || null,
        data.estimated_hours || null,
      ]
    );
    return result.rows[0];
  }

  static async update(id, updates) {
    const allowed = ['title', 'description', 'assigned_to', 'priority', 'status', 'due_date', 'estimated_hours', 'percent_complete'];
    const fields = [];
    const params = [];
    let idx = 1;
    for (const key of allowed) {
      if (key in updates) { fields.push(`${key} = $${idx++}`); params.push(updates[key]); }
    }
    if (!fields.length) return null;
    params.push(id);
    const result = await query(
      `UPDATE tasks SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  static async updateStatus(id, status) {
    const result = await query(
      `UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return result.rows[0] || null;
  }

  static async addComment(taskId, userId, content) {
    const result = await query(
      `INSERT INTO task_comments (task_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING *, (SELECT name FROM users WHERE id = $2) AS author_name`,
      [taskId, userId, content]
    );
    return result.rows[0];
  }

  static async getComments(taskId) {
    const result = await query(
      `SELECT tc.*, u.name AS author_name, u.avatar_url AS author_avatar
       FROM task_comments tc
       JOIN users u ON u.id = tc.user_id
       WHERE tc.task_id = $1
       ORDER BY tc.created_at ASC`,
      [taskId]
    );
    return result.rows;
  }

  static async addTimeEntry(taskId, userId, { start_time, end_time, duration_minutes, notes }) {
    // Calculate duration if start and end provided
    let duration = duration_minutes;
    if (!duration && start_time && end_time) {
      duration = Math.round((new Date(end_time) - new Date(start_time)) / 60000);
    }

    const result = await query(
      `INSERT INTO time_entries (task_id, user_id, start_time, end_time, duration_minutes, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [taskId, userId, start_time, end_time || null, duration || null, notes || null]
    );

    // Update actual_hours on task
    if (duration) {
      await query(
        `UPDATE tasks SET actual_hours = actual_hours + $1 WHERE id = $2`,
        [duration / 60, taskId]
      );
    }

    return result.rows[0];
  }

  static async getTimeEntries(taskId) {
    const result = await query(
      `SELECT te.*, u.name AS user_name
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       WHERE te.task_id = $1
       ORDER BY te.start_time DESC`,
      [taskId]
    );
    return result.rows;
  }

  static async softDelete(id) {
    const result = await query(
      `UPDATE tasks SET status = 'cancelada', updated_at = NOW()
       WHERE id = $1 RETURNING id, status`,
      [id]
    );
    return result.rows[0] || null;
  }
}

module.exports = Task;
