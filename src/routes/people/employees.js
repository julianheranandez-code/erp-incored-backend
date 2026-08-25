'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { writeAudit } = require('../../middleware/audit');

router.use(verifyToken);

async function generateEmployeeNumber() {
  const result = await query("SELECT 'EMP-' || LPAD(nextval('employee_number_seq')::text, 6, '0') AS emp_number");
  return result.rows[0].emp_number;
}

// GET /api/people/employees?company_id=X
router.get('/', async (req, res, next) => {
  try {
    const { company_id, status, search, page = 1, limit = 20 } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let conditions = ['e.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (status) { conditions.push(`e.status = $${idx++}`); values.push(status); }
    if (search) {
      conditions.push(`(e.first_name ILIKE $${idx} OR e.last_name ILIKE $${idx} OR e.employee_number ILIKE $${idx} OR e.work_email ILIKE $${idx})`);
      values.push('%' + search + '%'); idx++;
    }
    const countResult = await query(`SELECT COUNT(*) FROM employees e WHERE ${conditions.join(' AND ')}`, values);
    const total = parseInt(countResult.rows[0].count);
    values.push(parseInt(limit), offset);
    const result = await query(`
      SELECT e.uuid, e.employee_number,
        TRIM(CONCAT(e.first_name, ' ', COALESCE(e.last_name_paternal, e.last_name, ''), ' ', COALESCE(e.last_name_maternal,''))) AS full_name,
        e.first_name, COALESCE(e.last_name_paternal, e.last_name) AS last_name,
        e.preferred_name, e.work_email, e.status AS employment_status,
        e.hire_date, e.country_code, true AS is_active,
        d.name AS department_name, pc.title AS position_title
      FROM employees e
      LEFT JOIN employee_positions ep ON ep.employee_id = e.id AND ep.is_current = true
      LEFT JOIN departments d ON d.id = ep.department_id
      LEFT JOIN position_catalog pc ON pc.id = ep.position_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.employee_number
      LIMIT $${idx++} OFFSET $${idx++}
    `, values);
    res.json({ success: true, count: result.rows.length, total,
      page: parseInt(page), total_pages: Math.ceil(total / parseInt(limit)),
      data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/people/employees/:uuid
router.get('/:uuid', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT e.uuid, e.employee_number,
        TRIM(CONCAT(e.first_name, ' ', COALESCE(e.last_name_paternal, e.last_name, ''), ' ', COALESCE(e.last_name_maternal,''))) AS full_legal_name,
        e.first_name, COALESCE(e.last_name_paternal, e.last_name) AS last_name_paternal,
        e.last_name_maternal, e.preferred_name,
        e.personal_email, e.work_email, e.personal_phone,
        e.birth_date AS date_of_birth, e.gender, e.nationality, e.country_code,
        e.address, e.city, e.state AS state_province, e.postal_code,
        e.emergency_contact_name, e.emergency_contact_phone, e.emergency_contact_relationship,
        e.hire_date, e.termination_date, e.status AS employment_status,
        e.is_active, e.created_at,
        c.name AS primary_company_name,
        ep.uuid AS position_uuid,
        pc.title AS position_title, pc.job_code,
        d.name AS department_name, cc.name AS cost_center_name,
        cr.amount AS salary, cr.currency, cr.pay_frequency, cr.salary_type,
        ct.contract_type, ct.work_modality, ct.start_date AS contract_start
      FROM employees e
      LEFT JOIN companies c ON c.id = COALESCE(e.primary_company_id, e.company_id)
      LEFT JOIN employee_positions ep ON ep.employee_id = e.id AND ep.is_current = true
      LEFT JOIN position_catalog pc ON pc.id = ep.position_id
      LEFT JOIN departments d ON d.id = ep.department_id
      LEFT JOIN cost_centers cc ON cc.id = ep.cost_center_id
      LEFT JOIN compensation_records cr ON cr.employee_id = e.id AND cr.end_date IS NULL
      LEFT JOIN employment_contracts ct ON ct.employee_id = e.id AND ct.is_current = true
      WHERE e.uuid = $1
    `, [req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    const empCompanyId = result.rows[0].company_id || result.rows[0].primary_company_id;
    if (req.user.role !== 'super_admin' && empCompanyId && !userCompanies.includes(Number(empCompanyId)))
      return res.status(403).json({ success: false, error: 'forbidden' });
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// PATCH /api/people/employees/:uuid
router.patch('/:uuid', async (req, res, next) => {
  try {
    const empResult = await query(
      'SELECT id, company_id FROM employees WHERE uuid=$1',
      [req.params.uuid]
    );
    if (!empResult.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const { id: empId, company_id } = empResult.rows[0];

    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(company_id))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const allowed = [
      'first_name','last_name_paternal','last_name','last_name_maternal','preferred_name',
      'personal_email','work_email','personal_phone',
      'address','city','state','postal_code',
      'emergency_contact_name','emergency_contact_phone','emergency_contact_relationship',
      'gender','nationality','country_code'
    ];

    const fields = [];
    const values = [];
    let idx = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${idx++}`);
        values.push(req.body[key]);
      }
    }
    if (!fields.length)
      return res.status(400).json({ success: false, error: 'no_updatable_fields' });

    values.push(empId);
    const oldResult = await query('SELECT * FROM employees WHERE id=$1', [empId]);
    const oldValues = oldResult.rows[0];

    await query(
      `UPDATE employees SET ${fields.join(', ')} WHERE id=$${idx}`,
      values
    );

    writeAudit({
      userId: req.user.id, action: 'employee_updated',
      entityType: 'employees', entityId: req.params.uuid,
      companyId: company_id, oldValues, newValues: req.body,
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    const updated = await query(
      'SELECT uuid, first_name, last_name_paternal, work_email, status FROM employees WHERE id=$1',
      [empId]
    );
    res.json({ success: true, data: updated.rows[0], message: 'Employee updated.' });
  } catch(e) { next(e); }
});

// POST /api/people/employees
router.post('/', async (req, res, next) => {
  try {
    const {
      company_id,
      first_name, last_name_paternal, last_name, last_name_maternal,
      preferred_name, personal_email, work_email, personal_phone,
      date_of_birth, gender, nationality, country_code = 'MX',
      address, city, state, postal_code,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
      hire_date, contract, compensation
    } = req.body;

    const companyId = parseInt(primary_company_id || company_id);
    if (!companyId || !first_name || !hire_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, first_name, hire_date' });

    const empNumber = await generateEmployeeNumber();
    let empId, empUuid;

    await withTransaction(async (client) => {
      const empResult = await client.query(`
        INSERT INTO employees (
          employee_number, company_id,
          first_name, last_name_paternal, last_name, last_name_maternal,
          preferred_name, personal_email, work_email, personal_phone,
          birth_date, gender, nationality, country_code,
          address, city, state, postal_code,
          emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
          hire_date, status, salary_period, vacation_days, vacation_taken, created_by
        ) VALUES ($1,$2,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'probation','mensual',0,0,$22)
        RETURNING id, uuid, employee_number
      `, [empNumber, companyId,
          first_name, last_name_paternal || last_name || null,
          last_name_maternal || null, preferred_name || null,
          personal_email || null, work_email || null, personal_phone || null,
          date_of_birth || null, gender || null, nationality || null, country_code,
          address || null, city || null, state || null, postal_code || null,
          emergency_contact_name || null, emergency_contact_phone || null,
          emergency_contact_relationship || null, hire_date, req.user.id]);

      empId = empResult.rows[0].id;
      empUuid = empResult.rows[0].uuid;

      await client.query(`
        INSERT INTO employee_company_assignments
          (employee_id, company_id, assignment_type, start_date, is_active)
        VALUES ($1,$2,'operational',$3,true)
      `, [empId, companyId, hire_date]);

      if (contract) {
        await client.query(`
          INSERT INTO employment_contracts
            (employee_id, company_id, contract_type, employment_regime,
             flsa_classification, work_modality, start_date, end_date, version_number, is_current, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,true,$9)
        `, [empId, companyId, contract.contract_type, contract.employment_regime || null,
            contract.flsa_classification || null, contract.work_modality || 'field',
            hire_date, contract.end_date || null, req.user.id]);
      }

      if (compensation) {
        await client.query(`
          INSERT INTO compensation_records
            (employee_id, company_id, amount, currency, salary_type, pay_frequency, effective_date, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [empId, companyId, parseFloat(compensation.amount),
            compensation.currency || 'MXN', compensation.salary_type || 'monthly',
            compensation.pay_frequency || 'biweekly', hire_date, req.user.id]);
      }

      await client.query(`
        INSERT INTO employment_events
          (employee_id, company_id, event_type, event_date, title, source, actor_id)
        VALUES ($1,$2,'hire',$3,'Employee hired','system',$4)
      `, [empId, companyId, hire_date, req.user.id]);
    });

    writeAudit({ userId: req.user.id, action: 'employee_created',
      entityType: 'employees', entityId: empUuid,
      companyId, newValues: { employee_number: empNumber, first_name },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(() => {});

    res.status(201).json({ success: true,
      data: { uuid: empUuid, employee_number: empNumber, first_name },
      message: `Employee ${empNumber} created successfully.` });
  } catch(e) { next(e); }
});

// GET /api/people/employees/:uuid/events
router.get('/:uuid/events', async (req, res, next) => {
  try {
    const emp = await query('SELECT id FROM employees WHERE uuid=$1', [req.params.uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT ee.uuid, ee.event_type, ee.event_date, ee.title,
        ee.description, ee.metadata, ee.source, ee.created_at,
        CONCAT(u.first_name,' ',u.last_name) AS actor_name
      FROM employment_events ee
      LEFT JOIN users u ON u.id = ee.actor_id
      WHERE ee.employee_id = $1
      ORDER BY ee.event_date DESC, ee.created_at DESC
    `, [emp.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/people/employees/:uuid/skills
router.get('/:uuid/skills', async (req, res, next) => {
  try {
    const emp = await query('SELECT id FROM employees WHERE uuid=$1', [req.params.uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const { skill_category, status } = req.query;
    let conditions = ['es.employee_id = $1'];
    let values = [emp.rows[0].id];
    let idx = 2;
    if (skill_category) { conditions.push(`sc.skill_category = $${idx++}`); values.push(skill_category); }
    if (status) { conditions.push(`es.status = $${idx++}`); values.push(status); }
    const result = await query(`
      SELECT es.uuid, sc.skill_code, sc.name, sc.name_en, sc.skill_category,
        es.proficiency, es.acquired_date, es.certified_by,
        es.expiry_date, es.status, es.notes, es.created_at
      FROM employee_skills es
      JOIN skills_catalog sc ON sc.id = es.skill_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY sc.skill_category, sc.name
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/people/employees/:uuid/compensation
router.get('/:uuid/compensation', async (req, res, next) => {
  try {
    const emp = await query('SELECT id FROM employees WHERE uuid=$1', [req.params.uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT uuid, amount, currency, salary_type, pay_frequency,
        effective_date, end_date, reason, notes, created_at
      FROM compensation_records
      WHERE employee_id = $1
      ORDER BY effective_date DESC
    `, [emp.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/people/employees/:uuid/contracts
router.get('/:uuid/contracts', async (req, res, next) => {
  try {
    const emp = await query('SELECT id FROM employees WHERE uuid=$1', [req.params.uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT uuid, contract_type, employment_regime, flsa_classification,
        work_modality, start_date, end_date, probation_end_date,
        version_number, is_current, notes, created_at
      FROM employment_contracts
      WHERE employee_id = $1
      ORDER BY version_number DESC
    `, [emp.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/people/employees/:uuid/contracts — create new contract version
router.post('/:uuid/contracts', async (req, res, next) => {
  try {
    const empResult = await query('SELECT id, company_id FROM employees WHERE uuid=$1', [req.params.uuid]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const { id: empId, company_id } = empResult.rows[0];

    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(company_id))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const { contract_type, employment_regime, flsa_classification,
            work_modality, start_date, end_date, probation_end_date, notes } = req.body;
    if (!contract_type || !employment_regime || !start_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: contract_type, employment_regime, start_date' });

    let newContractData;
    await withTransaction(async (client) => {
      const ver = await client.query(
        'SELECT COALESCE(MAX(version_number),0) AS max_ver FROM employment_contracts WHERE employee_id=$1',
        [empId]
      );
      const newVersion = parseInt(ver.rows[0].max_ver) + 1;

      const prev = await client.query(
        'SELECT id FROM employment_contracts WHERE employee_id=$1 AND is_current=true',
        [empId]
      );

      const newContract = await client.query(`
        INSERT INTO employment_contracts
          (employee_id, company_id, contract_type, employment_regime,
           flsa_classification, work_modality, start_date, end_date,
           probation_end_date, version_number, is_current, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11)
        RETURNING id, uuid, version_number
      `, [empId, company_id, contract_type, employment_regime,
          flsa_classification||null, work_modality||'field',
          start_date, end_date||null, probation_end_date||null,
          newVersion, req.user.id]);
      newContractData = newContract.rows[0];

      if (prev.rows[0]) {
        await client.query(`
          UPDATE employment_contracts SET is_current=false, superseded_by_id=$1
          WHERE id=$2
        `, [newContractData.id, prev.rows[0].id]);
      }

      await client.query(`
        INSERT INTO employment_events
          (employee_id, company_id, event_type, event_date, title, source, actor_id)
        VALUES ($1,$2,'contract_change',$3,$4,'system',$5)
      `, [empId, company_id, start_date,
          'Contract v' + newVersion + ': ' + contract_type + ' / ' + employment_regime,
          req.user.id]);
    });

    writeAudit({ userId: req.user.id, action: 'contract_created',
      entityType: 'employment_contracts', entityId: req.params.uuid,
      companyId: company_id,
      newValues: { contract_type, employment_regime, start_date, version: newContractData?.version_number },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    const updated = await query(
      'SELECT uuid, contract_type, employment_regime, flsa_classification, version_number, is_current FROM employment_contracts WHERE employee_id=$1 AND is_current=true',
      [empId]
    );
    res.status(201).json({ success: true, message: 'Contract version created.', data: updated.rows[0] });
  } catch(e) { next(e); }
});

// POST /api/people/employees/:uuid/terminate — terminate employee
router.post('/:uuid/terminate', async (req, res, next) => {
  try {
    const empResult = await query('SELECT id, company_id, status FROM employees WHERE uuid=$1', [req.params.uuid]);
    if (!empResult.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const { id: empId, company_id } = empResult.rows[0];

    if (empResult.rows[0].status === 'terminated')
      return res.status(400).json({ success: false, error: 'already_terminated' });

    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(company_id))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const { termination_date, termination_reason, notes } = req.body;
    if (!termination_date || !termination_reason)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: termination_date, termination_reason' });

    await withTransaction(async (client) => {
      await client.query(`
        UPDATE employees SET status='terminated', termination_date=$1, updated_at=NOW()
        WHERE id=$2
      `, [termination_date, empId]);

      await client.query(`
        UPDATE employment_contracts SET is_current=false, end_date=$1
        WHERE employee_id=$2 AND is_current=true AND (end_date IS NULL OR end_date > $1)
      `, [termination_date, empId]);

      await client.query(`
        UPDATE compensation_records SET end_date=$1
        WHERE employee_id=$2 AND end_date IS NULL
      `, [termination_date, empId]);

      await client.query(`
        INSERT INTO employment_events
          (employee_id, company_id, event_type, event_date, title, description, source, actor_id)
        VALUES ($1,$2,'termination',$3,'Employee Terminated',$4,'system',$5)
      `, [empId, company_id, termination_date,
          termination_reason + (notes ? ': ' + notes : ''), req.user.id]);
    });

    writeAudit({ userId: req.user.id, action: 'employee_terminated',
      entityType: 'employees', entityId: req.params.uuid,
      companyId: company_id,
      newValues: { termination_date, termination_reason },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});

    res.json({ success: true, message: 'Employee terminated.',
      data: { uuid: req.params.uuid, termination_date, status: 'terminated' }});
  } catch(e) { next(e); }
});

module.exports = router;
