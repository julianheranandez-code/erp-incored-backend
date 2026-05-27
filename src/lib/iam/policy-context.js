'use strict';

/**
 * Policy Context Engine — IAM Phase 2B
 * ───────────────────────────────────────
 * Future-ready governance extension point.
 * Current mode: rbac_only — RBAC is authoritative.
 *
 * FUTURE ABAC CAPABILITIES (not yet implemented):
 *   - Amount-sensitive approval validation
 *   - Own-record governance
 *   - Project-scoped permissions
 *   - Time-bound access windows
 *   - Delegated approval chains
 *   - Emergency access with audit trail
 *   - Resource-instance-level permissions
 *   - Conditional access policies
 */

/**
 * OBS 3: Normalized PolicyEvaluationResult schema
 *
 * authoritative=false means RBAC remains in control.
 * When ABAC is implemented, set authoritative=true to override RBAC.
 *
 * governance_flags expose context for UI/audit without changing allow/deny.
 */
function buildPolicyResult({ allowed = true, authoritative = false, reason = 'rbac_only_mode',
                              mode = 'rbac_only', governance_flags = {}, metadata = {} } = {}) {
  return {
    allowed,
    authoritative,
    mode,
    reason,
    governance_flags: {
      requires_secondary_approval:      governance_flags.requires_secondary_approval      || false,
      approval_limit_exceeded:          governance_flags.approval_limit_exceeded          || false,
      ownership_validation_required:    governance_flags.ownership_validation_required    || false,
      project_scope_validation_required: governance_flags.project_scope_validation_required || false,
      ...governance_flags
    },
    metadata: {
      evaluated_at: new Date().toISOString(),
      ...metadata
    }
  };
}

/**
 * Evaluate policy context for a permission request.
 * RBAC remains authoritative until authoritative=true is returned.
 *
 * @param {Object} ctx
 * @param {Object} ctx.user         - { id, role }
 * @param {string} ctx.permission   - 'treasury.approve_transfer'
 * @param {string} ctx.resource     - 'treasury'
 * @param {string} ctx.action       - 'approve_transfer'
 * @param {number} ctx.companyId
 * @param {Object} ctx.metadata     - { amount, record_id, project_id, ... }
 */
async function evaluatePolicyContext({
  user, permission, resource, action, companyId, metadata = {}
}) {
  // ── Current: RBAC-only mode ───────────────────────────────
  // authoritative=false → RBAC continues to control access.
  //
  // TODO Phase 3: Implement ABAC here:
  //
  // 1. Amount-sensitive:
  //    if (metadata.amount > approvalLimit) return buildPolicyResult({ allowed: false, authoritative: true, reason: 'approval_limit_exceeded' })
  //
  // 2. Own-record:
  //    if (action === 'edit' && metadata.record_owner_id !== user.id) return buildPolicyResult({ allowed: false, authoritative: true, reason: 'not_record_owner' })
  //
  // 3. Project-scoped:
  //    if (metadata.project_id && !userProjects.includes(metadata.project_id)) return buildPolicyResult({ allowed: false, authoritative: true, reason: 'project_not_assigned' })

  return buildPolicyResult({
    allowed: true,
    authoritative: false,
    mode: 'rbac_only',
    reason: 'rbac_only_mode',
    metadata: { permission, resource, action, company_id: companyId }
  });
}

module.exports = { evaluatePolicyContext, buildPolicyResult };
