-- ============================================================
-- Migration: add_audit_logs_indexes
-- Purpose:
--   1. Add performance indexes to audit_logs table (no indexes existed)
--   2. Solve "canceling statement due to statement timeout" errors
--   3. Enable efficient paginated queries with filtering + ordering
-- Date: 2026-05-27
-- ============================================================

-- ── Core index: ORDER BY created_at DESC dominates every query ──
-- Without this, every query does a full table scan + sort.
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs (created_at DESC);

-- ── Filter indexes for the 3 supported WHERE clauses ──
-- Partial indexes skip NULLs to save space.
CREATE INDEX IF NOT EXISTS idx_audit_logs_performed_by
  ON audit_logs (performed_by)
  WHERE performed_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
  ON audit_logs (action)
  WHERE action IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_table_name
  ON audit_logs (table_name)
  WHERE table_name IS NOT NULL;

-- ── Composite: most common filter combo (actor + time) ──
-- SELECT ... WHERE performed_by = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_audit_logs_performed_created
  ON audit_logs (performed_by, created_at DESC)
  WHERE performed_by IS NOT NULL;
