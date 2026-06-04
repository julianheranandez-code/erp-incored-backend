'use strict';

/**
 * Shared Approval Engine — Single Source of Truth
 * ================================================
 * Used by:
 *   - src/routes/treasury1d.js (Sprint 1D)
 *   - src/routes/treasury2a.js (Sprint 2A)
 *
 * DO NOT duplicate this logic elsewhere.
 * Future threshold changes: update APPROVAL_THRESHOLDS only.
 */

const { query } = require('../config/database');

// ─── CONFIGURABLE THRESHOLDS ─────────────────────────────────
const APPROVAL_THRESHOLDS = {
  OPERATING_EXPENSE: {
    LEVEL_1_MAX: 1500,   // Supervisor only
    LEVEL_2_MAX: 6000,   // + Operations Manager
    LEVEL_3_MAX: 20000   // + Accounting Manager; above = + Executive Approver
  },
  INTERNATIONAL_WIRE: {
    LEVEL_1_MAX: 10000   // Accounting Manager only; above = + Executive Approver
  },
  DEBT_PAYMENT: {
    LEVEL_1_MAX: 25000   // Accounting Manager only; above = + Executive Approver
  }
};

// ─── ROUTING ENGINE ───────────────────────────────────────────
/**
 * Returns required approval chain for given type + amount
 * @param {string} approvalType - OPERATING_EXPENSE | INTERNATIONAL_WIRE | DEBT_PAYMENT | PAYROLL
 * @param {number|string} amount
 * @returns {Array<{level: number, role: string}>}
 */
function getApprovalChain(approvalType, amount) {
  const amt = parseFloat(amount);
  const T = APPROVAL_THRESHOLDS;

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

    default:
      return [{ level: 1, role: 'accounting_manager' }];
  }
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

module.exports = { getApprovalChain, resolveApprovers, APPROVAL_THRESHOLDS };
