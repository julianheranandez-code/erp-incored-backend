'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

router.use(verifyToken);

// FINAL ISSUE 1: Consistent RBAC bypass roles (matches attachments module)
const COMPANY_ACCESS_BYPASS_ROLES = ['admin', 'super_admin', 'finance'];

function getAuthorizedCompanyId(user, queryCompanyId) {
  if (COMPANY_ACCESS_BYPASS_ROLES.includes(user.role)) return queryCompanyId ? parseInt(queryCompanyId) : null;
  return parseInt(user.active_company_id || user.company_id || user.companyId);
}

// ─── PART 4: DB-configurable labor cost engine ────────────────
async function getPayrollSettings(companyId) {
  const result = await query(
    `SELECT * FROM company_payroll_settings WHERE company_id = $1`,
    [parseInt(companyId)]
  );
  return result.rows[0] || {
    country_code: 'MX', imss_percent: 0.35, fica_percent: 0.0765,
    workers_comp_percent: 0.02, insurance_percent: 0.05,
    aguinaldo_days: 15, vacation_days: 6, prima_vacacional_percent: 0.25,
    payroll_tax_percent: 0.03
  };
}

// OPT 2: Batch preload payroll settings for multiple companies
// Eliminates N+1 pattern in dashboard + cost-summary loops
async function preloadPayrollSettings(companyIds) {
  if (!companyIds || companyIds.length === 0) return {};
  const unique = [...new Set(companyIds.filter(Boolean).map(Number))];
  const result = await query(
    `SELECT * FROM company_payroll_settings WHERE company_id = ANY($1)`,
    [unique]
  );
  const map = {};
  for (const row of result.rows) map[row.company_id] = row;
  return map;
}

// OPT 2: calcLaborCost optionally accepts preloaded settings to avoid extra query
async function calcLaborCost(baseSalary, companyId, currency = 'MXN', preloadedSettings = null) {
  const s = preloadedSettings || await getPayrollSettings(companyId);
  const salary = parseFloat(baseSalary || 0);
  if (salary <= 0) return { base_salary: 0, total_monthly_cost: 0, monthly_burden: 0 };

  if (s.country_code === 'US') {
    const fica = salary * parseFloat(s.fica_percent);
    const wc   = salary * parseFloat(s.workers_comp_percent);
    const ins  = salary * parseFloat(s.insurance_percent);
    const burden = fica + wc + ins;
    return {
      base_salary: salary, fica_employer: round(fica),
      workers_comp: round(wc), insurance_estimate: round(ins),
      monthly_burden: round(burden), total_monthly_cost: round(salary + burden),
      burden_percent: round((burden / salary) * 100)
    };
  }

  const imss     = salary * parseFloat(s.imss_percent);
  const aguinaldo = (salary / 365) * parseInt(s.aguinaldo_days);
  const vacation  = (salary / 365) * parseInt(s.vacation_days);
  const primaVac  = vacation * parseFloat(s.prima_vacacional_percent);
  const burden    = imss + aguinaldo + vacation + primaVac;
  return {
    base_salary: salary, imss_employer: round(imss),
    aguinaldo_accrual: round(aguinaldo), vacation_accrual: round(vacation),
    prima_vacacional: round(primaVac), monthly_burden: round(burden),
    total_monthly_cost: round(salary + burden),
    burden_percent: round((burden / salary) * 100)
  };
}

function round(n) { return Math.round(parseFloat(n) * 100) / 100; }

// ─── FINAL ISSUE 3: Progressive compliance scoring ───────────
// Priority: verified docs > unverified docs > legacy text fields
function calcComplianceScore(emp, company, verifiedDocs = []) {
  let score = 100;
  const alerts = [];
  const isMX = (company?.country_code || company?.country || 'MX') !== 'US' &&
    (company?.tax_mode || 'MEXICO_VAT_16') !== 'US_NO_TAX';

  // Build verified doc category set (normalized UPPER)
  const verifiedCategories = new Set(
    verifiedDocs
      .filter(d => d.is_verified && !isExpired(d.expiration_date))
      .map(d => String(d.document_category || '').trim().toUpperCase())
  );

  function isExpired(date) {
    if (!date) return false;
    return new Date(date) < new Date();
  }

  function checkDoc(category, penalty, severity, legacyField) {
    const cat = category.toUpperCase();
    // Priority 1: verified doc exists → compliant
    if (verifiedCategories.has(cat)) return;
    // Priority 2: doc exists but not verified → partial
    const hasUnverified = verifiedDocs.some(d =>
      String(d.document_category || '').trim().toUpperCase() === cat
    );
    if (hasUnverified) {
      alerts.push({ type: `unverified_${category.toLowerCase()}`, severity: 'info',
        compliance_source: 'legacy_fields',
        message: `${category} registrado pero sin verificar` });
      score -= Math.floor(penalty / 2);
      return;
    }
    // Priority 3: legacy text field
    if (legacyField) {
      alerts.push({ type: `unverified_${category.toLowerCase()}`, severity: 'info',
        compliance_source: 'legacy_fields',
        message: `${category} en perfil pero no como documento verificado` });
      score -= Math.floor(penalty / 3);
      return;
    }
    // Missing entirely
    score -= penalty;
    alerts.push({ type: `missing_${category.toLowerCase()}`, severity, compliance_source: 'missing' });
  }

  if (isMX) {
    checkDoc('RFC',  15, 'warning', emp.rfc);
    checkDoc('IMSS', 20, 'warning', emp.nss_imss);
    checkDoc('CURP', 10, 'info',    emp.curp);
  } else {
    checkDoc('TAX_ID',            25, 'critical', emp.tax_id);
    checkDoc('WORK_AUTHORIZATION', 20, 'critical', emp.work_authorization);
  }

  // Contract expiration (not doc-based)
  if (emp.contract_end_date) {
    const daysLeft = Math.floor((new Date(emp.contract_end_date) - new Date()) / 86400000);
    if (daysLeft < 0)   { score -= 25; alerts.push({ type: 'contract_expired',  severity: 'critical', days: daysLeft, compliance_source: 'profile' }); }
    else if (daysLeft < 30) { score -= 15; alerts.push({ type: 'contract_expiring', severity: 'warning', days: daysLeft, compliance_source: 'profile' }); }
  }

  // Expired verified docs
  verifiedDocs.filter(d => d.is_verified && isExpired(d.expiration_date)).forEach(d => {
    const cat = String(d.document_category || '').toUpperCase();
    score -= 15;
    alerts.push({ type: `expired_doc_${cat.toLowerCase()}`, severity: 'critical',
      document_category: d.document_category, expiration_date: d.expiration_date,
      compliance_source: 'verified_documents' });
  });

  const finalScore = Math.max(0, score);
  const complianceSource = verifiedDocs.length > 0
    ? (verifiedCategories.size > 0 ? 'verified_documents' : 'mixed')
    : 'legacy_fields';

  return {
    score: finalScore,
    status: finalScore >= 80 ? 'compliant' : finalScore >= 50 ? 'warning' : 'critical',
    alerts,
    compliance_source: complianceSource
  };
}

// ─── GET /api/workforce/employees ────────────────────────────
router.get('/employees', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const { status, workforce_type, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (status)         { conditions.push(`e.status = $${idx++}`); values.push(status); }
    if (workforce_type && authorizedCompanyId) {
      conditions.push(`ecp.workforce_type = $${idx++}`); values.push(workforce_type);
    }

    const companyJoin = authorizedCompanyId
      ? `JOIN employee_company_profiles ecp ON ecp.emp_id = e.id AND ecp.company_id = $${idx++}`
      : `LEFT JOIN employee_company_profiles ecp ON ecp.emp_id = e.id`;
    if (authorizedCompanyId) values.push(authorizedCompanyId);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT e.*,
        CONCAT(e.first_name,' ',e.last_name) AS full_name,
        ecp.id AS profile_id, ecp.company_id,
        ecp.workforce_type, ecp.employment_type, ecp.labor_category,
        ecp.payroll_frequency, ecp.base_salary, ecp.currency,
        ecp.hire_date, ecp.contract_start_date, ecp.contract_end_date,
        ecp.department, ecp.job_title, ecp.is_active,
        ecp.assigned_project_id, ecp.allocation_percent,
        ecp.compliance_score, ecp.compliance_status,
        ecp.rfc, ecp.curp, ecp.nss_imss, ecp.tax_id,
        -- Contract status
        CASE
          WHEN ecp.contract_end_date IS NULL THEN 'no_expiry'
          WHEN ecp.contract_end_date < CURRENT_DATE THEN 'expired'
          WHEN ecp.contract_end_date < CURRENT_DATE + 30 THEN 'expiring_soon'
          ELSE 'active'
        END AS contract_status,
        ecp.contract_end_date - CURRENT_DATE AS days_until_contract_end,
        -- Optional ERP user link
        ul.user_id AS linked_user_id
      FROM employees e
      ${companyJoin}
      LEFT JOIN employee_user_links ul ON ul.employee_id = e.id
      ${where}
      ORDER BY e.last_name, e.first_name ASC
      LIMIT $${idx} OFFSET $${idx+1}
    `, [...values, parseInt(limit), offset]);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── POST /api/workforce/employees ───────────────────────────
router.post('/employees', async (req, res, next) => {
  try {
    const {
      employee_number, first_name, last_name, middle_name, preferred_name,
      personal_email, phone, birth_date, gender, nationality, marital_status,
      address, city, state, country = 'MX', postal_code,
      emergency_contact_name, emergency_contact_phone,
      emergency_contact_relationship, notes, status = 'active',
      // Company profile fields
      company_id, workforce_type = 'admin', employment_type = 'permanent',
      payroll_frequency = 'biweekly', labor_category = 'admin_staff',
      hire_date, contract_start_date, contract_end_date,
      salary_type = 'fixed', base_salary, currency = 'MXN',
      department, job_title, rfc, curp, nss_imss, tax_id, work_authorization,
      // Optional ERP user link
      link_user_id
    } = req.body;

    if (!first_name || !last_name) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: first_name, last_name' });
    }

    const result = await withTransaction(async (client) => {
      // 1. Create employee
      const emp = await client.query(`
        INSERT INTO employees (
          employee_number, first_name, last_name, middle_name, preferred_name,
          personal_email, phone, birth_date, gender, nationality, marital_status,
          address, city, state, country, postal_code,
          emergency_contact_name, emergency_contact_phone,
          emergency_contact_relationship, notes, status, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        RETURNING *
      `, [employee_number||null, first_name, last_name, middle_name||null,
          preferred_name||null, personal_email||null, phone||null,
          birth_date||null, gender||null, nationality||null, marital_status||null,
          address||null, city||null, state||null, country, postal_code||null,
          emergency_contact_name||null, emergency_contact_phone||null,
          emergency_contact_relationship||null, notes||null, status, req.user.id]);

      const employee = emp.rows[0];

      // 2. Create company profile if company_id provided
      if (company_id) {
        await client.query(`
          INSERT INTO employee_company_profiles (
            emp_id, company_id, workforce_type, employment_type,
            payroll_frequency, labor_category, hire_date,
            contract_start_date, contract_end_date,
            salary_type, base_salary, currency, department, job_title,
            rfc, curp, nss_imss, tax_id, work_authorization, created_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (emp_id, company_id) DO UPDATE SET
            workforce_type = EXCLUDED.workforce_type,
            updated_at = NOW()
        `, [employee.id, parseInt(company_id), workforce_type, employment_type,
            payroll_frequency, labor_category, hire_date||null,
            contract_start_date||null, contract_end_date||null,
            salary_type, base_salary ? parseFloat(base_salary) : null, currency,
            department||null, job_title||null,
            rfc||null, curp||null, nss_imss||null, tax_id||null,
            work_authorization||null, req.user.id]);

        // 3. Create initial salary history if salary provided
        if (base_salary) {
          await client.query(`
            INSERT INTO employee_salary_history (
              employee_id, company_id, effective_date, salary_type,
              base_salary, currency, payroll_frequency,
              change_reason, created_by
            ) VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,'initial_hire',$7)
          `, [employee.id, parseInt(company_id), salary_type,
              parseFloat(base_salary), currency, payroll_frequency, req.user.id]);
        }
      }

      // 4. Link to ERP user (optional)
      if (link_user_id) {
        await client.query(`
          INSERT INTO employee_user_links (employee_id, user_id)
          VALUES ($1,$2) ON CONFLICT DO NOTHING
        `, [employee.id, link_user_id]);
      }

      return employee;
    });

    writeAudit({
      userId: req.user.id, action: 'employee_created',
      entityType: 'employees', entityId: result.id,
      companyId: company_id ? parseInt(company_id) : null,
      newValues: { first_name, last_name, workforce_type },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Employee created.', data: result });
  } catch (error) { next(error); }
});

// ─── PATCH /api/workforce/employees/:id ──────────────────────
router.patch('/employees/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const allowed = ['first_name','last_name','middle_name','preferred_name',
      'personal_email','phone','birth_date','gender','nationality','marital_status',
      'address','city','state','country','postal_code','status','notes',
      'emergency_contact_name','emergency_contact_phone','emergency_contact_relationship',
      'termination_date','termination_reason'];

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        setClauses.push(`${field} = $${idx++}`);
        values.push(req.body[field]);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, error: 'no_fields' });
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(id);

    const result = await query(
      `UPDATE employees SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    writeAudit({
      userId: req.user.id, action: 'employee_updated',
      entityType: 'employees', entityId: id,
      newValues: req.body, ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.json({ success: true, message: 'Employee updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── GET /api/workforce/cost-summary ─────────────────────────
router.get('/cost-summary', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const values = [];
    let idx = 1;
    const filter = authorizedCompanyId ? `AND ecp.company_id = $${idx++}` : '';
    if (authorizedCompanyId) values.push(authorizedCompanyId);

    const employees = await query(`
      SELECT ecp.base_salary, ecp.currency, ecp.workforce_type, ecp.labor_category,
        ecp.company_id
      FROM employee_company_profiles ecp
      WHERE ecp.is_active = TRUE ${filter}
    `, values);

    let totalMonthlyCost = 0;
    let totalBurden = 0;
    const byType = {};
    const byCategory = {};

    // OPT 2: Preload all payroll settings in one query
    const companyIds = [...new Set(employees.rows.map(e => e.company_id).filter(Boolean))];
    const settingsMap = await preloadPayrollSettings(companyIds);

    for (const emp of employees.rows) {
      if (!emp.base_salary) continue;
      const preloaded = settingsMap[emp.company_id] || null;
      const cost = await calcLaborCost(emp.base_salary, emp.company_id, emp.currency, preloaded);
      totalMonthlyCost += cost.total_monthly_cost;
      totalBurden += cost.monthly_burden;

      if (!byType[emp.workforce_type]) byType[emp.workforce_type] = { count: 0, monthly_cost: 0 };
      byType[emp.workforce_type].count++;
      byType[emp.workforce_type].monthly_cost += cost.total_monthly_cost;

      if (!byCategory[emp.labor_category]) byCategory[emp.labor_category] = { count: 0, monthly_cost: 0 };
      byCategory[emp.labor_category].count++;
      byCategory[emp.labor_category].monthly_cost += cost.total_monthly_cost;
    }

    res.json({
      success: true,
      data: {
        total_employees: employees.rows.length,
        total_monthly_cost: round(totalMonthlyCost),
        total_monthly_burden: round(totalBurden),
        by_workforce_type: byType,
        by_labor_category: byCategory
      }
    });
  } catch (error) { next(error); }
});

// ─── GET /api/workforce/project-allocation ───────────────────
router.get('/project-allocation', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const { project_id } = req.query;
    const conditions = [`epa.end_date IS NULL OR epa.end_date >= CURRENT_DATE`];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`epa.company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (project_id) { conditions.push(`epa.project_id = $${idx++}`); values.push(parseInt(project_id)); }

    const result = await query(`
      SELECT epa.*,
        CONCAT(e.first_name,' ',e.last_name) AS full_name,
        e.status AS employee_status,
        p.name AS project_name
      FROM employee_project_allocations epa
      JOIN employees e  ON e.id = epa.employee_id
      LEFT JOIN projects p ON p.id = epa.project_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.name, e.last_name ASC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── POST /api/workforce/project-allocation ──────────────────
router.post('/project-allocation', async (req, res, next) => {
  try {
    const { employee_id, project_id, company_id, allocation_percent = 100,
            allocation_type = 'dedicated', start_date, end_date,
            hourly_cost_override, notes } = req.body;

    if (!employee_id || !project_id || !company_id || !start_date) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: employee_id, project_id, company_id, start_date' });
    }

    const result = await query(`
      INSERT INTO employee_project_allocations (
        employee_id, project_id, company_id, allocation_percent,
        allocation_type, start_date, end_date, hourly_cost_override,
        notes, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [parseInt(employee_id), parseInt(project_id), parseInt(company_id),
        parseFloat(allocation_percent), allocation_type, start_date,
        end_date||null, hourly_cost_override ? parseFloat(hourly_cost_override) : null,
        notes||null, req.user.id]);

    res.status(201).json({ success: true, message: 'Allocation created.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── GET /api/workforce/salary-history ───────────────────────
router.get('/salary-history', async (req, res, next) => {
  try {
    const { employee_id, company_id: qCid } = req.query;
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, qCid);
    const conditions = [];
    const values = [];
    let idx = 1;

    if (employee_id)         { conditions.push(`sh.employee_id = $${idx++}`); values.push(parseInt(employee_id)); }
    if (authorizedCompanyId) { conditions.push(`sh.company_id = $${idx++}`); values.push(authorizedCompanyId); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      SELECT sh.*,
        CONCAT(e.first_name,' ',e.last_name) AS full_name,
        CONCAT(u.first_name,' ',u.last_name) AS approved_by_name
      FROM employee_salary_history sh
      JOIN employees e ON e.id = sh.employee_id
      LEFT JOIN users u ON u.id = sh.approved_by
      ${where}
      ORDER BY sh.effective_date DESC
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── POST /api/workforce/salary-history ──────────────────────
router.post('/salary-history', async (req, res, next) => {
  try {
    const { employee_id, company_id, effective_date, salary_type = 'fixed',
            base_salary, currency = 'MXN', payroll_frequency = 'biweekly',
            change_reason, notes, approved_by } = req.body;

    if (!employee_id || !company_id || !effective_date || !base_salary) {
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: employee_id, company_id, effective_date, base_salary' });
    }

    const result = await withTransaction(async (client) => {
      // Insert salary history
      const hist = await client.query(`
        INSERT INTO employee_salary_history (
          employee_id, company_id, effective_date, salary_type,
          base_salary, currency, payroll_frequency, change_reason,
          notes, approved_by, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
      `, [parseInt(employee_id), parseInt(company_id), effective_date,
          salary_type, parseFloat(base_salary), currency, payroll_frequency,
          change_reason||null, notes||null, approved_by||null, req.user.id]);

      // Update current snapshot in profile
      await client.query(`
        UPDATE employee_company_profiles SET
          base_salary = $1, currency = $2, payroll_frequency = $3, updated_at = NOW()
        WHERE emp_id = $4 AND company_id = $5
      `, [parseFloat(base_salary), currency, payroll_frequency,
          parseInt(employee_id), parseInt(company_id)]);

      return hist.rows[0];
    });

    writeAudit({
      userId: req.user.id, action: 'salary_change',
      entityType: 'employee_salary_history', entityId: result.id,
      companyId: parseInt(company_id),
      newValues: { employee_id, base_salary, change_reason },
      ip: req.ip, userAgent: req.get('user-agent')
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Salary history recorded.', data: result });
  } catch (error) { next(error); }
});

// ─── GET /api/workforce/company-profiles ─────────────────────
router.get('/company-profiles', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const { employee_id } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (authorizedCompanyId) { conditions.push(`company_id = $${idx++}`); values.push(authorizedCompanyId); }
    if (employee_id) { conditions.push(`emp_id = $${idx++}`); values.push(parseInt(employee_id)); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(`SELECT * FROM employee_company_profiles ${where} ORDER BY created_at DESC`, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) { next(error); }
});

// ─── GET /api/workforce/payroll-settings ─────────────────────
router.get('/payroll-settings', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    if (!authorizedCompanyId) return res.status(400).json({ success: false, error: 'company_id_required' });

    const result = await query(
      `SELECT * FROM company_payroll_settings WHERE company_id = $1`,
      [authorizedCompanyId]
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (error) { next(error); }
});

// ─── PATCH /api/workforce/payroll-settings ───────────────────
router.patch('/payroll-settings', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id || req.body.company_id);
    if (!authorizedCompanyId) return res.status(400).json({ success: false, error: 'company_id_required' });

    const { imss_percent, fica_percent, workers_comp_percent, insurance_percent,
            aguinaldo_days, vacation_days, prima_vacacional_percent, payroll_tax_percent } = req.body;

    const result = await query(`
      INSERT INTO company_payroll_settings (company_id, imss_percent, fica_percent,
        workers_comp_percent, insurance_percent, aguinaldo_days, vacation_days,
        prima_vacacional_percent, payroll_tax_percent, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (company_id) DO UPDATE SET
        imss_percent           = COALESCE($2, company_payroll_settings.imss_percent),
        fica_percent           = COALESCE($3, company_payroll_settings.fica_percent),
        workers_comp_percent   = COALESCE($4, company_payroll_settings.workers_comp_percent),
        insurance_percent      = COALESCE($5, company_payroll_settings.insurance_percent),
        aguinaldo_days         = COALESCE($6, company_payroll_settings.aguinaldo_days),
        vacation_days          = COALESCE($7, company_payroll_settings.vacation_days),
        prima_vacacional_percent = COALESCE($8, company_payroll_settings.prima_vacacional_percent),
        payroll_tax_percent    = COALESCE($9, company_payroll_settings.payroll_tax_percent),
        updated_at             = NOW()
      RETURNING *
    `, [authorizedCompanyId,
        imss_percent||null, fica_percent||null, workers_comp_percent||null,
        insurance_percent||null, aguinaldo_days||null, vacation_days||null,
        prima_vacacional_percent||null, payroll_tax_percent||null]);

    res.json({ success: true, message: 'Payroll settings updated.', data: result.rows[0] });
  } catch (error) { next(error); }
});

// ─── GET /api/workforce/compliance-alerts (UNIFIED) ──────────
// FIX 4: Single source of truth — merges contract + doc expiry
router.get('/compliance-alerts', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const values = [];
    let idx = 1;
    const cf = authorizedCompanyId ? `AND ecp.company_id = $${idx++}` : '';
    if (authorizedCompanyId) values.push(authorizedCompanyId);

    let company = { country_code: 'MX', tax_mode: 'MEXICO_VAT_16' };
    if (authorizedCompanyId) {
      const co = await query(`SELECT country, tax_mode FROM companies WHERE id = $1`, [authorizedCompanyId]);
      company = co.rows[0] || company;
    }

    const employees = await query(`
      SELECT e.id, e.first_name, e.last_name, e.status,
        ecp.contract_end_date, ecp.rfc, ecp.curp, ecp.nss_imss,
        ecp.tax_id, ecp.work_authorization, ecp.currency,
        ecp.compliance_score, ecp.compliance_status
      FROM employees e
      JOIN employee_company_profiles ecp ON ecp.emp_id = e.id
      WHERE e.status = 'active' ${cf}
    `, values);

    const allAlerts = [];

    // OPT 2: Batch preload ALL employee docs in ONE query (eliminates N+1)
    const employeeIds = employees.rows.map(e => e.id);
    let docsByEmployee = {};

    if (employeeIds.length > 0) {
      const allDocs = await query(`
        SELECT document_id AS emp_id, document_category, expiration_date, is_verified
        FROM document_attachments
        WHERE document_type = 'employee'
          AND is_deleted = FALSE
          AND document_id = ANY($1)
      `, [employeeIds]);

      // Group by employee ID in memory — O(1) lookup
      for (const doc of allDocs.rows) {
        if (!docsByEmployee[doc.emp_id]) docsByEmployee[doc.emp_id] = [];
        docsByEmployee[doc.emp_id].push(doc);
      }
    }

    for (const emp of employees.rows) {
      // FINAL ISSUE 3: Use preloaded docs — no per-employee query
      const verifiedDocs = docsByEmployee[emp.id] || [];
      const { alerts, compliance_source } = calcComplianceScore(emp, company, verifiedDocs);
      for (const alert of alerts) {
        allAlerts.push({ ...alert, employee_id: emp.id,
          full_name: `${emp.first_name} ${emp.last_name}`,
          compliance_score: emp.compliance_score,
          compliance_source, source: 'profile' });
      }
    }

    // Doc expiration alerts
    const docValues = authorizedCompanyId ? [authorizedCompanyId] : [];
    const docCf = authorizedCompanyId ? `AND ecp.company_id = $1` : '';
    const docAlerts = await query(`
      SELECT da.document_category, da.expiration_date, da.is_verified,
        da.document_id AS emp_id,
        CONCAT(e.first_name,' ',e.last_name) AS full_name,
        CASE WHEN da.expiration_date < CURRENT_DATE THEN 'expired' ELSE 'expiring_soon' END AS expiry_status,
        CURRENT_DATE - da.expiration_date AS days_overdue
      FROM document_attachments da
      JOIN employees e ON e.id = da.document_id
      JOIN employee_company_profiles ecp ON ecp.emp_id = e.id
      WHERE da.document_type = 'employee' AND da.is_deleted = FALSE
        AND da.expiration_date IS NOT NULL AND da.expiration_date < CURRENT_DATE + 30
        ${docCf}
      ORDER BY da.expiration_date ASC
    `, docValues);

    for (const r of docAlerts.rows) {
      allAlerts.push({
        type: r.expiry_status === 'expired' ? 'doc_expired' : 'doc_expiring_soon',
        severity: r.expiry_status === 'expired' ? 'critical' : 'warning',
        employee_id: r.emp_id, full_name: r.full_name,
        document_category: r.document_category,
        expiration_date: r.expiration_date,
        days_remaining: -parseInt(r.days_overdue),
        is_verified: r.is_verified, source: 'attachment',
        message: r.expiry_status === 'expired'
          ? `${r.document_category} vencido hace ${Math.abs(r.days_overdue)} días`
          : `${r.document_category} vence en ${Math.abs(r.days_overdue)} días`
      });
    }

    res.json({
      success: true, count: allAlerts.length, data: allAlerts,
      summary: {
        critical: allAlerts.filter(a => a.severity === 'critical').length,
        warning:  allAlerts.filter(a => a.severity === 'warning').length,
        info:     allAlerts.filter(a => a.severity === 'info').length
      }
    });
  } catch (error) { next(error); }
});

// ─── PATCH 6: Workforce dashboard summary ─────────────────────
// FIX 5: Use calcLaborCost() — no hardcoded burden %
router.get('/dashboard-summary', async (req, res, next) => {
  try {
    const authorizedCompanyId = getAuthorizedCompanyId(req.user, req.query.company_id);
    const values = [];
    let idx = 1;
    const cf = authorizedCompanyId ? `AND ecp.company_id = $${idx++}` : '';
    if (authorizedCompanyId) values.push(authorizedCompanyId);

    const [counts, empCosts, contracts, compliance] = await Promise.all([
      query(`SELECT COUNT(*) AS total_profiles,
          COUNT(CASE WHEN ecp.is_active=TRUE THEN 1 END) AS active,
          COUNT(CASE WHEN ecp.workforce_type='field' AND ecp.is_active=TRUE THEN 1 END) AS field_count,
          COUNT(CASE WHEN ecp.workforce_type='admin' AND ecp.is_active=TRUE THEN 1 END) AS admin_count,
          COUNT(CASE WHEN ecp.assigned_project_id IS NOT NULL AND ecp.is_active=TRUE THEN 1 END) AS project_assigned
        FROM employee_company_profiles ecp WHERE 1=1 ${cf}`, values),
      query(`SELECT ecp.base_salary, ecp.currency, ecp.company_id
        FROM employee_company_profiles ecp
        WHERE ecp.is_active=TRUE AND ecp.base_salary IS NOT NULL ${cf}`, values),
      query(`SELECT COUNT(*) AS expiring_soon FROM employee_company_profiles ecp
        WHERE ecp.contract_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30 ${cf}`, values),
      query(`SELECT COUNT(CASE WHEN ecp.compliance_status='critical' THEN 1 END) AS critical,
          COUNT(CASE WHEN ecp.compliance_status='warning' THEN 1 END) AS warning,
          COUNT(CASE WHEN ecp.compliance_status='compliant' THEN 1 END) AS compliant
        FROM employee_company_profiles ecp WHERE ecp.is_active=TRUE ${cf}`, values)
    ]);

    // FIX 5 + OPT 2: Aggregate using configured burden with preloaded settings
    const companyIds = [...new Set(empCosts.rows.map(e => e.company_id).filter(Boolean))];
    const settingsMap = await preloadPayrollSettings(companyIds);

    let totalBaseSalary = 0;
    let totalBurden = 0;
    for (const emp of empCosts.rows) {
      if (!emp.base_salary) continue;
      const preloaded = settingsMap[emp.company_id] || null;
      const cost = await calcLaborCost(emp.base_salary, emp.company_id, emp.currency, preloaded);
      totalBaseSalary += parseFloat(emp.base_salary);
      totalBurden += cost.monthly_burden;
    }

    res.json({
      success: true,
      data: {
        workforce: {
          total:            parseInt(counts.rows[0].total_profiles),
          active:           parseInt(counts.rows[0].active),
          field:            parseInt(counts.rows[0].field_count),
          admin:            parseInt(counts.rows[0].admin_count),
          project_assigned: parseInt(counts.rows[0].project_assigned)
        },
        payroll: {
          total_base_salary:     round(totalBaseSalary),
          estimated_burden:      round(totalBurden),
          estimated_total_cost:  round(totalBaseSalary + totalBurden),
          employees_with_salary: empCosts.rows.length
        },
        contracts: { expiring_soon: parseInt(contracts.rows[0].expiring_soon) },
        compliance: {
          critical:  parseInt(compliance.rows[0].critical),
          warning:   parseInt(compliance.rows[0].warning),
          compliant: parseInt(compliance.rows[0].compliant)
        }
      }
    });
  } catch (error) { next(error); }
});

module.exports = router;
