'use strict';

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../../config/database');
const { verifyToken } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/rbac');
const { writeAudit } = require('../../middleware/audit');

router.use(verifyToken);

async function generateRunNumber() {
  const result = await query("SELECT 'PAY-' || LPAD(nextval('payroll_run_seq')::text, 6, '0') AS run_number");
  return result.rows[0].run_number;
}

// ─── MEXICO TAX ENGINE ────────────────────────────────────────

const ISR_TABLE_2026 = [
  { lower: 0,        upper: 746.04,    fixed: 0,       rate: 0.0192 },
  { lower: 746.05,   upper: 6332.05,   fixed: 14.32,   rate: 0.0640 },
  { lower: 6332.06,  upper: 11128.01,  fixed: 371.83,  rate: 0.1088 },
  { lower: 11128.02, upper: 12935.82,  fixed: 893.63,  rate: 0.1600 },
  { lower: 12935.83, upper: 15487.71,  fixed: 1182.88, rate: 0.1792 },
  { lower: 15487.72, upper: 31236.49,  fixed: 1640.18, rate: 0.2136 },
  { lower: 31236.50, upper: 49233.00,  fixed: 5004.12, rate: 0.2352 },
  { lower: 49233.01, upper: 93993.90,  fixed: 9236.89, rate: 0.3000 },
  { lower: 93993.91, upper: 125325.20, fixed: 22665.17,rate: 0.3200 },
  { lower: 125325.21,upper: 375975.61, fixed: 32691.18,rate: 0.3400 },
  { lower: 375975.62,upper: 999999999, fixed: 117912.32,rate:0.3500 },
];

const SUBSIDIO_TABLE_2026 = [
  { lower: 0,       upper: 1768.96,  subsidy: 407.02 },
  { lower: 1768.97, upper: 2653.38,  subsidy: 406.83 },
  { lower: 2653.39, upper: 3472.84,  subsidy: 406.62 },
  { lower: 3472.85, upper: 3537.87,  subsidy: 392.77 },
  { lower: 3537.88, upper: 4446.15,  subsidy: 382.46 },
  { lower: 4446.16, upper: 4717.18,  subsidy: 354.23 },
  { lower: 4717.19, upper: 5335.42,  subsidy: 324.87 },
  { lower: 5335.43, upper: 6224.67,  subsidy: 294.63 },
  { lower: 6224.68, upper: 7113.90,  subsidy: 253.54 },
  { lower: 7113.91, upper: 7382.33,  subsidy: 217.61 },
  { lower: 7382.34, upper: 999999999,subsidy: 0 },
];

function calculateISR(monthlyTaxable) {
  const row = ISR_TABLE_2026.find(r => monthlyTaxable >= r.lower && monthlyTaxable <= r.upper);
  if (!row) return 0;
  return row.fixed + (monthlyTaxable - row.lower) * row.rate;
}

function calculateSubsidio(monthlyGross) {
  const row = SUBSIDIO_TABLE_2026.find(r => monthlyGross >= r.lower && monthlyGross <= r.upper);
  return row ? row.subsidy : 0;
}

function calculateIMSSEmployee(sbcMonthly) {
  const UMA_DAILY_2026 = 108.57;
  const UMA_MONTHLY = UMA_DAILY_2026 * 30.4;
  const emEnfermedadMaternidad = Math.min(sbcMonthly, 3 * UMA_MONTHLY) * 0.003;
  const emExcedente = Math.max(0, sbcMonthly - 3 * UMA_MONTHLY) * 0.004;
  const ivInvalidezVida = sbcMonthly * 0.00625;
  const rcvCesantia = sbcMonthly * 0.01125;
  return emEnfermedadMaternidad + emExcedente + ivInvalidezVida + rcvCesantia;
}

function calculateIMSSEmployer(sbcMonthly, riskRate = 0.015) {
  const UMA_DAILY_2026 = 108.57;
  const UMA_MONTHLY = UMA_DAILY_2026 * 30.4;
  const emPatron = sbcMonthly * 0.205;
  const riesgoTrabajo = sbcMonthly * riskRate;
  const ivPatron = sbcMonthly * 0.0175;
  const guarderias = sbcMonthly * 0.01;
  const rcvPatron = sbcMonthly * 0.0315;
  const retiro = sbcMonthly * 0.02;
  const infonavit = sbcMonthly * 0.05;
  return emPatron + riesgoTrabajo + ivPatron + guarderias + rcvPatron + retiro + infonavit;
}

function calculateSBC(monthlySalary) {
  const dailySalary = monthlySalary / 30.4;
  const aguinaldoProportion = (15 / 365) * dailySalary;
  const primaVacProportion = (12 * 0.25 / 365) * dailySalary;
  const sbcDaily = dailySalary + aguinaldoProportion + primaVacProportion;
  const MAX_SBC_DAILY = 108.57 * 25;
  return {
    sbc_daily: Math.min(sbcDaily, MAX_SBC_DAILY),
    sbc_monthly: Math.min(sbcDaily * 30.4, MAX_SBC_DAILY * 30.4)
  };
}

// ─── USA TAX ENGINE ───────────────────────────────────────────

function calculateFICA(grossPay) {
  const SS_WAGE_BASE_2026 = 176100;
  const ss = Math.min(grossPay, SS_WAGE_BASE_2026) * 0.062;
  const medicare = grossPay * 0.0145;
  return { ss, medicare, total: ss + medicare };
}

function calculateFederalWithholding(annualizedWages, w4 = {}) {
  const { filing_status = 'single', dependents_amount = 0,
          other_income = 0, deductions = 0, extra_withholding = 0 } = w4;
  const standardDeduction = filing_status === 'married' ? 30000 : 15000;
  const taxableIncome = Math.max(0,
    annualizedWages + other_income - deductions - standardDeduction - dependents_amount);
  let tax = 0;
  const brackets = filing_status === 'married' ? [
    [0, 23200, 0, 0.10], [23200, 94300, 2320, 0.12],
    [94300, 201050, 10852, 0.22], [201050, 383900, 34337, 0.24],
    [383900, 487450, 78221, 0.32], [487450, 731200, 111357, 0.35],
    [731200, 999999999, 196669, 0.37]
  ] : [
    [0, 11600, 0, 0.10], [11600, 47150, 1160, 0.12],
    [47150, 100525, 5426, 0.22], [100525, 191950, 17168, 0.24],
    [191950, 243725, 39110, 0.32], [243725, 609350, 55678, 0.35],
    [609350, 999999999, 183647, 0.37]
  ];
  for (const [lower, upper, fixed, rate] of brackets) {
    if (taxableIncome > lower) {
      tax = fixed + (Math.min(taxableIncome, upper) - lower) * rate;
    }
  }
  return Math.max(0, tax + parseFloat(extra_withholding) * 52);
}

function calculateIndianaState(grossPay) {
  return grossPay * 0.0305;
}

// ─── PAYROLL CALCULATION ENGINE ───────────────────────────────

async function calculateMXIMSS(client, entryId, employeeId, companyId, runId, salary, payFreq, timesheet) {
  const periodFactor = payFreq === 'weekly' ? 7/30.4 : payFreq === 'biweekly' ? 15/30.4 : 1;
  const dailyRate = salary / 30.4;
  const periodBase = salary * periodFactor;
  const overtimePay = (timesheet.overtime_hours_double || 0) * dailyRate / 8 * 2
                    + (timesheet.overtime_hours_triple || 0) * dailyRate / 8 * 3;
  const absenceDeduction = (timesheet.days_absent || 0) * dailyRate;
  // holiday_pay: statutory premium (2×) pre-calculated, passed via timesheet
  // periodBase already contains ordinary salary for the worked holiday day
  const holidayPay = parseFloat(timesheet.holiday_pay || 0);
  const grossPay = periodBase + overtimePay + holidayPay - absenceDeduction;
  const monthlyGross = salary;
  const { sbc_daily, sbc_monthly } = calculateSBC(monthlyGross);
  const imssEmployee = calculateIMSSEmployee(sbc_monthly) * periodFactor;
  const isrMonthly = calculateISR(monthlyGross - calculateIMSSEmployee(sbc_monthly));
  const subsidio = calculateSubsidio(monthlyGross);
  const isrPeriod = Math.max(0, (isrMonthly - subsidio) * periodFactor);
  const totalDeductions = imssEmployee + isrPeriod;
  const netPay = grossPay - totalDeductions;
  const imssEmployer = calculateIMSSEmployer(sbc_monthly) * periodFactor;
  const isnRate = 0.02;
  const isn = grossPay * isnRate;

  await client.query(`
    UPDATE payroll_entries SET
      base_salary_period=$1, overtime_pay=$2, absence_deduction=$3,
      gross_pay=$4, taxable_gross=$5, total_deductions=$6, net_pay=$7,
      sbc_daily=$8, sbc_monthly=$9, updated_at=NOW()
    WHERE id=$10
  `, [periodBase, overtimePay, absenceDeduction,
      grossPay, grossPay - imssEmployee, totalDeductions, netPay,
      sbc_daily, sbc_monthly, entryId]);

  const deductions = [
    ['imss_employee', 'IMSS Cuotas Obrero', imssEmployee, false],
    ['isr_withholding', 'ISR Retencion', isrPeriod, false],
    ['imss_patron', 'IMSS Patron', imssEmployer, true],
    ['isn', 'ISN', isn, true],
  ];

  for (const [type, desc, amt, isEmp] of deductions) {
    if (amt > 0) {
      await client.query(`
        INSERT INTO payroll_deductions (payroll_entry_id, company_id, deduction_type, description, amount, is_employer)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [entryId, companyId, type, desc, parseFloat(amt.toFixed(2)), isEmp]);
    }
  }

  return { gross_pay: grossPay, net_pay: netPay, total_deductions: totalDeductions,
           employer_burden: imssEmployer + isn };
}

async function calculateUSAW2(client, entryId, employeeId, companyId, salary, payFreq, timesheet, w4) {
  const payPeriods = payFreq === 'weekly' ? 52 : payFreq === 'biweekly' ? 26 : 24;
  const periodicSalary = salary / payPeriods;
  const regularHours = timesheet.regular_hours || 0;
  const overtimeHours = timesheet.overtime_hours || 0;
  const hourlyRate = salary / (payPeriods * 40);
  const regularPay = Math.min(regularHours, 40) * hourlyRate;
  const overtimePay = overtimeHours * hourlyRate * 1.5;
  const grossPay = regularPay + overtimePay || periodicSalary;
  const fica = calculateFICA(grossPay);
  const annualized = grossPay * payPeriods;
  const federalAnnual = calculateFederalWithholding(annualized, w4);
  const federalPeriod = federalAnnual / payPeriods;
  const stateTax = calculateIndianaState(grossPay);
  const totalDeductions = fica.total + federalPeriod + stateTax;
  const netPay = grossPay - totalDeductions;
  const ficaEmployer = fica.total;
  const futa = Math.min(grossPay, 7000 / payPeriods) * 0.006;
  const suta = grossPay * 0.025;

  await client.query(`
    UPDATE payroll_entries SET
      regular_pay=$1, overtime_pay_usa=$2, gross_pay=$3,
      taxable_gross=$3, total_deductions=$4, net_pay=$5,
      currency='USD', updated_at=NOW()
    WHERE id=$6
  `, [regularPay, overtimePay, grossPay, totalDeductions, netPay, entryId]);

  const deductions = [
    ['fica_ss_employee', 'Social Security Employee', fica.ss, false],
    ['fica_medicare_employee', 'Medicare Employee', fica.medicare, false],
    ['federal_income_tax', 'Federal Income Tax', federalPeriod, false],
    ['indiana_state_tax', 'Indiana State Tax 3.05%', stateTax, false],
    ['fica_ss_employer', 'Social Security Employer', fica.ss, true],
    ['fica_medicare_employer', 'Medicare Employer', fica.medicare, true],
    ['futa', 'FUTA', futa, true],
    ['suta', 'SUTA Indiana', suta, true],
  ];

  for (const [type, desc, amt, isEmp] of deductions) {
    if (amt > 0) {
      await client.query(`
        INSERT INTO payroll_deductions (payroll_entry_id, company_id, deduction_type, description, amount, is_employer)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [entryId, companyId, type, desc, parseFloat(amt.toFixed(2)), isEmp]);
    }
  }

  return { gross_pay: grossPay, net_pay: netPay, total_deductions: totalDeductions,
           employer_burden: ficaEmployer + futa + suta };
}

// ─── PERIODS ──────────────────────────────────────────────────

router.get('/periods', async (req, res, next) => {
  try {
    const { company_id, country_code, status } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    let conditions = ['pp.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (country_code) { conditions.push(`pp.country_code = $${idx++}`); values.push(country_code); }
    if (status)       { conditions.push(`pp.status = $${idx++}`); values.push(status); }
    const result = await query(`
      SELECT pp.uuid, pp.period_number, pp.period_type, pp.country_code,
        pp.start_date, pp.end_date, pp.payment_date, pp.status,
        fp.name AS fiscal_period_name
      FROM payroll_periods pp
      LEFT JOIN fiscal_periods fp ON fp.id = pp.fiscal_period_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY pp.start_date DESC
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

router.post('/periods', async (req, res, next) => {
  try {
    const { company_id, period_type, country_code, start_date, end_date,
            payment_date, period_number, fiscal_period_uuid } = req.body;
    if (!company_id || !period_type || !country_code || !start_date || !end_date || !payment_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, period_type, country_code, start_date, end_date, payment_date' });
    const autoNumber = period_number || `${country_code}-${start_date.replace(/-/g,'')}`;
    let fpId = null;
    if (fiscal_period_uuid) {
      const fp = await query('SELECT id FROM fiscal_periods WHERE uuid=$1', [fiscal_period_uuid]);
      fpId = fp.rows[0]?.id || null;
    }
    const result = await query(`
      INSERT INTO payroll_periods
        (company_id, period_number, period_type, country_code,
         start_date, end_date, payment_date, fiscal_period_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING uuid, period_number, status
    `, [parseInt(company_id), autoNumber, period_type, country_code,
        start_date, end_date, payment_date, fpId, req.user.id]);
    res.status(201).json({ success: true, data: result.rows[0], message: 'Payroll period created.' });
  } catch(e) { next(e); }
});

// ─── RUNS ─────────────────────────────────────────────────────

router.get('/runs', async (req, res, next) => {
  try {
    const { company_id, status, employment_regime } = req.query;
    if (!company_id) return res.status(400).json({ success: false, error: 'company_id required' });
    let conditions = ['pr.company_id = $1'];
    let values = [parseInt(company_id)];
    let idx = 2;
    if (status)            { conditions.push(`pr.status = $${idx++}`); values.push(status); }
    if (employment_regime) { conditions.push(`pr.employment_regime = $${idx++}`); values.push(employment_regime); }
    const result = await query(`
      SELECT pr.uuid, pr.run_number, pr.employment_regime, pr.status,
        pr.total_gross, pr.total_net, pr.total_deductions, pr.total_employer_burden,
        pr.employee_count, pr.currency, pr.run_source, pr.created_at,
        pp.period_number, pp.start_date, pp.end_date, pp.payment_date
      FROM payroll_runs pr
      JOIN payroll_periods pp ON pp.id = pr.payroll_period_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY pr.created_at DESC
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

router.post('/runs', requirePermission('workforce.manage_payroll'), async (req, res, next) => {
  try {
    const { company_id, payroll_period_uuid, employment_regime, currency = 'MXN',
            run_source = 'web', source_reference, notes } = req.body;
    if (!company_id || !payroll_period_uuid || !employment_regime)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: company_id, payroll_period_uuid, employment_regime' });
    const period = await query('SELECT id, country_code FROM payroll_periods WHERE uuid=$1', [payroll_period_uuid]);
    if (!period.rows[0]) return res.status(404).json({ success: false, error: 'period_not_found' });
    const runNumber = await generateRunNumber();
    const result = await query(`
      INSERT INTO payroll_runs
        (company_id, payroll_period_id, run_number, country_code, employment_regime,
         currency, run_source, source_reference, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING uuid, run_number, status, employment_regime
    `, [parseInt(company_id), period.rows[0].id, runNumber, period.rows[0].country_code,
        employment_regime, currency, run_source, source_reference||null, notes||null, req.user.id]);
    writeAudit({ userId: req.user.id, action: 'payroll_run_created',
      entityType: 'payroll_runs', entityId: result.rows[0].uuid,
      companyId: parseInt(company_id), newValues: { run_number: runNumber, employment_regime },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.status(201).json({ success: true, data: result.rows[0], message: `Payroll run ${runNumber} created.` });
  } catch(e) { next(e); }
});

router.get('/runs/:uuid', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT pr.uuid, pr.run_number, pr.employment_regime, pr.status,
        pr.total_gross, pr.total_net, pr.total_deductions, pr.total_employer_burden,
        pr.employee_count, pr.currency, pr.run_source, pr.notes,
        pr.approved_at, pr.created_at,
        pp.period_number, pp.start_date, pp.end_date, pp.payment_date,
        c.name AS company_name
      FROM payroll_runs pr
      JOIN payroll_periods pp ON pp.id = pr.payroll_period_id
      JOIN companies c ON c.id = pr.company_id
      WHERE pr.uuid=$1
    `, [req.params.uuid]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    res.json({ success: true, data: result.rows[0] });
  } catch(e) { next(e); }
});

// POST /api/payroll/runs/:uuid/calculate
router.post('/runs/:uuid/calculate', requirePermission('workforce.manage_payroll'), async (req, res, next) => {
  try {
    // Pre-check: fast fail if run doesn't exist at all
    const preCheck = await query(
      'SELECT id FROM payroll_runs WHERE uuid=$1',
      [req.params.uuid]
    );
    if (!preCheck.rows[0]) return res.status(404).json({ success: false,
      error: 'not_found', message: 'Payroll run not found.' });

    let runId, company_id, employment_regime, start_date, end_date;
    let totalGross = 0, totalNet = 0, totalDeductions = 0, totalBurden = 0;
    let employeeCount = 0;
    let employees;

    await withTransaction(async (client) => {
      // LOCK: acquire row-level lock first to prevent concurrent calculate
      const run = await client.query(`
        SELECT pr.id, pr.company_id, pr.employment_regime, pr.currency,
          pr.status, pp.start_date, pp.end_date
        FROM payroll_runs pr
        JOIN payroll_periods pp ON pp.id = pr.payroll_period_id
        WHERE pr.uuid=$1
        FOR UPDATE
      `, [req.params.uuid]);

      // Re-read status AFTER acquiring lock
      if (!run.rows[0] || run.rows[0].status !== 'draft') {
        const status = run.rows[0]?.status || 'not_found';
        throw Object.assign(new Error('not_draft'), { statusCode: 400,
          body: { success: false, error: 'not_found_or_not_draft',
            message: `Run must be in draft status to calculate. Current status: ${status}` }});
      }

      ({ id: runId, company_id, employment_regime, start_date, end_date } = run.rows[0]);

      // Get eligible employees by regime
      const empResult = await client.query(`
        SELECT e.id, e.uuid AS emp_uuid, e.employee_number,
          CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal,e.last_name,'')) AS name,
          cr.amount AS salary, cr.pay_frequency, cr.currency AS comp_currency,
          ec.employment_regime AS contract_regime,
          ec.flsa_classification
        FROM employees e
        JOIN compensation_records cr ON cr.employee_id = e.id AND cr.end_date IS NULL
        JOIN employment_contracts ec ON ec.employee_id = e.id AND ec.is_current = true
        WHERE e.company_id = $1 AND e.status = 'active'
          AND ec.employment_regime = $2
          AND (e.termination_date IS NULL OR e.termination_date >= $3)
      `, [company_id, employment_regime, start_date]);
      employees = empResult;

      // Clear existing entries for this run
      await client.query('DELETE FROM payroll_deductions WHERE payroll_entry_id IN (SELECT id FROM payroll_entries WHERE payroll_run_id=$1)', [runId]);
      await client.query('DELETE FROM payroll_entries WHERE payroll_run_id=$1', [runId]);

      for (const emp of employees.rows) {
        // Get timesheet for period
        const ts = await client.query(`
          SELECT COALESCE(SUM(regular_hours),0) AS regular_hours,
            COALESCE(SUM(overtime_hours),0) AS overtime_hours,
            COALESCE(SUM(absence_hours),0) AS absence_hours,
            COALESCE(SUM(days_worked),0) AS days_worked,
            COALESCE(SUM(days_absent),0) AS days_absent
          FROM timesheet_summaries
          WHERE employee_id=$1
            AND (week_start, week_end) OVERLAPS ($2::date, $3::date)
        `, [emp.id, start_date, end_date]);

        const timesheet = ts.rows[0];
        // Split overtime into dobles/triples for MX
        const totalOT = parseFloat(timesheet.overtime_hours || 0);
        timesheet.overtime_hours_double = Math.min(totalOT, 9);
        timesheet.overtime_hours_triple = Math.max(0, totalOT - 9);

        // Holiday classification — MX statutory mandatory only
        // Source of truth: work_calendar_holiday_id + is_statutory=true
        // Legacy records (work_calendar_holiday_id IS NULL) → holiday_pay=0
        const holidayResult = await client.query(`
          SELECT COALESCE(SUM(ar.hours_worked), 0) AS statutory_holiday_hours
          FROM attendance_records ar
          JOIN work_calendar_holidays wch
            ON wch.id = ar.work_calendar_holiday_id
          WHERE ar.employee_id = $1
            AND ar.work_date BETWEEN $2 AND $3
            AND ar.work_calendar_holiday_id IS NOT NULL
            AND wch.is_statutory = true
            AND wch.country_code = 'MX'
            AND wch.company_id = $4
        `, [emp.id, start_date, end_date, company_id]);

        const statutoryHolidayHours = parseFloat(holidayResult.rows[0].statutory_holiday_hours || 0);

        // holiday_pay = premium only (2×); periodBase already covers base salary
        let holidayPay = 0;
        if (employment_regime === 'MX_IMSS' && statutoryHolidayHours > 0) {
          const dailyRate = parseFloat(emp.salary) / 30.4;
          const hourlyRate = dailyRate / 8;
          holidayPay = statutoryHolidayHours * hourlyRate * 2;
        }

        // Create entry shell
        const entry = await client.query(`
          INSERT INTO payroll_entries
            (payroll_run_id, employee_id, company_id, employment_regime,
             regular_hours, overtime_hours_double, overtime_hours_triple,
             absence_hours, days_worked, days_absent, currency,
             holiday_hours, holiday_pay)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          RETURNING id
        `, [runId, emp.id, company_id, employment_regime,
            timesheet.regular_hours, timesheet.overtime_hours_double,
            timesheet.overtime_hours_triple, timesheet.absence_hours,
            timesheet.days_worked, timesheet.days_absent,
            emp.comp_currency || 'MXN',
            statutoryHolidayHours.toFixed(2),
            holidayPay.toFixed(2)]);

        const entryId = entry.rows[0].id;
        let result;

        if (employment_regime === 'MX_IMSS') {
          // Pass holiday_pay to engine via timesheet object (augments grossPay)
          timesheet.holiday_pay = holidayPay;
          result = await calculateMXIMSS(client, entryId, emp.id, company_id,
            runId, parseFloat(emp.salary), emp.pay_frequency, timesheet);
          // Persist employer_burden per entry (certified engine result, no formula change)
          await client.query(
            'UPDATE payroll_entries SET total_employer_burden=$1 WHERE id=$2',
            [parseFloat(result.employer_burden || 0).toFixed(2), entryId]
          );
        } else if (employment_regime === 'US_W2') {
          // FLSA classification check — NULL is not a valid default
          if (!emp.flsa_classification) {
            throw Object.assign(new Error('flsa_classification_required'), { statusCode: 422,
              body: { success: false, error: 'flsa_classification_required',
                message: `Employee ${emp.emp_uuid} (${emp.name}) has no FLSA classification. ` +
                  `HR must set flsa_classification to 'exempt' or 'non_exempt' before payroll can be calculated.` }});
          }

          // Payroll period alignment check — must align with Monday-Sunday workweek
          const periodStartDay = new Date(start_date).getDay(); // 0=Sun, 1=Mon
          const periodEndDay = new Date(end_date).getDay();     // 0=Sun, 6=Sat
          const periodStartMon = (new Date(start_date).getDay() === 1);
          const periodEndSun = (new Date(end_date).getDay() === 0);
          if (!periodStartMon || !periodEndSun) {
            throw Object.assign(new Error('flsa_period_misaligned'), { statusCode: 422,
              body: { success: false, error: 'flsa_period_misaligned',
                message: `Payroll period ${start_date} → ${end_date} is not aligned with the configured FLSA workweek (Monday–Sunday). ` +
                  `FLSA calculation requires complete workweek boundaries. Partial-workweek handling is Phase 2B-4.` }});
          }

          // FLSA weekly aggregation — read individual weeks, not SUM
          // Each Monday-Sunday row evaluated independently per FLSA 29 CFR §778.105
          const flsaWeeks = await client.query(`
            SELECT week_start, week_end,
              regular_hours, overtime_hours, holiday_hours,
              absence_hours, days_worked, days_absent
            FROM timesheet_summaries
            WHERE employee_id=$1
              AND company_id=$2
              AND (week_start, week_end) OVERLAPS ($3::date, $4::date)
            ORDER BY week_start
          `, [emp.id, company_id, start_date, end_date]);

          let flsaRegularHours = 0;
          let flsaOTHours = 0;
          let totalAbsenceHours = 0;
          let totalDaysWorked = 0;
          let totalDaysAbsent = 0;

          for (const week of flsaWeeks.rows) {
            // worked_hours = actual hours (regular + daily-classified OT + holiday worked)
            // holiday_hours: Phase 2B-2 — hours actually worked on holiday → count toward FLSA 40h
            const workedHours = parseFloat(week.regular_hours || 0)
                              + parseFloat(week.overtime_hours || 0)
                              + parseFloat(week.holiday_hours || 0);

            if (emp.flsa_classification === 'non_exempt') {
              // FLSA weekly threshold: 40h per workweek
              flsaRegularHours += Math.min(workedHours, 40);
              flsaOTHours      += Math.max(workedHours - 40, 0);
            } else {
              // exempt: no FLSA OT regardless of hours worked
              flsaRegularHours += workedHours;
              flsaOTHours      += 0;
            }
            totalAbsenceHours += parseFloat(week.absence_hours || 0);
            totalDaysWorked   += parseInt(week.days_worked || 0);
            totalDaysAbsent   += parseInt(week.days_absent || 0);
          }

          // Update payroll_entries with FLSA-correct hours
          await client.query(`
            UPDATE payroll_entries SET
              regular_hours=$1, absence_hours=$2, days_worked=$3, days_absent=$4,
              updated_at=NOW()
            WHERE id=$5
          `, [flsaRegularHours.toFixed(2), totalAbsenceHours.toFixed(2),
              totalDaysWorked, totalDaysAbsent, entryId]);

          // Build FLSA timesheet object for calculateUSAW2()
          // Engine receives FLSA-correct values — no internal engine change
          const flsaTimesheet = {
            regular_hours: flsaRegularHours,
            overtime_hours: flsaOTHours,
            absence_hours: totalAbsenceHours,
            days_worked: totalDaysWorked,
            days_absent: totalDaysAbsent
          };

          const w4 = await client.query(`
            SELECT w4_filing_status AS filing_status, w4_dependents_amount AS dependents_amount,
              w4_other_income AS other_income, w4_deductions AS deductions,
              w4_extra_withholding AS extra_withholding
            FROM employee_tax_settings
            WHERE employee_id=$1 AND country_code='US' AND is_current=true
          `, [emp.id]);
          result = await calculateUSAW2(client, entryId, emp.id, company_id,
            parseFloat(emp.salary), emp.pay_frequency, flsaTimesheet, w4.rows[0] || {});
          // Persist employer_burden per entry
          await client.query(
            'UPDATE payroll_entries SET total_employer_burden=$1 WHERE id=$2',
            [parseFloat(result.employer_burden || 0).toFixed(2), entryId]
          );
        } else {
          // MX_HONORARIOS / US_1099 — gross only, no deductions
          const gross = parseFloat(emp.salary) * (emp.pay_frequency === 'weekly' ? 7/30.4 : 15/30.4);
          await client.query(`
            UPDATE payroll_entries SET gross_pay=$1, net_pay=$1, updated_at=NOW() WHERE id=$2
          `, [gross, entryId]);
          await client.query(
            'UPDATE payroll_entries SET total_employer_burden=0 WHERE id=$1', [entryId]
          );
          result = { gross_pay: gross, net_pay: gross, total_deductions: 0, employer_burden: 0 };
        }

        totalGross += result.gross_pay;
        totalNet += result.net_pay;
        totalDeductions += result.total_deductions;
        totalBurden += result.employer_burden;
        employeeCount++;
      }

      // Update run totals
      await client.query(`
        UPDATE payroll_runs SET
          total_gross=$1, total_net=$2, total_deductions=$3,
          total_employer_burden=$4, employee_count=$5,
          status='calculated', updated_at=NOW()
        WHERE id=$6
      `, [totalGross.toFixed(2), totalNet.toFixed(2),
          totalDeductions.toFixed(2), totalBurden.toFixed(2),
          employeeCount, runId]);
    });

    res.json({ success: true, data: {
      employee_count: employeeCount,
      total_gross: totalGross.toFixed(2),
      total_net: totalNet.toFixed(2),
      total_deductions: totalDeductions.toFixed(2),
      total_employer_burden: totalBurden.toFixed(2)
    }, message: `Payroll calculated for ${employeeCount} employees.` });
  } catch(e) {
    if (e.body) return res.status(e.statusCode || 400).json(e.body);
    next(e);
  }
});

// POST /api/payroll/runs/:uuid/approve
router.post('/runs/:uuid/approve', requirePermission('workforce.manage_payroll'), async (req, res, next) => {
  try {
    const preCheck = await query('SELECT id FROM payroll_runs WHERE uuid=$1', [req.params.uuid]);
    if (!preCheck.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    await withTransaction(async (client) => {
      // LOCK: prevent concurrent approve or calculate
      const run = await client.query(
        'SELECT id, company_id, status FROM payroll_runs WHERE uuid=$1 FOR UPDATE',
        [req.params.uuid]
      );
      if (run.rows[0].status !== 'calculated')
        throw Object.assign(new Error('invalid_status'), { statusCode: 400,
          body: { success: false, error: 'invalid_status',
            message: `Run must be calculated before approval. Current status: ${run.rows[0].status}` }});

      await client.query(`
        UPDATE payroll_runs SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
        WHERE uuid=$2
      `, [req.user.id, req.params.uuid]);
    });
    writeAudit({ userId: req.user.id, action: 'payroll_run_approved',
      entityType: 'payroll_runs', entityId: req.params.uuid,
      companyId: preCheck.rows[0].id, ip: req.ip, userAgent: req.get('user-agent') }).catch(()=>{});
    res.json({ success: true, message: 'Payroll run approved.' });
  } catch(e) {
    if (e.body) return res.status(e.statusCode || 400).json(e.body);
    next(e);
  }
});

// GET /api/payroll/runs/:uuid/entries
router.get('/runs/:uuid/entries', requirePermission('workforce.manage_payroll'), async (req, res, next) => {
  try {
    const run = await query('SELECT id FROM payroll_runs WHERE uuid=$1', [req.params.uuid]);
    if (!run.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT pe.uuid, pe.employment_regime, pe.regular_hours,
        pe.overtime_hours_double, pe.overtime_hours_triple,
        pe.days_worked, pe.days_absent,
        pe.base_salary_period, pe.overtime_pay, pe.absence_deduction,
        pe.regular_pay, pe.overtime_pay_usa,
        pe.gross_pay, pe.taxable_gross, pe.total_deductions, pe.net_pay,
        pe.currency, pe.sbc_daily, pe.sbc_monthly, pe.status,
        e.uuid AS employee_uuid, e.employee_number,
        CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal,e.last_name,'')) AS employee_name
      FROM payroll_entries pe
      JOIN employees e ON e.id = pe.employee_id
      WHERE pe.payroll_run_id=$1
      ORDER BY e.employee_number
    `, [run.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// ─── PROVISIONS ───────────────────────────────────────────────

router.get('/provisions/:employee_uuid', async (req, res, next) => {
  try {
    const { fiscal_year = new Date().getFullYear() } = req.query;
    const emp = await query('SELECT id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT uuid, provision_type, fiscal_year,
        accrued_amount, paid_amount, pending_amount, last_updated
      FROM annual_provisions
      WHERE employee_id=$1 AND fiscal_year=$2
      ORDER BY provision_type
    `, [emp.rows[0].id, parseInt(fiscal_year)]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/payroll/provisions/:employee_uuid/accrue
router.post('/provisions/:employee_uuid/accrue', async (req, res, next) => {
  try {
    const { provision_type, amount, fiscal_year = new Date().getFullYear(),
            payroll_run_uuid, source_period_start, source_period_end } = req.body;
    if (!provision_type || !amount)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: provision_type, amount' });
    const emp = await query('SELECT id, company_id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const { id: empId, company_id } = emp.rows[0];

    if (payroll_run_uuid) {
      // Idempotent accrual: same run + same provision_type + same fiscal_year = DO NOTHING
      const runRow = await query('SELECT id FROM payroll_runs WHERE uuid=$1 AND company_id=$2',
        [payroll_run_uuid, company_id]);
      if (!runRow.rows[0]) return res.status(400).json({ success: false, error: 'invalid_payroll_run',
        message: 'payroll_run_uuid not found or does not belong to this company.' });
      const runId = runRow.rows[0].id;

      await query(`
        INSERT INTO annual_provisions
          (employee_id, company_id, provision_type, fiscal_year,
           accrued_amount, payroll_run_id, source_period_start, source_period_end, last_updated)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE)
        ON CONFLICT (employee_id, provision_type, fiscal_year, payroll_run_id)
        DO NOTHING
      `, [empId, company_id, provision_type, parseInt(fiscal_year),
          parseFloat(amount), runId,
          source_period_start || null, source_period_end || null]);
    } else {
      // Legacy behavior: cumulative accrual without run reference
      await query(`
        INSERT INTO annual_provisions
          (employee_id, company_id, provision_type, fiscal_year, accrued_amount, last_updated)
        VALUES ($1,$2,$3,$4,$5,CURRENT_DATE)
        ON CONFLICT (employee_id, provision_type, fiscal_year) DO UPDATE SET
          accrued_amount = annual_provisions.accrued_amount + $5,
          last_updated = CURRENT_DATE, updated_at = NOW()
      `, [empId, company_id, provision_type, parseInt(fiscal_year), parseFloat(amount)]);
    }
    res.status(201).json({ success: true,
      message: `${provision_type} provision accrued: ${amount}`,
      idempotent: !!payroll_run_uuid });
  } catch(e) { next(e); }
});

// ─── TAX SETTINGS ─────────────────────────────────────────────

router.get('/tax-settings/:employee_uuid', async (req, res, next) => {
  try {
    const emp = await query('SELECT id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const result = await query(`
      SELECT uuid, country_code, w4_filing_status, w4_multiple_jobs,
        w4_dependents_amount, w4_other_income, w4_deductions, w4_extra_withholding,
        isr_calculation_method, subsidio_applies, effective_date, is_current
      FROM employee_tax_settings WHERE employee_id=$1 ORDER BY effective_date DESC
    `, [emp.rows[0].id]);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

router.post('/tax-settings/:employee_uuid', async (req, res, next) => {
  try {
    const { country_code, effective_date, w4_filing_status, w4_multiple_jobs,
            w4_dependents_amount, w4_other_income, w4_deductions, w4_extra_withholding,
            isr_calculation_method = 'progressive', subsidio_applies = true } = req.body;
    if (!country_code || !effective_date)
      return res.status(400).json({ success: false, error: 'validation_error',
        message: 'Required: country_code, effective_date' });
    const emp = await query('SELECT id, company_id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    const { id: empId, company_id } = emp.rows[0];
    await query(`UPDATE employee_tax_settings SET is_current=false WHERE employee_id=$1 AND country_code=$2`, [empId, country_code]);
    const result = await query(`
      INSERT INTO employee_tax_settings
        (employee_id, company_id, country_code, effective_date,
         w4_filing_status, w4_multiple_jobs, w4_dependents_amount,
         w4_other_income, w4_deductions, w4_extra_withholding,
         isr_calculation_method, subsidio_applies)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING uuid, country_code, effective_date
    `, [empId, company_id, country_code, effective_date,
        w4_filing_status||null, w4_multiple_jobs||false,
        w4_dependents_amount||0, w4_other_income||0,
        w4_deductions||0, w4_extra_withholding||0,
        isr_calculation_method, subsidio_applies]);
    res.status(201).json({ success: true, data: result.rows[0], message: 'Tax settings saved.' });
  } catch(e) { next(e); }
});

// ─── PAY STUBS ────────────────────────────────────────────────

router.get('/stubs/:employee_uuid', requirePermission('workforce.view_sensitive'), async (req, res, next) => {
  try {
    const { fiscal_year } = req.query;
    const emp = await query('SELECT id FROM employees WHERE uuid=$1', [req.params.employee_uuid]);
    if (!emp.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });
    let conditions = ['ps.employee_id = $1'];
    let values = [emp.rows[0].id];
    if (fiscal_year) {
      conditions.push(`EXTRACT(YEAR FROM ps.stub_date) = $2`);
      values.push(parseInt(fiscal_year));
    }
    const result = await query(`
      SELECT ps.uuid, ps.stub_date, ps.period_start, ps.period_end,
        ps.gross_pay, ps.net_pay, ps.currency, pr.run_number
      FROM pay_stubs ps
      JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ps.stub_date DESC
    `, values);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

// POST /api/payroll/runs/:uuid/generate-labor-costs
// Distributes approved payroll employer cost to projects via employee_project_allocations
router.post('/runs/:uuid/generate-labor-costs', requirePermission('workforce.manage_payroll'), async (req, res, next) => {
  try {
    // Auth: validate company access
    const runResult = await query(`
      SELECT pr.id, pr.uuid, pr.company_id, pr.status, pr.currency,
        pp.start_date, pp.end_date
      FROM payroll_runs pr
      JOIN payroll_periods pp ON pp.id = pr.payroll_period_id
      WHERE pr.uuid = $1
    `, [req.params.uuid]);
    if (!runResult.rows[0]) return res.status(404).json({ success: false, error: 'not_found' });

    const run = runResult.rows[0];
    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(run.company_id))
      return res.status(403).json({ success: false, error: 'forbidden' });

    // T5/T6: Only approved payroll generates labor costs
    if (run.status !== 'approved')
      return res.status(400).json({ success: false, error: 'invalid_status',
        message: `Labor costs can only be generated for approved payroll runs. Current status: ${run.status}` });

    // T13: Cancelled check (belt+suspenders — already excluded by approved check above)
    if (run.status === 'cancelled')
      return res.status(400).json({ success: false, error: 'cancelled_run',
        message: 'Cannot generate labor costs for a cancelled payroll run.' });

    // Get all payroll entries for this run
    const entries = await query(`
      SELECT pe.id, pe.uuid AS entry_uuid, pe.employee_id, pe.company_id,
        pe.gross_pay, pe.total_employer_burden, pe.currency, pe.employment_regime
      FROM payroll_entries pe
      WHERE pe.payroll_run_id = $1 AND pe.company_id = $2
    `, [run.id, run.company_id]);

    const results = { created: 0, updated: 0, skipped: 0, blocked: 0, warnings: [] };

    await withTransaction(async (client) => {
      for (const entry of entries.rows) {
        // Validate employee company isolation
        const empCheck = await client.query(
          'SELECT id, company_id FROM employees WHERE id=$1 AND company_id=$2',
          [entry.employee_id, run.company_id]
        );
        if (!empCheck.rows[0]) {
          results.warnings.push({ employee_id: entry.employee_id, reason: 'employee_company_mismatch' });
          results.skipped++;
          continue;
        }

        // Find valid allocations for this employee during payroll period
        const allocations = await client.query(`
          SELECT epa.id AS allocation_id, epa.project_id, epa.allocation_percent,
            epa.company_id AS alloc_company_id, p.company_id AS project_company_id,
            p.currency AS project_currency
          FROM employee_project_allocations epa
          JOIN projects p ON p.id = epa.project_id
          WHERE epa.employee_id = $1
            AND epa.company_id = $2
            AND epa.start_date <= $3
            AND (epa.end_date IS NULL OR epa.end_date >= $4)
        `, [entry.employee_id, run.company_id, run.end_date, run.start_date]);

        if (allocations.rows.length === 0) {
          results.warnings.push({ employee_id: entry.employee_id, reason: 'no_allocation' });
          results.skipped++;
          continue;
        }

        // T3/T12: Validate total allocation <= 100%
        const totalPct = allocations.rows.reduce((s, a) => s + parseFloat(a.allocation_percent), 0);
        if (totalPct > 100.001) {
          results.warnings.push({ employee_id: entry.employee_id,
            reason: 'allocation_exceeds_100', total_percent: totalPct });
          results.blocked++;
          continue;
        }

        const grossPay = parseFloat(entry.gross_pay || 0);
        const employerBurden = parseFloat(entry.total_employer_burden || 0);
        const totalLaborCost = grossPay + employerBurden;
        const currency = entry.currency || run.currency || 'MXN';

        for (const alloc of allocations.rows) {
          // T4/T8: Cross-company isolation
          if (alloc.project_company_id !== run.company_id) {
            results.warnings.push({ employee_id: entry.employee_id,
              project_id: alloc.project_id, reason: 'cross_company_project' });
            continue;
          }

          const pct = parseFloat(alloc.allocation_percent) / 100;
          const allocGross = parseFloat((grossPay * pct).toFixed(2));
          const allocBurden = parseFloat((employerBurden * pct).toFixed(2));
          const allocTotal = parseFloat((totalLaborCost * pct).toFixed(2));

          // T7/T8: Idempotent upsert
          const upsert = await client.query(`
            INSERT INTO project_labor_costs
              (project_id, company_id, employee_id, payroll_run_id, payroll_entry_id,
               allocation_id, allocation_percent, gross_pay, employer_burden,
               total_labor_cost, period_start, period_end, currency, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            ON CONFLICT (payroll_entry_id, project_id) DO UPDATE SET
              allocation_percent = EXCLUDED.allocation_percent,
              gross_pay = EXCLUDED.gross_pay,
              employer_burden = EXCLUDED.employer_burden,
              total_labor_cost = EXCLUDED.total_labor_cost
            RETURNING (xmax = 0) AS inserted
          `, [alloc.project_id, run.company_id, entry.employee_id,
              run.id, entry.id, alloc.allocation_id,
              parseFloat(alloc.allocation_percent), allocGross, allocBurden,
              allocTotal, run.start_date, run.end_date, currency, req.user.id]);

          if (upsert.rows[0]?.inserted) results.created++;
          else results.updated++;
        }
      }
    });

    // Update project_budget.actual_amount for category='labor' per affected project
    // Non-fatal: if project_budget row missing, skip silently
    try {
      const affectedProjects = await query(`
        SELECT DISTINCT project_id, company_id,
          SUM(total_labor_cost) AS total_labor
        FROM project_labor_costs
        WHERE payroll_run_id = $1
        GROUP BY project_id, company_id
      `, [run.id]);

      for (const proj of affectedProjects.rows) {
        const allLabor = await query(`
          SELECT COALESCE(SUM(total_labor_cost),0) AS total
          FROM project_labor_costs
          WHERE project_id=$1 AND company_id=$2
        `, [proj.project_id, proj.company_id]);

        await query(`
          INSERT INTO project_budget
            (project_id, company_id, category, actual_amount,
             budgeted_amount, committed_amount, currency, created_by)
          VALUES ($1,$2,'labor',$3,0,0,'USD',$4)
          ON CONFLICT (project_id, category) DO UPDATE SET
            actual_amount = $3, updated_at = NOW()
        `, [proj.project_id, proj.company_id,
            parseFloat(allLabor.rows[0].total).toFixed(2), req.user.id]);
      }
    } catch(budgetErr) {
      console.error('project_budget labor update failed (non-fatal):', budgetErr.message);
    }

    writeAudit({ userId: req.user.id, action: 'labor_costs_generated',
      entityType: 'payroll_runs', entityId: req.params.uuid,
      companyId: run.company_id,
      newValues: { created: results.created, updated: results.updated,
                   skipped: results.skipped, blocked: results.blocked },
      ip: req.ip, userAgent: req.get('user-agent') }).catch(() => {});

    res.json({ success: true, message: 'Labor costs generated.',
      data: { payroll_run_uuid: req.params.uuid,
        period: { start: run.start_date, end: run.end_date },
        ...results }});
  } catch(e) { next(e); }
});

// GET /api/payroll/labor-costs
router.get('/labor-costs', async (req, res, next) => {
  try {
    const { company_id, project_id, employee_id, payroll_run_uuid, period_start, period_end } = req.query;
    const authorizedCid = company_id ? parseInt(company_id) : req.user.company_id;
    const userCompanies = (req.user.company_access || [req.user.company_id]).map(Number);
    if (req.user.role !== 'super_admin' && !userCompanies.includes(authorizedCid))
      return res.status(403).json({ success: false, error: 'forbidden' });

    const conditions = ['plc.company_id = $1'];
    const values = [authorizedCid];
    let idx = 2;

    if (project_id)        { conditions.push(`plc.project_id = $${idx++}`); values.push(parseInt(project_id)); }
    if (employee_id)       { conditions.push(`plc.employee_id = $${idx++}`); values.push(parseInt(employee_id)); }
    if (payroll_run_uuid)  { conditions.push(`pr.uuid = $${idx++}`); values.push(payroll_run_uuid); }
    if (period_start)      { conditions.push(`plc.period_start >= $${idx++}`); values.push(period_start); }
    if (period_end)        { conditions.push(`plc.period_end <= $${idx++}`); values.push(period_end); }

    const result = await query(`
      SELECT plc.uuid, plc.project_id, plc.employee_id,
        plc.allocation_percent, plc.gross_pay, plc.employer_burden,
        plc.total_labor_cost, plc.period_start, plc.period_end, plc.currency,
        plc.created_at,
        p.name AS project_name,
        CONCAT(e.first_name,' ',COALESCE(e.last_name_paternal,e.last_name,'')) AS employee_name,
        pr.uuid AS payroll_run_uuid, pr.run_number, pr.status AS payroll_status
      FROM project_labor_costs plc
      JOIN projects p ON p.id = plc.project_id
      JOIN employees e ON e.id = plc.employee_id
      JOIN payroll_runs pr ON pr.id = plc.payroll_run_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY plc.period_start DESC, p.name, e.last_name_paternal
    `, values);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch(e) { next(e); }
});

module.exports = router;
