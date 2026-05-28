-- ============================================================
-- Migration: bridge_transfers_indexes
-- Date: 2026-05-28
--
-- Pre-apply audit (2026-05-28):
--   ALREADY EXISTS (no action needed):
--     idx_bridge_transfers_bridge_id        → btree(bridge_transfer_id) — non-unique
--     idx_bridge_transfers_user_id          → btree(user_id)
--     idx_bridge_transfers_user             → btree(user_id, created_at DESC)
--     idx_bridge_transfers_status           → btree(status)
--     idx_bridge_transfers_payout_request_id → btree(payout_request_id)
--
--   APPLIED BY THIS MIGRATION:
--     1. UNIQUE PARTIAL index on bridge_transfer_id (replaces non-unique one)
--     2. created_at DESC index for admin ORDER BY without user_id filter
-- ============================================================

-- 1. Promote bridge_transfer_id index to UNIQUE PARTIAL.
--    The existing idx_bridge_transfers_bridge_id is a plain btree (non-unique).
--    The unique constraint prevents two bridge_transfers rows pointing to the
--    same Bridge API transfer ID, which is the root cause of double-processing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_transfers_bridge_transfer_id
  ON bridge_transfers(bridge_transfer_id)
  WHERE bridge_transfer_id IS NOT NULL;

-- Drop the now-redundant non-unique index to avoid double maintenance overhead.
DROP INDEX IF EXISTS idx_bridge_transfers_bridge_id;

-- 2. Index for listAllTransfers ORDER BY created_at DESC without user_id filter.
--    The composite idx_bridge_transfers_user (user_id, created_at DESC) is NOT
--    used by the admin query because it has no user_id = ? predicate.
CREATE INDEX IF NOT EXISTS idx_bridge_transfers_created_at_desc
  ON bridge_transfers(created_at DESC);
