-- ============================================================
-- MIGRATION: treasury-1d-hardening.sql
-- Treasury Sprint 1D — Approval Assignment Governance
-- ============================================================
-- Purpose:
--   Formalize the unique active assignment index in source control.
--   Index already exists in production (created via DBeaver).
--   This migration is idempotent — safe to run multiple times.
-- ============================================================

-- APPLY
-- Prevent multiple active approvers for the same company_id + approval_role
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_assignment
ON approval_role_assignments(company_id, approval_role)
WHERE is_active = TRUE;

-- ============================================================
-- ROLLBACK (run manually if needed)
-- DROP INDEX IF EXISTS uq_active_assignment;
-- ============================================================

-- VALIDATION
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'approval_role_assignments'
  AND indexname = 'uq_active_assignment';

-- Expected result:
-- uq_active_assignment | CREATE UNIQUE INDEX uq_active_assignment
--   ON public.approval_role_assignments USING btree (company_id, approval_role)
--   WHERE (is_active = true)
