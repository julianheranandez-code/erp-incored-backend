'use strict';

/**
 * Shared Approval Engine v2 — Universal ERP Approval Framework
 * =============================================================
 * Sprint 3A: Policy-aware, multi-module, multi-country engine
 *
 * Used by:
 *   - src/routes/treasury1d.js   (Sprint 1D — Treasury Approvals)
 *   - src/routes/treasury2a.js   (Sprint 2A — Payment Requests)
 *   - src/routes/expenses.js     (Sprint 3B — Expenses)
 *   - src/routes/internal-pos.js (Sprint 3C — Internal POs)
 *   - src/routes/ap-bills.js     (Sprint 3D — AP Bills)
 *   - src/routes/ar-invoices.js  (Sprint 3E — AR Invoices)
 *
 * RULES:
 *   1. This is the ONLY source of truth for approval routing.
 *   2. Routing is based on company.approval_policy — NOT currency.
 *   3. Future policy versions: add new threshold objects + switch cases.
 *   4. No module may implement its own approval thresholds.
 */

const { query } = require('../config/database');

// ─── SUPPORTED APPROVAL TYPES ────────────────────────────────
const VALID_APPROVAL_TYPES = [
  // Treasury (Sprint 1D + 2A) — existing, backward compat
  'OPERATING_EXPENSE',
  'INTERNATIONAL_WIRE',
  'DEBT_PAYMENT',
  'PAYROLL',
  // Sprint 3 modules
  'EXPENSE',
  'AP_BILL',
  'INTERNAL_PO',
  'AR_INVOICE'
];

// ─── CONFIGURABLE THRESHOLDS ─────────────────────────────────

/**
 * MEXICO_V1 — Mexico approval thresholds
 * Future version: add MEXICO_V2 with updated values
 */
const THRESHOLDS_MEXICO_V1 = {
  EXPENSE: {
    LEVEL_1_MAX: 8000,    // Supervisor only
    LEVEL_2_MAX: 30000,   // + Operations Manager
    LEVEL_3_MAX: 90000    // + Accounting Manager; above = + Executive Approver
  },
  AP_BILL: {
    LEVEL_1_MAX: 200000   // ops_mgr+finance+accounting; above = + executive
  },
  INTERNAL_PO: {
    LEVEL_1_MAX: 200000   // procurement+accounting; above = + executive
  }
  // AR_INVOICE: no thresholds — always 2 levels
};

/**
 * USA_V1 — USA approval thresholds (existing Treasury matrices, unchanged)
 * Future version: add USA_V2 with updated values
 */
const THRESHOLDS_USA_V1 = {
  OPERATING_EXPENSE: {
    LEVEL_1_MAX: 1500,    // Supervisor only
    LEVEL_2_MAX: 6000,    // + Operations Manager
    LEVEL_3_MAX: 20000    // + Accounting Manager; above = + Executive Approver
  },
  INTERNATIONAL_WIRE: {
    LEVEL_1_MAX: 10000    // Accounting Manager only; above = + Executive Approver
  },
  DEBT_PAYMENT: {
    LEVEL_1_MAX: 25000    // Accounting Manager only; above = + Executive Approver
  }
};

// Export for testing and inspection
const APPROVAL_THRESHOLDS = {
  MEXICO_V1: THRESHOLDS_MEXICO_V1,
  USA_V1:    THRESHOLDS_USA_V1
};

// ─── ROUTING ENGINE ───────────────────────────────────────────

/**
 * Returns required approval chain for given type + amount + policy
 *
 * @param {string} approvalType
 *   OPERATING_EXPENSE | INTERNATIONAL_WIRE | DEBT_PAYMENT | PAYROLL
 *   EXPENSE | AP_BILL | INTERNAL_PO | AR_INVOICE
 *
 * @param {number|string} amount
 *
 * @param {string} [approvalPolicy='MEXICO_V1']
 *   Company-level policy: 'MEXICO_V1' | 'USA_V1'
 *   Fetched from: companies.approval_policy
 *   NOT derived from transaction currency
 *
 * @returns {Array<{level: number, role: string}>}
 * @throws {Error} if approvalType is not supported
 */
function getApprovalChain(approvalType, amount, approvalPolicy = 'MEXICO_V1') {
  const amt = parseFloat(amount);
  const policy = (approvalPolicy || 'MEXICO_V1').toUpperCase();

  // ── USA_V1 POLICY (existing Treasury matrices — backward compat) ──
  if (policy === 'USA_V1') {
    const T = THRESHOLDS_USA_V1;

    switch (approvalType) {
      case 'OPERATING_EXPENSE':
        if (amt <= T.OPERATING_EXPENSE.LEVEL_1_MAX) return [
          { level: 1, role: 'supervisor' }
        ];
        if (amt <= T.OPERATING_EXPENSE.LEVEL_2_MAX) return [
          { level: 1, role: 'supervisor' },
          { level: 2, role: 'operations_manager' }
        ];
        if (amt <= T.OPERATING_EXPENSE.LEVEL_3_MAX) return [
          { level: 1, role: 'supervisor' },
          { level: 2, role: 'operations_manager' },
          { level: 3, role: 'accounting_manager' }
        ];
        return [
          { level: 1, role: 'supervisor' },
          { level: 2, role: 'operations_manager' },
          { level: 3, role: 'accounting_manager' },
          { level: 4, role: 'executive_approver' }
        ];

      case 'INTERNATIONAL_WIRE':
        if (amt <= T.INTERNATIONAL_WIRE.LEVEL_1_MAX) return [
          { level: 1, role: 'accounting_manager' }
        ];
        return [
          { level: 1, role: 'accounting_manager' },
          { level: 2, role: 'executive_approver' }
        ];

      case 'DEBT_PAYMENT':
        if (amt <= T.DEBT_PAYMENT.LEVEL_1_MAX) return [
          { level: 1, role: 'accounting_manager' }
        ];
        return [
          { level: 1, role: 'accounting_manager' },
          { level: 2, role: 'executive_approver' }
        ];

      case 'PAYROLL':
        return [
          { level: 1, role: 'supervisor' },
          { level: 2, role: 'operations_manager' },
          { level: 3, role: 'accounting_manager' }
        ];

      // Sprint 3 types not yet configured for USA_V1
      case 'EXPENSE':
      case 'AP_BILL':
      case 'INTERNAL_PO':
      case 'AR_INVOICE':
        throw new Error(
          `USA_V1 approval matrix not configured for type: "${approvalType}". ` +
          `Configure a USA_V1 matrix in THRESHOLDS_USA_V1 before using this type.`
        );

      default:
        throw new Error(
          `Unsupported approval type: "${approvalType}" for policy: "${policy}". ` +
          `Valid types: ${VALID_APPROVAL_TYPES.join(', ')}`
        );
    }
  }

  // ── MEXICO_V1 POLICY (Sprint 3 modules + PAYROLL fallback) ──
  const T = THRESHOLDS_MEXICO_V1;

  switch (approvalType) {

    // ── TREASURY LEGACY TYPES (MEXICO_V1 compatibility) ──────────
    // OPERATING_EXPENSE — Mexico matrix (same thresholds as EXPENSE)
    case 'OPERATING_EXPENSE':
      if (amt <= T.EXPENSE.LEVEL_1_MAX) return [
        { level: 1, role: 'supervisor' }
      ];
      if (amt <= T.EXPENSE.LEVEL_2_MAX) return [
        { level: 1, role: 'supervisor' },
        { level: 2, role: 'operations_manager' }
      ];
      if (amt <= T.EXPENSE.LEVEL_3_MAX) return [
        { level: 1, role: 'supervisor' },
        { level: 2, role: 'operations_manager' },
        { level: 3, role: 'accounting_manager' }
      ];
      return [
        { level: 1, role: 'supervisor' },
        { level: 2, role: 'operations_manager' },
        { level: 3, role: 'accounting_manager' },
        { level: 4, role: 'executive_approver' }
      ];

    // INTERNATIONAL_WIRE — Temporary Mexico compatibility matrix
    // Replace with dedicated Mexico wire policy when approved
    case 'INTERNATIONAL_WIRE':
      if (amt <= 10000) return [
        { level: 1, role: 'accounting_manager' }
      ];
      return [
        { level: 1, role: 'accounting_manager' },
        { level: 2, role: 'executive_approver' }
      ];

    // DEBT_PAYMENT — Temporary Mexico compatibility matrix
    // Replace with dedicated Mexico debt policy when approved
    case 'DEBT_PAYMENT':
      if (amt <= 25000) return [
        { level: 1, role: 'accounting_manager' }
      ];
      return [
        { level: 1, role: 'accounting_manager' },
        { level: 2, role: 'executive_approver' }
      ];

    // EXPENSE (Sprint 3B)
    case 'EXPENSE':
      if (amt <= T.EXPENSE.LEVEL_1_MAX) return [
        { level: 1, role: 'supervisor' }
      ];
      if (amt <= T.EXPENSE.LEVEL_2_MAX) return [
        { level: 1, role: 'supervisor' },
        { level: 2, role: 'operations_manager' }
      ];
      if (amt <= T.EXPENSE.LEVEL_3_MAX) return [
        { level: 1, role: 'supervisor' },
        { level: 2, role: 'operations_manager' },
        { level: 3, role: 'accounting_manager' }
      ];
      return [
        { level: 1, role: 'supervisor' },
        { level: 2, role: 'operations_manager' },
        { level: 3, role: 'accounting_manager' },
        { level: 4, role: 'executive_approver' }
      ];

    // AP_BILL (Sprint 3D)
    case 'AP_BILL':
      if (amt <= T.AP_BILL.LEVEL_1_MAX) return [
        { level: 1, role: 'operations_manager' },
        { level: 2, role: 'finance' },
        { level: 3, role: 'accounting_manager' }
      ];
      return [
        { level: 1, role: 'operations_manager' },
        { level: 2, role: 'finance' },
        { level: 3, role: 'accounting_manager' },
        { level: 4, role: 'executive_approver' }
      ];

    // INTERNAL_PO (Sprint 3C)
    case 'INTERNAL_PO':
      if (amt <= T.INTERNAL_PO.LEVEL_1_MAX) return [
        { level: 1, role: 'procurement' },
        { level: 2, role: 'accounting_manager' }
      ];
      return [
        { level: 1, role: 'procurement' },
        { level: 2, role: 'accounting_manager' },
        { level: 3, role: 'executive_approver' }
      ];

    // AR_INVOICE (Sprint 3E) — no thresholds, always 2 levels
    case 'AR_INVOICE':
      return [
        { level: 1, role: 'accounting_manager' },
        { level: 2, role: 'finance' }
      ];

    // PAYROLL — same chain for both policies
    case 'PAYROLL':
      return [
        { level: 1, role: 'supervisor' },
        { level: 2, role: 'operations_manager' },
        { level: 3, role: 'accounting_manager' }
      ];

    default:
      throw new Error(
        `Unsupported approval type: "${approvalType}". ` +
        `Valid types: ${VALID_APPROVAL_TYPES.join(', ')}`
      );
  }
}

/**
 * Fetch company.approval_policy from DB
 * Use this helper in routes before calling getApprovalChain()
 * @param {number} companyId
 * @returns {Promise<string>} approval_policy e.g. 'MEXICO_V1'
 */
async function getCompanyApprovalPolicy(companyId) {
  const result = await query(
    `SELECT approval_policy FROM companies WHERE id=$1`, [companyId]
  );
  return result.rows[0]?.approval_policy || 'MEXICO_V1';
}

/**
 * Resolve actual users for each approval role from approval_role_assignments
 * @param {number} companyId
 * @param {Array<{level: number, role: string}>} chain
 * @returns {{ resolved: Array, missing: Array<string> }}
 */
async function resolveApprovers(companyId, chain) {
  const roles = chain.map(s => s.role);
  const assignments = await query(`
    SELECT ara.approval_role, ara.user_id,
      CONCAT(u.first_name,' ',u.last_name) AS user_name, u.email
    FROM approval_role_assignments ara
    JOIN users u ON u.id = ara.user_id
    WHERE ara.company_id=$1
      AND ara.approval_role = ANY($2::text[])
      AND ara.is_active=TRUE
  `, [companyId, roles]);

  const assignmentMap = {};
  for (const a of assignments.rows) assignmentMap[a.approval_role] = a;

  const resolved = [], missing = [];
  for (const step of chain) {
    const a = assignmentMap[step.role];
    if (!a) missing.push(step.role);
    else resolved.push({ ...step, user_id: a.user_id, user_name: a.user_name, email: a.email });
  }
  return { resolved, missing };
}

module.exports = {
  getApprovalChain,
  resolveApprovers,
  getCompanyApprovalPolicy,
  APPROVAL_THRESHOLDS,
  VALID_APPROVAL_TYPES
};
