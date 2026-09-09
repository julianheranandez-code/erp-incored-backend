'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/rbac');
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
router.get('/:uuid/compensation', requirePermission('workforce.view_sensitive'), async (req, res, next) => {
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

// GET /api/people/employees/:uuid/documents
// Permission: workforce.view — reads document_attachments using document_type='employee' convention
// Phase 3E-4 — additive, no schema changes
router.get('/:uuid/documents', async (req, res, next) => {
  try {
    const empBase = await query(
      'SELECT id, company_id FROM employees WHERE uuid = $1', [req.params.uuid]);
    if (!empBase.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const { id: empId, company_id: empCompanyId } = empBase.rows[0];

    const userCompanies = Array.isArray(req.user.company_access)
      ? req.user.company_access.map(Number)
      : [Number(req.user.company_id)];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(Number(empCompanyId)))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const result = await query(`
      SELECT
        da.id, da.document_type, da.document_category,
        da.original_filename AS file_name,
        da.storage_path AS file_path,
        da.mime_type, da.file_size,
        da.notes AS description,
        da.is_sensitive, da.sensitivity_level,
        da.is_verified, da.verified_at,
        da.expiration_date, da.uploaded_at,
        CONCAT(u.first_name,' ',COALESCE(u.last_name,'')) AS uploaded_by_name
      FROM document_attachments da
      LEFT JOIN users u ON u.id = da.uploaded_by
      WHERE da.document_type = 'employee'
        AND da.document_id = $1
        AND da.company_id = $2
        AND da.is_deleted = false
      ORDER BY da.uploaded_at DESC
      LIMIT 50
    `, [empId, empCompanyId]);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// GET /api/people/employees/:uuid/compliance
// Permission: workforce.compliance — employee-scoped compliance records
// Phase 3E-4 — additive, no schema changes
router.get('/:uuid/compliance', requirePermission('workforce.compliance'), async (req, res, next) => {
  try {
    const empBase = await query(
      'SELECT id, company_id FROM employees WHERE uuid = $1', [req.params.uuid]);
    if (!empBase.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const { id: empId, company_id: empCompanyId } = empBase.rows[0];

    const userCompanies = Array.isArray(req.user.company_access)
      ? req.user.company_access.map(Number)
      : [Number(req.user.company_id)];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(Number(empCompanyId)))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const result = await query(`
      SELECT
        ecr.id, ecr.uuid, ecr.status, ecr.due_date,
        ecr.completed_date, ecr.expiry_date, ecr.notes,
        ecr.record_source, ecr.created_at, ecr.updated_at,
        cr.requirement_code, cr.name AS requirement_name,
        cr.category, cr.frequency, cr.is_active,
        cr.country_code, cr.alert_days
      FROM employee_compliance_records ecr
      JOIN compliance_requirements cr ON cr.id = ecr.requirement_id
      WHERE ecr.employee_id = $1
        AND ecr.company_id = $2
      ORDER BY ecr.due_date ASC NULLS LAST
      LIMIT 100
    `, [empId, empCompanyId]);

    const rows = result.rows || [];
    const summary = {
      total:          rows.length,
      completed:      rows.filter(r => r.status === 'completed').length,
      pending:        rows.filter(r => r.status === 'pending').length,
      overdue:        rows.filter(r => r.status === 'overdue').length,
      not_applicable: rows.filter(r => r.status === 'not_applicable').length
    };

    res.json({ success: true, count: rows.length, summary, data: rows });
  } catch(e) { next(e); }
});

// GET /api/people/employees/:uuid/payroll-summary
// Permission: workforce.view_sensitive — thin wrapper, no deduction/tax detail
// Phase 3E-3 — summary only, certified payroll engine not touched
router.get('/:uuid/payroll-summary', requirePermission('workforce.view_sensitive'), async (req, res, next) => {
  try {
    // Step 1: Resolve employee
    const empBase = await query(
      'SELECT id, company_id FROM employees WHERE uuid = $1',
      [req.params.uuid]
    );
    if (!empBase.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const { id: empId, company_id: empCompanyId } = empBase.rows[0];

    // Step 2: Company isolation
    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(Number(empCompanyId)))
      return res.status(403).json({ success: false, error: 'forbidden' });

    // Step 3: Payroll summary — last approved run + aggregate counts
    // NO deductions detail, NO employer burden, NO tax breakdown
    const summaryResult = await query(`
      SELECT
        pr.uuid AS payroll_run_uuid,
        pr.run_number,
        pp.start_date AS period_start,
        pp.end_date AS period_end,
        pr.status AS run_status,
        pe.gross_pay AS last_gross,
        pe.net_pay AS last_net,
        pe.currency,
        pe.employment_regime,
        (SELECT COUNT(DISTINCT pr2.id)
         FROM payroll_entries pe2
         JOIN payroll_runs pr2 ON pr2.id = pe2.payroll_run_id
         WHERE pe2.employee_id = $1
           AND pr2.status = 'approved') AS approved_runs_count
      FROM payroll_entries pe
      JOIN payroll_runs pr ON pr.id = pe.payroll_run_id
      JOIN payroll_periods pp ON pp.id = pr.payroll_period_id
      WHERE pe.employee_id = $1
        AND pr.status = 'approved'
      ORDER BY pp.end_date DESC
      LIMIT 1
    `, [empId]);

    if (!summaryResult.rows[0]) {
      return res.json({ success: true, data: {
        has_payroll_history: false,
        last_period: null,
        last_gross: null,
        last_net: null,
        currency: null,
        employment_regime: null,
        approved_runs_count: 0
      }});
    }

    const s = summaryResult.rows[0];

    // Explicit DTO — NO deductions, NO employer burden, NO tax fields
    res.json({ success: true, data: {
      has_payroll_history: true,
      last_period: {
        payroll_run_uuid: s.payroll_run_uuid,
        run_number:       s.run_number,
        period_start:     s.period_start,
        period_end:       s.period_end,
        run_status:       s.run_status
      },
      last_gross:           parseFloat(s.last_gross || 0),
      last_net:             parseFloat(s.last_net   || 0),
      currency:             s.currency,
      employment_regime:    s.employment_regime,
      approved_runs_count:  parseInt(s.approved_runs_count || 0)
    }});
  } catch(e) { next(e); }
});

// GET /api/people/employees/:uuid/timeline
// Permission: workforce.view — unified chronological event stream
// Combines: employment_events + safe domain projections (no financial values)
// Phase 3E-5 — additive only, no schema changes, no sensitive data
router.get('/:uuid/timeline', async (req, res, next) => {
  try {
    // Step 1: Resolve employee
    const empBase = await query(
      'SELECT id, company_id FROM employees WHERE uuid = $1', [req.params.uuid]);
    if (!empBase.rows[0])
      return res.status(404).json({ success: false, error: 'not_found' });

    const { id: empId, company_id: empCompanyId } = empBase.rows[0];

    // Step 2: Company isolation
    const userCompanies = Array.isArray(req.user.company_access)
      ? req.user.company_access.map(Number)
      : [Number(req.user.company_id)];
    if (req.user.role !== 'super_admin' && !userCompanies.includes(Number(empCompanyId)))
      return res.status(403).json({ success: false, error: 'forbidden' });

    // Pagination
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    // Step 3: Parallel bounded queries — NO financial values
    const [
      empEventsResult,
      contractEventsResult,
      leaveEventsResult,
      compensationEventsResult
    ] = await Promise.all([

      // Source 1: employment_events (primary — hire, contract_change, termination)
      query(`
        SELECT
          'employment_event'    AS timeline_source,
          ee.uuid               AS source_uuid,
          ee.event_type         AS event_type,
          ee.event_date         AS event_date,
          ee.title              AS title,
          ee.description        AS description,
          ee.source             AS origin,
          ee.created_at         AS created_at,
          CONCAT(u.first_name,' ',COALESCE(u.last_name,'')) AS actor_name
        FROM employment_events ee
        LEFT JOIN users u ON u.id = ee.actor_id
        WHERE ee.employee_id = $1
          AND ee.company_id = $2
      `, [empId, empCompanyId]),

      // Source 2: employment_contracts — version changes (operational, not financial)
      query(`
        SELECT
          'contract_version'    AS timeline_source,
          ec.uuid               AS source_uuid,
          'contract_version'    AS event_type,
          ec.start_date         AS event_date,
          CONCAT('Contract v', ec.version_number, ': ', ec.contract_type,
            CASE WHEN ec.employment_regime IS NOT NULL
              THEN ' / ' || ec.employment_regime ELSE '' END) AS title,
          ec.work_modality      AS description,
          'contracts'           AS origin,
          ec.created_at         AS created_at,
          NULL                  AS actor_name
        FROM employment_contracts ec
        WHERE ec.employee_id = $1
        ORDER BY ec.version_number DESC
      `, [empId]),

      // Source 3: leave_requests — approved/rejected only (safe)
      query(`
        SELECT
          'leave_request'       AS timeline_source,
          lr.uuid               AS source_uuid,
          CASE lr.status
            WHEN 'approved' THEN 'leave_approved'
            WHEN 'rejected' THEN 'leave_rejected'
            WHEN 'cancelled' THEN 'leave_cancelled'
            ELSE 'leave_' || lr.status
          END                   AS event_type,
          lr.start_date         AS event_date,
          CONCAT(lt.name, ': ', lr.start_date::text,
            CASE WHEN lr.end_date != lr.start_date
              THEN ' → ' || lr.end_date::text ELSE '' END) AS title,
          lr.reason             AS description,
          'leave'               AS origin,
          lr.updated_at         AS created_at,
          NULL                  AS actor_name
        FROM leave_requests lr
        LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
        WHERE lr.employee_id = $1
          AND lr.company_id = $2
          AND lr.status IN ('approved','rejected','cancelled')
        ORDER BY lr.start_date DESC
        LIMIT 20
      `, [empId, empCompanyId]),

      // Source 4: compensation_records — effective date only (NO amount)
      query(`
        SELECT
          'compensation_change' AS timeline_source,
          cr.uuid               AS source_uuid,
          'compensation_change' AS event_type,
          cr.effective_date     AS event_date,
          CONCAT('Compensation update: ', cr.salary_type, ' / ', cr.pay_frequency) AS title,
          cr.reason             AS description,
          'compensation'        AS origin,
          cr.created_at         AS created_at,
          NULL                  AS actor_name
        FROM compensation_records cr
        WHERE cr.employee_id = $1
          AND cr.company_id = $2
        ORDER BY cr.effective_date DESC
        LIMIT 10
      `, [empId, empCompanyId])
    ]);

    // Step 4: Merge and sort all events chronologically
    const allEvents = [
      ...empEventsResult.rows,
      ...contractEventsResult.rows,
      ...leaveEventsResult.rows,
      ...compensationEventsResult.rows
    ];

    // Sort descending by event_date, then created_at
    allEvents.sort((a, b) => {
      const dateA = new Date(a.event_date || a.created_at);
      const dateB = new Date(b.event_date || b.created_at);
      if (dateB - dateA !== 0) return dateB - dateA;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    // Apply pagination
    const total = allEvents.length;
    const paginated = allEvents.slice(offset, offset + limit);

    // Step 5: Safety check — no sensitive fields
    const FORBIDDEN = ['amount','gross','net','salary_amount','deduction','burden','tax','curp','rfc'];
    const safe = paginated.map(ev => {
      const cleaned = { ...ev };
      FORBIDDEN.forEach(f => { if (f in cleaned) delete cleaned[f]; });
      return cleaned;
    });

    res.json({
      success: true,
      count: safe.length,
      total,
      pagination: { limit, offset, has_more: offset + limit < total },
      data: safe
    });
  } catch(e) { next(e); }
});

// GET /api/people/employees/:uuid/360 — Employee 360 Safe Overview Shell
// Permission: workforce.view (NO sensitive compensation/payroll data)
// Phase 3E-1 — Additive only, no schema changes
router.get('/:uuid/360', async (req, res, next) => {
  try {
    // Step 1: Resolve employee by UUID — authoritative company_id
    const empBase = await query(
      'SELECT id, company_id, uuid FROM employees WHERE uuid = $1',
      [req.params.uuid]
    );
    if (!empBase.rows[0])
      return res.status(404).json({ success: false, error: 'not_found',
        message: 'Employee not found.' });

    const { id: empId, company_id: empCompanyId } = empBase.rows[0];

    // Step 2: Company isolation — validate against authoritative employee.company_id
    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(Number(empCompanyId)))
      return res.status(403).json({ success: false, error: 'forbidden',
        message: 'Access denied.' });

    // Step 3: Parallel bounded queries — NO salary, NO payroll, NO compensation amounts
    const [
      identityResult,
      contractResult,
      allocResult,
      attendanceTodayResult,
      leaveBalanceResult,
      complianceResult
    ] = await Promise.all([

      // Identity + position + department — explicitly safe fields only
      query(`
        SELECT
          e.uuid,
          e.employee_number,
          e.badge_number,
          TRIM(CONCAT(
            e.first_name, ' ',
            COALESCE(e.last_name_paternal, e.last_name, ''), ' ',
            COALESCE(e.last_name_maternal, '')
          )) AS full_legal_name,
          e.first_name,
          COALESCE(e.last_name_paternal, e.last_name) AS last_name,
          e.preferred_name,
          e.work_email,
          e.country_code,
          e.status AS employment_status,
          CASE WHEN e.status = 'active' THEN true ELSE false END AS is_active,
          e.hire_date,
          e.termination_date,
          e.photo_url,
          co.name AS company_name,
          pc.title AS position_title,
          pc.job_code,
          d.name AS department_name
        FROM employees e
        LEFT JOIN companies co ON co.id = e.company_id
        LEFT JOIN employee_positions ep ON ep.employee_id = e.id AND ep.is_current = true
        LEFT JOIN position_catalog pc ON pc.id = ep.position_id
        LEFT JOIN departments d ON d.id = ep.department_id
        WHERE e.id = $1
      `, [empId]),

      // Current contract — regime/type are operational, not financial
      query(`
        SELECT contract_type, employment_regime, work_modality,
          start_date AS contract_start, version_number
        FROM employment_contracts
        WHERE employee_id = $1 AND is_current = true
        LIMIT 1
      `, [empId]),

      // Current active project allocations count — operational
      query(`
        SELECT COUNT(*) AS current_projects_count
        FROM employee_project_allocations
        WHERE employee_id = $1
          AND company_id = $2
          AND (end_date IS NULL OR end_date >= CURRENT_DATE)
          AND start_date <= CURRENT_DATE
      `, [empId, empCompanyId]),

      // Attendance today — operational status only
      query(`
        SELECT is_day_off, attendance_source, hours_worked,
          punch_in IS NOT NULL AS punched_in,
          punch_out IS NOT NULL AS punched_out
        FROM attendance_records
        WHERE employee_id = $1
          AND company_id = $2
          AND work_date = CURRENT_DATE
        LIMIT 1
      `, [empId, empCompanyId]),

      // Leave balance summary — accrued/used/pending for current year only
      query(`
        SELECT
          COALESCE(SUM(accrued_days), 0) AS total_accrued,
          COALESCE(SUM(used_days), 0) AS total_used,
          COALESCE(SUM(pending_days), 0) AS total_pending
        FROM leave_balances
        WHERE employee_id = $1
          AND company_id = $2
          AND fiscal_year = EXTRACT(YEAR FROM CURRENT_DATE)
      `, [empId, empCompanyId]),

      // Compliance summary — count only, no financial data
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status NOT IN ('completed','not_applicable')) AS warnings_count,
          COUNT(*) FILTER (WHERE status = 'completed' OR status = 'not_applicable') AS ok_count
        FROM employee_compliance_records
        WHERE employee_id = $1 AND company_id = $2
      `, [empId, empCompanyId])
    ]);

    const identity = identityResult.rows[0] || {};
    const contract = contractResult.rows[0] || null;
    const todayAtt = attendanceTodayResult.rows[0] || null;
    const leaveAgg = leaveBalanceResult.rows[0] || {};
    const compliance = complianceResult.rows[0] || {};

    // Step 4: Build EXPLICIT DTO — no spreading, no SELECT *, no sensitive fields
    const dto = {
      // Identity — safe
      uuid:               identity.uuid,
      employee_number:    identity.employee_number,
      badge_number:       identity.badge_number || null,
      full_legal_name:    identity.full_legal_name,
      first_name:         identity.first_name,
      last_name:          identity.last_name,
      preferred_name:     identity.preferred_name || null,
      work_email:         identity.work_email || null,
      photo_url:          identity.photo_url || null,
      country_code:       identity.country_code || null,

      // Employment status — safe
      employment_status:  identity.employment_status,
      is_active:          identity.is_active,
      hire_date:          identity.hire_date,
      termination_date:   identity.termination_date || null,

      // Organizational — safe
      company_name:       identity.company_name || null,
      position_title:     identity.position_title || null,
      job_code:           identity.job_code || null,
      department_name:    identity.department_name || null,

      // Contract — operational, not financial
      contract_type:      contract?.contract_type || null,
      employment_regime:  contract?.employment_regime || null,
      work_modality:      contract?.work_modality || null,
      contract_start:     contract?.contract_start || null,

      // Project summary — count only
      current_projects_count: parseInt(allocResult.rows[0]?.current_projects_count || 0),

      // Attendance today — operational summary
      attendance_today: todayAtt ? {
        punched_in:        todayAtt.punched_in,
        punched_out:       todayAtt.punched_out,
        hours_worked:      todayAtt.hours_worked || null,
        is_day_off:        todayAtt.is_day_off,
        attendance_source: todayAtt.attendance_source || null
      } : null,

      // Leave balance — current year summary
      leave_balance_summary: {
        total_accrued: parseFloat(leaveAgg.total_accrued || 0),
        total_used:    parseFloat(leaveAgg.total_used    || 0),
        total_pending: parseFloat(leaveAgg.total_pending || 0)
      },

      // Compliance — count summary only
      compliance_status: {
        ok:             parseInt(compliance.ok_count || 0),
        warnings_count: parseInt(compliance.warnings_count || 0)
      }
    };

    // Explicit safety check — ensure no sensitive fields leaked
    const FORBIDDEN_FIELDS = [
      'salary','salary_base','base_salary','amount','gross_pay','net_pay',
      'total_deductions','employer_burden','tax','curp','rfc','nss',
      'bank','account_number','routing_number','personal_email',
      'birth_date','address','marital_status','emergency_contact'
    ];
    for (const field of FORBIDDEN_FIELDS) {
      if (field in dto) {
        // Safety net — should never trigger if DTO is correctly built
        delete dto[field];
      }
    }

    res.json({ success: true, data: dto });
  } catch(e) { next(e); }
});

module.exports = router;
