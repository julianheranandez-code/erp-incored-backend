'use strict';

const { query } = require('../config/database');

class Client {
  static async findAll({ type, search, page = 1, limit = 20 }) {
    const conditions = [];
    const params = [];
    let idx = 1;

    conditions.push(`is_active = true`);

    if (type) { conditions.push(`type = $${idx++}`); params.push(type); }
    if (search) {
      conditions.push(`(name ILIKE $${idx} OR rfc ILIKE $${idx} OR primary_contact_email ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

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
      company_id, name, type = 'cliente', rfc, country, state, city, address,
      industry, website, primary_contact_name, primary_contact_email,
      primary_contact_phone, credit_limit, payment_terms, credit_rating, notes
    } = data;

    const result = await query(
      `INSERT INTO clients
        (company_id, name, type, rfc, country, state, city, address, industry, website,
         primary_contact_name, primary_contact_email, primary_contact_phone,
         credit_limit, payment_terms, credit_rating, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [company_id || null, name, type, rfc || null, country || null, state || null,
       city || null, address || null, industry || null, website || null,
       primary_contact_name || null, primary_contact_email || null,
       primary_contact_phone || null, credit_limit || null,
       payment_terms || null, credit_rating || null, notes || null]
    );
    return result.rows[0];
  }

  static async update(id, data) {
    const existing = await this.findById(id);
    if (!existing) return null;

    const updated = { ...existing, ...data };
    const result = await query(
      `UPDATE clients SET
        name = $1, type = $2, rfc = $3, country = $4, state = $5, city = $6,
        address = $7, industry = $8, website = $9, primary_contact_name = $10,
        primary_contact_email = $11, primary_contact_phone = $12,
        credit_limit = $13, payment_terms = $14, credit_rating = $15,
        notes = $16, is_active = $17, updated_at = NOW()
       WHERE id = $18 RETURNING *`,
      [updated.name, updated.type, updated.rfc, updated.country, updated.state,
       updated.city, updated.address, updated.industry, updated.website,
       updated.primary_contact_name, updated.primary_contact_email,
       updated.primary_contact_phone, updated.credit_limit, updated.payment_terms,
       updated.credit_rating, updated.notes, updated.is_active !== false, id]
    );
    return result.rows[0];
  }
}

module.exports = Client;
