'use strict';

const { query, withTransaction } = require('../config/database');

class Employee {
  static async findAll({ companyId, status, department, search, page = 1, limit = 20 }) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (companyId) { conditions.push(`e.company_id = $${idx++}`); params.push(companyId); }
    if (status) { conditions.push(`e.status = $${idx++}`); params.push(status); }
    if (department) { conditions.push(`e.department = $${idx++}`); params.push(department); }
    if (search) {
      conditions.push(`(e.name ILIKE $${idx} OR e.email ILIKE $${idx} OR e.position ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT e.id, e.employee_number, e.name, e.email, e.phone, e.company_id,
                e.position, e.department, e.hire_date, e.status, e.salary_base,
                e.salary_period, e.vacation_days, e.vacation_taken,
                e.created_at, co.name AS company_name,
                sup.name AS supervisor_name
         FROM employees e
         LEFT JOIN companies co ON co.id = e.company_id
         LEFT JOIN employees sup ON sup.id = e.supervisor_id
         ${where} ORDER BY e.name ASC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) AS total FROM employees e ${where}`, params),
    ]);
    return { data: rows.rows, total: parseInt(countResult.rows[0].total) };
  }

  static async findById(id) {
    const result = await query(
      `SELECT e.*, co.name AS company_name, sup.name AS supervisor_name
       FROM employees e
       LEFT JOIN companies co ON co.id = e.company_id
       LEFT JOIN employees sup ON sup.id = e.supervisor_id
       WHERE e.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  static async create(data) {
    const result = await query(
      `INSERT INTO employees
         (name, email, phone, company_id, position, department, supervisor_id,
          salary_base, salary_period, hire_date, skills, certifications,
          emergency_contact_name, emergency_contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        data.name, data.email || null, data.phone || null,
        data.company_id, data.position || null, data.department || null,
        data.supervisor_id || null, data.salary_base || null,
        data.salary_period || 'mensual', data.hire_date || null,
        data.skills ? JSON.stringify(data.skills) : null,
        data.certifications ? JSON.stringify(data.certifications) : null,
        data.emergency_contact_name || null, data.emergency_contact_phone || null,
      ]
    );
    return result.rows[0];
  }

  static async update(id, data) {
    const allowed = [
      'name', 'email', 'phone', 'position', 'department', 'supervisor_id',
      'salary_base', 'salary_period', 'status', 'skills', 'certifications',
      'emergency_contact_name', 'emergency_contact_phone', 'notes',
    ];
    const fields = [];
    const params = [];
    let idx = 1;
    for (const key of allowed) {
      if (key in data) {
        fields.push(`${key} = $${idx++}`);
        params.push(
          (key === 'skills' || key === 'certifications') && Array.isArray(data[key])
            ? JSON.stringify(data[key])
            : data[key]
        );
      }
    }
    if (!fields.length) return null;
    params.push(id);
    const result = await query(
      `UPDATE employees SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  static async getContracts(employeeId) {
    const result = await query(
      `SELECT * FROM employee_contracts WHERE employee_id = $1 ORDER BY start_date DESC`,
      [employeeId]
    );
    return result.rows;
  }

  static async createContract(employeeId, data) {
    const result = await query(
      `INSERT INTO employee_contracts
         (employee_id, contract_type, start_date, end_date, salary, currency, signed_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        employeeId, data.contract_type, data.start_date,
        data.end_date || null, data.salary, data.currency || 'MXN',
        data.signed_at || null, data.notes || null,
      ]
    );
    return result.rows[0];
  }

  static async getVacationRequests({ employeeId, status, companyId, page = 1, limit = 20 }) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (employeeId) { conditions.push(`vr.employee_id = $${idx++}`); params.push(employeeId); }
    if (status) { conditions.push(`vr.status = $${idx++}`); params.push(status); }
    if (companyId) {
      conditions.push(`e.company_id = $${idx++}`);
      params.push(companyId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const result = await query(
      `SELECT vr.*, e.name AS employee_name, u.name AS approved_by_name
       FROM vacation_requests vr
       JOIN employees e ON e.id = vr.employee_id
       LEFT JOIN users u ON u.id = vr.approved_by
       ${where}
       ORDER BY vr.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );
    return result.rows;
  }

  static async requestVacation(employeeId, data) {
    const daysCount = Math.round((new Date(data.end_date) - new Date(data.start_date)) / 86400000) + 1;
    const result = await query(
      `INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count, reason)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [employeeId, data.start_date, data.end_date, daysCount, data.reason || null]
    );
    return result.rows[0];
  }

  static async updateVacationRequest(id, { status, approved_by, rejection_reason }) {
    const result = await query(
      `UPDATE vacation_requests
       SET status = $1, approved_by = $2, rejection_reason = $3,
           approved_at = CASE WHEN $1 IN ('aprobada','rechazada') THEN NOW() ELSE NULL END
       WHERE id = $4 RETURNING *`,
      [status, approved_by || null, rejection_reason || null, id]
    );

    // Deduct vacation days from employee if approved
    if (status === 'aprobada' && result.rows[0]) {
      await query(
        `UPDATE employees SET vacation_taken = vacation_taken + $1 WHERE id = $2`,
        [result.rows[0].days_count, result.rows[0].employee_id]
      );
    }

    return result.rows[0] || null;
  }
}

module.exports = Employee;
