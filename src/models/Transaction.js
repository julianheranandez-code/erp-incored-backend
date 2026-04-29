'use strict';

const { query } = require('../config/database');

class Transaction {
  static async findAll({ companyId, type, category, projectId, clientId, dateFrom, dateTo, search, page = 1, limit = 20 }) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (companyId) { conditions.push(`t.company_id = $${idx++}`); params.push(companyId); }
    if (type) { conditions.push(`t.type = $${idx++}`); params.push(type); }
    if (category) { conditions.push(`t.category = $${idx++}`); params.push(category); }
    if (projectId) { conditions.push(`t.project_id = $${idx++}`); params.push(projectId); }
    if (clientId) { conditions.push(`t.client_id = $${idx++}`); params.push(clientId); }
    if (dateFrom) { conditions.push(`t.transaction_date >= $${idx++}`); params.push(dateFrom); }
    if (dateTo) { conditions.push(`t.transaction_date <= $${idx++}`); params.push(dateTo); }
    if (search) {
      conditions.push(`(t.description ILIKE $${idx} OR t.reference_number ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult, sumResult] = await Promise.all([
      query(
        `SELECT t.*, c.name AS client_name, p.name AS project_name,
                co.name AS company_name, CONCAT(u.first_name, ' ', u.last_name) AS created_by_name
         FROM transactions t
         LEFT JOIN clients c ON c.id = t.client_id
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN companies co ON co.id = t.company_id
         LEFT JOIN users u ON u.id = t.created_by
         ${where}
         ORDER BY t.transaction_date DESC, t.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) AS total FROM transactions t ${where}`, params),
      query(
        `SELECT
           SUM(CASE WHEN type = 'ingreso' THEN amount ELSE 0 END) AS total_income,
           SUM(CASE WHEN type = 'egreso' THEN amount ELSE 0 END)  AS total_expense
         FROM transactions t ${where}`,
        params
      ),
    ]);

    return {
      data: rows.rows,
      total: parseInt(countResult.rows[0].total),
      summary: {
        total_income: parseFloat(sumResult.rows[0].total_income) || 0,
        total_expense: parseFloat(sumResult.rows[0].total_expense) || 0,
      },
    };
  }

  static async findById(id) {
    const result = await query(
      `SELECT t.*, c.name AS client_name, p.name AS project_name,
              co.name AS company_name, CONCAT(u.first_name, ' ', u.last_name) AS created_by_name
       FROM transactions t
       LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN companies co ON co.id = t.company_id
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  static async create(data, createdBy) {
    const result = await query(
      `INSERT INTO transactions
         (type, category, company_id, project_id, client_id, amount, currency,
          exchange_rate, description, reference_number, transaction_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        data.type, data.category, data.company_id,
        data.project_id || null, data.client_id || null,
        data.amount, data.currency || 'MXN', data.exchange_rate || 1,
        data.description || null, data.reference_number || null,
        data.transaction_date, createdBy,
      ]
    );

    // Update project spent_amount if linked
    if (data.project_id && data.type === 'egreso') {
      await query(
        `UPDATE projects SET spent_amount = spent_amount + $1 WHERE id = $2`,
        [data.amount, data.project_id]
      );
    }

    return result.rows[0];
  }

  static async update(id, data) {
    const allowed = ['category', 'amount', 'currency', 'description', 'reference_number', 'transaction_date', 'status'];
    const fields = [];
    const params = [];
    let idx = 1;
    for (const key of allowed) {
      if (key in data) { fields.push(`${key} = $${idx++}`); params.push(data[key]); }
    }
    if (!fields.length) return null;
    params.push(id);
    const result = await query(
      `UPDATE transactions SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  static async getPnL({ companyId, year, month }) {
    let dateFilter = `EXTRACT(YEAR FROM transaction_date) = $2`;
    const params = [companyId, year];
    if (month) {
      dateFilter += ` AND EXTRACT(MONTH FROM transaction_date) = $3`;
      params.push(month);
    }

    const result = await query(
      `SELECT
         category,
         type,
         SUM(amount) AS total,
         EXTRACT(MONTH FROM transaction_date) AS month,
         EXTRACT(YEAR  FROM transaction_date) AS year
       FROM transactions
       WHERE company_id = $1 AND ${dateFilter} AND status != 'cancelada'
       GROUP BY category, type, EXTRACT(MONTH FROM transaction_date), EXTRACT(YEAR FROM transaction_date)
       ORDER BY month, type, category`,
      params
    );
    return result.rows;
  }

  static async getCashFlow({ companyId, months = 3 }) {
    const result = await query(
      `SELECT
         DATE_TRUNC('month', transaction_date) AS month,
         SUM(CASE WHEN type = 'ingreso' THEN amount ELSE 0 END) AS income,
         SUM(CASE WHEN type = 'egreso'  THEN amount ELSE 0 END) AS expense
       FROM transactions
       WHERE company_id = $1
         AND transaction_date >= NOW() - ($2 || ' months')::INTERVAL
         AND status != 'cancelada'
       GROUP BY DATE_TRUNC('month', transaction_date)
       ORDER BY month ASC`,
      [companyId, months * 2]  // show past + projected
    );
    return result.rows;
  }
}

module.exports = Transaction;
