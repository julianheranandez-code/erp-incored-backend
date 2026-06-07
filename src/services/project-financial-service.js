'use strict';

/**
 * Project Financial Service v3 — Sprint 4A.2
 * ============================================
 *
 * FINANCIAL EXPOSURE MODEL (No double counting):
 *
 * COMMITTED COST = outstanding approved obligations NOT yet paid
 *   IPO:       SUM(committed_amount) WHERE status IN (approved/partially_consumed/fully_consumed)
 *   AP Bills:  SUM(outstanding_balance) WHERE status IN ('approved','partially_paid')
 *              = total_amount - paid_amount for unpaid portion ONLY
 *   Expenses:  SUM(amount) WHERE status = 'payment_request_created'
 *              (NOT 'reimbursed' — that's in actual cash)
 *
 * ACTUAL CASH COST = cash already left the company
 *   AP Payments: SUM(ap_payments.amount) per project
 *   Expenses:    SUM(amount) WHERE status = 'reimbursed'
 *
 * TOTAL FINANCIAL EXPOSURE = committed_cost + actual_cash_cost
 *   → No double counting: each peso counted exactly once
 *
 * EXAMPLE:
 *   AP Bill $100k, paid $60k:
 *     committed  = $40k  (outstanding_balance)
 *     actual     = $60k  (ap_payments)
 *     exposure   = $100k ✅ (matches bill total, no double count)
 *
 *   Expense $10k, reimbursed:
 *     committed  = $0    (status='reimbursed' excluded)
 *     actual     = $10k  (status='reimbursed')
 *     exposure   = $10k ✅
 *
 *   Expense $10k, payment_request_created:
 *     committed  = $10k  (status='payment_request_created')
 *     actual     = $0
 *     exposure   = $10k ✅
 */

const { query } = require('../config/database');
const logger = require('../utils/logger');

// ─── FINANCIAL HEALTH ENGINE ─────────────────────────────────
function calculateFinancialHealth(actualCashCost, budgetCost, actualMargin) {
  if (!budgetCost || budgetCost <= 0) return 'NO_BUDGET';
  const consumption = (actualCashCost / budgetCost) * 100;
  if (actualMargin < 0)            return 'NEGATIVE_MARGIN';
  if (actualCashCost > budgetCost) return 'OVER_BUDGET';
  if (consumption >= 90)           return 'CRITICAL';
  if (consumption >= 80)           return 'AT_RISK';
  return 'HEALTHY';
}

// ─── CORE FINANCIAL SUMMARY ───────────────────────────────────
async function getProjectFinancialSummary(projectId) {
  const [project, ipoAgg, apBillsAgg, expCommittedAgg, apPaymentsAgg, expReimbursedAgg] = await Promise.all([

    query(`
      SELECT id, code, name, company_id, currency, status,
        COALESCE(contract_value, budget_amount, 0) AS contract_value,
        COALESCE(budget_cost, 0) AS budget_cost
      FROM projects WHERE id = $1
    `, [projectId]),

    // IPO committed (approved obligations)
    query(`
      SELECT COALESCE(SUM(committed_amount), 0) AS ipo_committed
      FROM internal_purchase_orders
      WHERE project_id=$1 AND status IN ('approved','partially_consumed','fully_consumed')
    `, [projectId]),

    // AP Bill outstanding balance (approved/partially_paid ONLY — excludes paid)
    // outstanding_balance = total_amount - paid_amount for unpaid portion
    query(`
      SELECT COALESCE(SUM(outstanding_balance), 0) AS ap_bill_balance
      FROM ap_bills
      WHERE project_id=$1 AND status IN ('approved','partially_paid')
    `, [projectId]),

    // Expense committed: ONLY payment_request_created (not yet reimbursed)
    query(`
      SELECT COALESCE(SUM(amount), 0) AS expense_committed
      FROM expenses
      WHERE project_id=$1 AND status = 'payment_request_created'
    `, [projectId]),

    // ACTUAL CASH: AP payments actually made
    query(`
      SELECT COALESCE(SUM(amount), 0) AS ap_cash_paid
      FROM ap_payments WHERE project_id=$1
    `, [projectId]),

    // ACTUAL CASH: Expenses actually reimbursed
    query(`
      SELECT COALESCE(SUM(amount), 0) AS expenses_reimbursed
      FROM expenses WHERE project_id=$1 AND status='reimbursed'
    `, [projectId])
  ]);

  if (!project.rows[0]) return null;

  const p = project.rows[0];
  const contractValue   = parseFloat(p.contract_value);
  const budgetCost      = parseFloat(p.budget_cost);

  // COMMITTED COST (outstanding obligations — not yet paid)
  const ipoCommitted          = parseFloat(ipoAgg.rows[0].ipo_committed);
  const approvedApBillBalance = parseFloat(apBillsAgg.rows[0].ap_bill_balance);
  const approvedExpenseBalance = parseFloat(expCommittedAgg.rows[0].expense_committed);
  const committedCost         = ipoCommitted + approvedApBillBalance + approvedExpenseBalance;

  // ACTUAL CASH COST (already paid)
  const apCashPaid         = parseFloat(apPaymentsAgg.rows[0].ap_cash_paid);
  const expensesReimbursed = parseFloat(expReimbursedAgg.rows[0].expenses_reimbursed);
  const actualCashCost     = apCashPaid + expensesReimbursed;

  // TOTAL FINANCIAL EXPOSURE (no double counting)
  const totalExposure    = committedCost + actualCashCost;

  // REMAINING BUDGET uses highest exposure
  const remainingBudget  = budgetCost > 0 ? budgetCost - totalExposure : null;

  const expectedMargin   = contractValue - budgetCost;
  const actualMargin     = contractValue - actualCashCost;
  const cashConsumptionPct = budgetCost > 0
    ? Math.round((actualCashCost / budgetCost) * 1000) / 10 : null;
  const marginPct = contractValue > 0
    ? Math.round((actualMargin / contractValue) * 1000) / 10 : null;

  const financialHealth  = calculateFinancialHealth(actualCashCost, budgetCost, actualMargin);

  // Additional budget visibility metrics (Sprint 4A.3)
  const remainingCommitmentBudget = budgetCost > 0 ? budgetCost - committedCost : null;
  const remainingCashBudget       = budgetCost > 0 ? budgetCost - actualCashCost : null;

  return {
    project_id:                     projectId,
    project_code:                   p.code,
    project_name:                   p.name,
    company_id:                     p.company_id,
    currency:                       p.currency,
    status:                         p.status,
    contract_value:                 contractValue,
    budget_cost:                    budgetCost,
    // Committed (outstanding obligations)
    ipo_committed:                  ipoCommitted,
    approved_ap_bill_balance:       approvedApBillBalance,
    approved_expense_balance:       approvedExpenseBalance,
    committed_cost:                 committedCost,
    // Actual cash paid
    ap_cash_paid:                   apCashPaid,
    expenses_reimbursed:            expensesReimbursed,
    actual_cash_cost:               actualCashCost,
    // Exposure
    total_financial_exposure:       totalExposure,
    remaining_budget:               remainingBudget,
    // Budget visibility (PMO + CFO)
    remaining_commitment_budget:    remainingCommitmentBudget,  // budget_cost - committed_cost
    remaining_cash_budget:          remainingCashBudget,        // budget_cost - actual_cash_cost
    // Margins
    expected_margin:                expectedMargin,
    actual_margin:                  actualMargin,
    margin_percent:                 marginPct,
    cash_consumption_percent:       cashConsumptionPct,
    financial_health:               financialHealth
  };
}

// ─── ALERT ENGINE ─────────────────────────────────────────────
async function generateProjectAlerts(projectId) {
  const summary = await getProjectFinancialSummary(projectId);
  if (!summary) return [];

  const alerts = [];
  const pct = summary.cash_consumption_percent;

  if (summary.actual_margin < 0) {
    alerts.push({ alert_type: 'negative_margin', severity: 'critical',
      message: `Project ${summary.project_code}: negative actual margin ${summary.actual_margin.toFixed(0)} ${summary.currency}`,
      budget_consumption_pct: pct });
  }
  if (summary.actual_cash_cost > summary.budget_cost && summary.budget_cost > 0) {
    alerts.push({ alert_type: 'over_budget', severity: 'critical',
      message: `Project ${summary.project_code}: actual cash exceeds budget by ${(summary.actual_cash_cost - summary.budget_cost).toFixed(0)} ${summary.currency}`,
      budget_consumption_pct: pct });
  } else if (pct >= 90) {
    alerts.push({ alert_type: 'budget_90pct', severity: 'critical',
      message: `Project ${summary.project_code}: ${pct}% cash budget consumed`,
      budget_consumption_pct: pct });
  } else if (pct >= 80) {
    alerts.push({ alert_type: 'budget_80pct', severity: 'warning',
      message: `Project ${summary.project_code}: ${pct}% cash budget consumed`,
      budget_consumption_pct: pct });
  }

  for (const alert of alerts) {
    await query(`
      INSERT INTO project_financial_alerts
        (project_id, company_id, alert_type, severity, message, budget_consumption_pct)
      SELECT $1,$2,$3,$4,$5,$6
      WHERE NOT EXISTS (
        SELECT 1 FROM project_financial_alerts
        WHERE project_id=$1 AND alert_type=$3 AND is_acknowledged=FALSE
          AND created_at > NOW() - INTERVAL '24 hours'
      )
    `, [projectId, summary.company_id, alert.alert_type,
        alert.severity, alert.message, alert.budget_consumption_pct]).catch(() => {});
  }

  return alerts;
}

// ─── PORTFOLIO DASHBOARD ──────────────────────────────────────
async function getPortfolioDashboard(companyId = null) {
  const where  = companyId ? 'WHERE p.company_id = $1' : '';
  const params = companyId ? [parseInt(companyId)] : [];

  const projects = await query(`
    SELECT
      p.id, p.code, p.name, p.status, p.currency,
      c.name AS client_name, co.name AS company_name,
      COALESCE(p.contract_value, p.budget_amount, 0) AS contract_value,
      COALESCE(p.budget_cost, 0) AS budget_cost,
      COALESCE(ipo.ipo_committed, 0)      AS ipo_committed,
      COALESCE(ab.ap_bill_balance, 0)     AS approved_ap_bill_balance,
      COALESCE(exp_c.exp_committed, 0)    AS approved_expense_balance,
      COALESCE(ap_p.ap_cash, 0)           AS ap_cash_paid,
      COALESCE(exp_r.exp_reimbursed, 0)   AS expenses_reimbursed
    FROM projects p
    LEFT JOIN clients c    ON c.id = p.client_id
    LEFT JOIN companies co ON co.id = p.company_id
    LEFT JOIN (
      SELECT project_id, SUM(committed_amount) AS ipo_committed
      FROM internal_purchase_orders
      WHERE status IN ('approved','partially_consumed','fully_consumed')
      GROUP BY project_id
    ) ipo ON ipo.project_id = p.id
    LEFT JOIN (
      SELECT project_id, SUM(outstanding_balance) AS ap_bill_balance
      FROM ap_bills WHERE status IN ('approved','partially_paid')
      GROUP BY project_id
    ) ab ON ab.project_id = p.id
    LEFT JOIN (
      SELECT project_id, SUM(amount) AS exp_committed
      FROM expenses WHERE status='payment_request_created'
      GROUP BY project_id
    ) exp_c ON exp_c.project_id = p.id
    LEFT JOIN (
      SELECT project_id, SUM(amount) AS ap_cash
      FROM ap_payments GROUP BY project_id
    ) ap_p ON ap_p.project_id = p.id
    LEFT JOIN (
      SELECT project_id, SUM(amount) AS exp_reimbursed
      FROM expenses WHERE status='reimbursed' GROUP BY project_id
    ) exp_r ON exp_r.project_id = p.id
    ${where}
    ORDER BY p.created_at DESC
  `, params);

  let totals = { contract_value:0, budget_cost:0, committed_cost:0,
                 actual_cash_cost:0, total_exposure:0 };
  const health = { HEALTHY:0, AT_RISK:0, CRITICAL:0, OVER_BUDGET:0,
                   NEGATIVE_MARGIN:0, NO_BUDGET:0 };

  const enriched = projects.rows.map(p => {
    const cv  = parseFloat(p.contract_value);
    const bc  = parseFloat(p.budget_cost);
    const cc  = parseFloat(p.ipo_committed) + parseFloat(p.approved_ap_bill_balance) + parseFloat(p.approved_expense_balance);
    const acc = parseFloat(p.ap_cash_paid) + parseFloat(p.expenses_reimbursed);
    const exp = cc + acc;
    const am  = cv - acc;
    const pct = bc > 0 ? Math.round((acc/bc)*1000)/10 : null;
    const fh  = calculateFinancialHealth(acc, bc, am);

    totals.contract_value  += cv;
    totals.budget_cost     += bc;
    totals.committed_cost  += cc;
    totals.actual_cash_cost += acc;
    totals.total_exposure  += exp;
    health[fh] = (health[fh] || 0) + 1;

    return { ...p,
      ipo_committed: parseFloat(p.ipo_committed),
      approved_ap_bill_balance: parseFloat(p.approved_ap_bill_balance),
      approved_expense_balance: parseFloat(p.approved_expense_balance),
      committed_cost: cc,
      ap_cash_paid: parseFloat(p.ap_cash_paid),
      expenses_reimbursed: parseFloat(p.expenses_reimbursed),
      actual_cash_cost: acc,
      total_financial_exposure: exp,
      remaining_budget: bc > 0 ? bc - exp : null,
      remaining_commitment_budget: bc > 0 ? bc - cc : null,
      remaining_cash_budget: bc > 0 ? bc - acc : null,
      expected_margin: cv - bc, actual_margin: am,
      margin_percent: cv > 0 ? Math.round((am/cv)*1000)/10 : null,
      cash_consumption_percent: pct, financial_health: fh };
  });

  return {
    summary: { total_projects: enriched.length, ...totals,
      total_expected_margin: totals.contract_value - totals.budget_cost,
      total_actual_margin: totals.contract_value - totals.actual_cash_cost,
      total_remaining_commitment_budget: totals.budget_cost - totals.committed_cost,
      total_remaining_cash_budget: totals.budget_cost - totals.actual_cash_cost,
      health_distribution: health },
    projects: enriched
  };
}

module.exports = { getProjectFinancialSummary, generateProjectAlerts,
                   getPortfolioDashboard, calculateFinancialHealth };
