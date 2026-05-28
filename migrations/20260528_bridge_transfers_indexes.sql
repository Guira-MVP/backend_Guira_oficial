-- ============================================================
-- Migration: bridge_transfers_indexes
-- Purpose:
--   Critical performance indexes for bridge_transfers table.
--   Without idx_bridge_transfers_bridge_transfer_id, every
--   transfer webhook triggers a full sequential scan.
-- Date: 2026-05-28
-- ============================================================

-- 1. Unique index on bridge_transfer_id (external ID from Bridge API).
--    Used by handleTransferComplete and handleTransferFailed on every webhook.
--    Partial: rows with NULL bridge_transfer_id are excluded (created records
--    that have not yet received a Bridge response).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_transfers_bridge_transfer_id
  ON bridge_transfers(bridge_transfer_id)
  WHERE bridge_transfer_id IS NOT NULL;

-- 2. Index on user_id — used by per-user transfer history queries.
CREATE INDEX IF NOT EXISTS idx_bridge_transfers_user_id
  ON bridge_transfers(user_id);

-- 3. Index on created_at DESC — used by listAllTransfers ORDER BY.
CREATE INDEX IF NOT EXISTS idx_bridge_transfers_created_at_desc
  ON bridge_transfers(created_at DESC);

-- 4. Partial index on status for non-terminal rows only.
--    Reduces index size; completed/failed transfers are read-only after settling.
CREATE INDEX IF NOT EXISTS idx_bridge_transfers_status_active
  ON bridge_transfers(status)
  WHERE status NOT IN ('completed', 'failed');
