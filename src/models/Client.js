'use strict';

const { query } = require('../config/database');

class Client {
  static async findAll({ type, search, page = 1, limit = 20 }) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (type) { conditions.push(`type = $${idx++}`); params.push(type); }
    if (search) {
      conditions.push(`(name ILIKE $${idx} OR rfc ILIKE $${idx} OR primary_contact_email ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    conditions.push(`status != 'deleted'`);

    const where = `WHERE ${conditions.join(' AND ')}`;
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT * FROM clients ${where} ORDER BY name ASC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) AS total FROM clients ${where}`, params),
    ]);
    return { data: rows.rows, total: parseInt(countResult.rows[0].total) };
  }

  static async findById(id) {
    const result = await query(`SELECT * FROM clients WHERE id = $1`, [id]);
    return result.rows[0] || null;
  }

  static async create(data) {
    const {
      name, type, rfc, country, state, city, address, industry, website,
      primary_contact_name, primary_contact_email, primary_contact_phone,
      credit_limit, payment_terms, credit_rating, notes,
    } = data;
    const result = await query(
      `INSERT INTO clients
         (name, type, rfc, country, state, city, address, industry, website,
          primary_contact_name, primary_contact_email, primary_contact_phone,
          credit_limit, payment_terms, credit_rating, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [name, type || 'cliente', rfc || null, country || null, state || null, city || null,
       address || null, industry || null, website || null,
       primary_contact_name || null, primary_contact_email || null, primary_contact_phone || null,
       credit_limit || null, payment_terms || null, credit_rating || null, notes || null]
    );
    return result.rows[0];
  }

  static async update(id, data) {
    const allowed = [
      'name', 'type', 'rfc', 'country', 'state', 'city', 'address', 'industry', 'website',
      'primary_contact_name', 'primary_contact_email', 'primary_contact_phone',
      'credit_limit', 'payment_terms', 'credit_rating', 'notes',
    ];
    const fields = [];
    const params = [];
    let idx = 1;
    for (const key of allowed) {
      if (key in data) { fields.push(`${key} = $${idx++}`); params.push(data[key]); }
    }
    if (!fields.length) return null;
    params.push(id);
    const result = await query(
      `UPDATE clients SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }
}

module.exports = Client;
