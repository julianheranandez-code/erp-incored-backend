'use strict';

const { query, withTransaction } = require('../config/database');

class Project {
  static async findAll({ companyId, status, clientId, pmId, search, page = 1, limit = 20, userRole }) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (userRole !== 'admin' && companyId) {
      conditions.push(`p.company_id = $${idx++}`);
      params.push(companyId);
    } else if (companyId) {
      conditions.push(`p.company_id = $${idx++}`);
      params.push(companyId);
    }

    if (status) { conditions.push(`p.status = $${idx++}`); params.push(status); }
    if (clientId) { conditions.push(`p.client_id = $${idx++}`); params.push(clientId); }
    if (pmId) { conditions.push(`p.pm_id = $${idx++}`); params.push(pmId); }
    if (search) {
      conditions.push(`(p.name ILIKE $${idx} OR p.code ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT p.*, c.name AS client_name, co.name AS company_name,
                u.name AS pm_name
         FROM projects p
         LEFT JOIN clients c ON c.id = p.client_id
         LEFT JOIN companies co ON co.id = p.company_id
         LEFT JOIN users u ON u.id = p.pm_id
         ${where}
         ORDER BY p.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) AS total FROM projects p ${where}`, params),
    ]);

    return { data: rows.rows, total: parseInt(countResult.rows[0].total) };
  }

  static async findById(id) {
    const result = await query(
      `SELECT p.*, c.name AS client_name, c.rfc AS client_rfc,
              co.name AS company_name, co.short_code AS company_code,
              u.name AS pm_name, u.email AS pm_email
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN companies co ON co.id = p.company_id
       LEFT JOIN users u ON u.id = p.pm_id
       WHERE p.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  static async create(data, createdBy) {
    const {
      code, name, client_id, company_id, pm_id, order_number,
      budget_amount, currency, expected_margin, country, city,
      start_date, end_date_planned, description,
    } = data;

    const result = await query(
      `INSERT INTO projects
         (code, name, client_id, company_id, pm_id, order_number, budget_amount,
          currency, expected_margin, country, city, start_date, end_date_planned,
          description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [code, name, client_id, company_id, pm_id || null, order_number || null,
       budget_amount || null, currency || 'MXN', expected_margin || null,
       country || null, city || null, start_date || null, end_date_planned || null,
       description || null, createdBy]
    );
    return result.rows[0];
  }

  static async update(id, updates) {
    const allowed = [
      'name', 'client_id', 'pm_id', 'order_number', 'budget_amount', 'currency',
      'expected_margin', 'status', 'progress_percent', 'country', 'city',
      'start_date', 'end_date_planned', 'end_date_real', 'description', 'notes',
    ];
    const fields = [];
    const params = [];
    let idx = 1;
    for (const key of allowed) {
      if (key in updates) {
        fields.push(`${key} = $${idx++}`);
        params.push(updates[key]);
      }
    }
    if (!fields.length) return null;
    params.push(id);
    const result = await query(
      `UPDATE projects SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  static async getFinances(id) {
    const [incomes, expenses] = await Promise.all([
      query(
        `SELECT SUM(amount) AS total_income FROM transactions
         WHERE project_id = $1 AND type = 'ingreso' AND status != 'cancelada'`,
        [id]
      ),
      query(
        `SELECT SUM(amount) AS total_expense FROM transactions
         WHERE project_id = $1 AND type = 'egreso' AND status != 'cancelada'`,
        [id]
      ),
    ]);

    const project = await this.findById(id);
    const totalIncome = parseFloat(incomes.rows[0].total_income) || 0;
    const totalExpense = parseFloat(expenses.rows[0].total_expense) || 0;
    const margin = totalIncome > 0 ? ((totalIncome - totalExpense) / totalIncome) * 100 : 0;

    return {
      budget: project?.budget_amount || 0,
      spent: totalExpense,
      income: totalIncome,
      balance: totalIncome - totalExpense,
      margin_percent: Math.round(margin * 100) / 100,
      budget_used_percent: project?.budget_amount
        ? Math.round((totalExpense / project.budget_amount) * 100)
        : 0,
    };
  }

  static async getTeam(id) {
    const result = await query(
      `SELECT u.id, u.name, u.email, u.role, pm.role AS project_role, pm.added_at
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1
       ORDER BY u.name`,
      [id]
    );
    return result.rows;
  }

  static async getKanban(id) {
    const result = await query(
      `SELECT t.*, u.name AS assignee_name
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assigned_to
       WHERE t.project_id = $1
       ORDER BY t.priority DESC, t.due_date ASC`,
      [id]
    );

    const columns = {
      no_iniciada: [], pendiente: [], en_proceso: [],
      bloqueada: [], en_revision: [], completada: [], cancelada: [],
    };

    result.rows.forEach((task) => {
      if (columns[task.status]) columns[task.status].push(task);
    });

    return columns;
  }

  static async getGantt(id) {
    const result = await query(
      `SELECT t.id, t.title, t.status, t.priority, t.start_date, t.due_date,
              t.percent_complete, t.estimated_hours, t.actual_hours,
              t.assigned_to, u.name AS assignee_name, t.parent_task_id
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assigned_to
       WHERE t.project_id = $1 AND t.status != 'cancelada'
       ORDER BY t.due_date ASC NULLS LAST, t.priority DESC`,
      [id]
    );
    return result.rows;
  }

  static async getCount(companyId) {
    const result = await query(
      `SELECT COUNT(*) AS count FROM projects WHERE company_id = $1`,
      [companyId]
    );
    return parseInt(result.rows[0].count);
  }
}

module.exports = Project;
