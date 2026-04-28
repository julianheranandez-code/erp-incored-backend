'use strict';

const { query, withTransaction } = require('../config/database');
const { calculateTotals } = require('../utils/helpers');

class Quote {
  static async findAll({ companyId, clientId, status, search, page = 1, limit = 20 }) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (companyId) { conditions.push(`q.company_id = $${idx++}`); params.push(companyId); }
    if (clientId) { conditions.push(`q.client_id = $${idx++}`); params.push(clientId); }
    if (status) { conditions.push(`q.status = $${idx++}`); params.push(status); }
    if (search) {
      conditions.push(`(q.folio ILIKE $${idx} OR c.name ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT q.id, q.folio, q.status, q.issue_date, q.validity_days,
                q.subtotal, q.total, q.currency, q.sent_at, q.accepted_at, q.created_at,
                c.name AS client_name, co.name AS company_name, u.name AS creator_name
         FROM quotes q
         LEFT JOIN clients c ON c.id = q.client_id
         LEFT JOIN companies co ON co.id = q.company_id
         LEFT JOIN users u ON u.id = q.created_by
         ${where} ORDER BY q.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) AS total FROM quotes q LEFT JOIN clients c ON c.id = q.client_id ${where}`, params),
    ]);
    return { data: rows.rows, total: parseInt(countResult.rows[0].total) };
  }

  static async findById(id) {
    const [quoteResult, linesResult] = await Promise.all([
      query(
        `SELECT q.*, c.name AS client_name, c.rfc AS client_rfc,
                c.primary_contact_name AS client_contact, c.primary_contact_email AS client_email,
                co.name AS company_name, u.name AS creator_name
         FROM quotes q
         LEFT JOIN clients c ON c.id = q.client_id
         LEFT JOIN companies co ON co.id = q.company_id
         LEFT JOIN users u ON u.id = q.created_by
         WHERE q.id = $1`,
        [id]
      ),
      query(`SELECT * FROM quote_lines WHERE quote_id = $1 ORDER BY line_order`, [id]),
    ]);
    if (!quoteResult.rows[0]) return null;
    return { ...quoteResult.rows[0], lines: linesResult.rows };
  }

  static async create(data, createdBy) {
    return withTransaction(async (client) => {
      const totals = calculateTotals(data.lines, data.tax_percent || 16);

      const quoteResult = await client.query(
        `INSERT INTO quotes
           (folio, client_id, company_id, project_id, lead_id, created_by,
            issue_date, validity_days, subtotal, tax_percent, tax_amount, total,
            currency, terms_conditions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          data.folio, data.client_id, data.company_id, data.project_id || null,
          data.lead_id || null, createdBy, data.issue_date, data.validity_days || 30,
          totals.subtotal, data.tax_percent || 16, totals.tax, totals.total,
          data.currency || 'MXN', data.terms_conditions || null,
        ]
      );

      const quote = quoteResult.rows[0];

      // Insert lines
      for (let i = 0; i < data.lines.length; i++) {
        const line = data.lines[i];
        const lineTotal = line.quantity * line.unit_price * (1 - (line.discount_percent || 0) / 100);
        await client.query(
          `INSERT INTO quote_lines
             (quote_id, description, quantity, unit, unit_price, discount_percent, line_total, line_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [quote.id, line.description, line.quantity, line.unit || null,
           line.unit_price, line.discount_percent || 0,
           Math.round(lineTotal * 100) / 100, line.line_order || i + 1]
        );
      }

      return quote;
    });
  }

  static async updateStatus(id, status) {
    const now = new Date();
    const updates = { status };
    if (status === 'enviada') updates.sent_at = now;
    if (status === 'aceptada') updates.accepted_at = now;
    if (status === 'rechazada') updates.rejected_at = now;

    const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`);
    const values = Object.values(updates);
    values.push(id);

    const result = await query(
      `UPDATE quotes SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  static async getNextFolio(companyCode) {
    const year = new Date().getFullYear();
    const result = await query(
      `SELECT COUNT(*) AS count FROM quotes q
       JOIN companies c ON c.id = q.company_id
       WHERE c.short_code = $1 AND EXTRACT(YEAR FROM q.created_at) = $2`,
      [companyCode, year]
    );
    const count = parseInt(result.rows[0].count);
    return `${companyCode}-${year}-${String(count + 1).padStart(3, '0')}`;
  }
}

module.exports = Quote;
