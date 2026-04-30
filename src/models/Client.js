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
      company_id, name, type = 'cliente', rfc, country, state, city,
      address, address_street, address_colonia, address_zip,
      industry, website,
      primary_contact_name, primary_contact_email,
      primary_contact_phone, primary_contact_position,
      credit_limit, payment_terms, credit_rating,
      attachment_url, notes
    } = data;

    const result = await query(
      `INSERT INTO clients
        (company_id, name, type, rfc, country, state, city, address,
         address_street, address_colonia, address_zip,
         industry, website,
         primary_contact_name, primary_contact_email,
         primary_contact_phone, primary_contact_position,
         credit_limit, payment_terms, credit_rating,
         attachment_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [
        company_id || null, name, type, rfc || null,
        country || null, state || null, city || null, address || null,
        address_street || null, address_colonia || null, address_zip || null,
        industry || null, website || null,
        primary_contact_name || null, primary_contact_email || null,
        primary_contact_phone || null, primary_contact_position || null,
        credit_limit || null, payment_terms || null, credit_rating || null,
        attachment_url || null, notes || null
      ]
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
        address = $7, address_street = $8, address_colonia = $9, address_zip = $10,
        industry = $11, website = $12,
        primary_contact_name = $13, primary_contact_email = $14,
        primary_contact_phone = $15, primary_contact_position = $16,
        credit_limit = $17, payment_terms = $18, credit_rating = $19,
        attachment_url = $20, notes = $21, is_active = $22,
        updated_at = NOW()
       WHERE id = $23 RETURNING *`,
      [
        updated.name, updated.type, updated.rfc,
        updated.country, updated.state, updated.city,
        updated.address, updated.address_street, updated.address_colonia, updated.address_zip,
        updated.industry, updated.website,
        updated.primary_contact_name, updated.primary_contact_email,
        updated.primary_contact_phone, updated.primary_contact_position,
        updated.credit_limit, updated.payment_terms, updated.credit_rating,
        updated.attachment_url, updated.notes,
        updated.is_active !== false, id
      ]
    );
    return result.rows[0];
  }
}

module.exports = Client;
