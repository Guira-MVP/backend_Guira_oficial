-- ============================================================
-- Migration: va_deposit_idempotency
-- Purpose:
--   1. Add deposit_id (Bridge's unique per-transaction ID) to payment_orders
--      for idempotency on virtual account deposits.
--   2. Add deposit_id to bridge_virtual_account_events for full traceability.
--   3. Add va_deposit_status to payment_orders to track the full Bridge
--      lifecycle: funds_received → payment_submitted → payment_processed.
-- Date: 2026-05-01
-- ============================================================

-- 1. payment_orders: add deposit_id (Bridge's deposit_id field)
ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS deposit_id TEXT DEFAULT NULL;

-- Unique index to prevent double-processing of the same VA deposit
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_deposit_id_unique
  ON payment_orders (deposit_id)
  WHERE deposit_id IS NOT NULL;

-- 2. payment_orders: track the Bridge event lifecycle for VA deposits
ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS va_deposit_status TEXT DEFAULT NULL;

COMMENT ON COLUMN payment_orders.deposit_id IS
  'Bridge deposit_id — unique per VA transaction (links funds_received → payment_processed events).';
COMMENT ON COLUMN payment_orders.va_deposit_status IS
  'Bridge lifecycle state for VA deposits: funds_received | payment_submitted | payment_processed | in_review | refunded | refund_in_flight | refund_failed';

-- 3. bridge_virtual_account_events: add deposit_id for cross-event linking
ALTER TABLE bridge_virtual_account_events
  ADD COLUMN IF NOT EXISTS deposit_id TEXT DEFAULT NULL;

COMMENT ON COLUMN bridge_virtual_account_events.deposit_id IS
  'Bridge deposit_id — links multiple events for the same source transaction.';

-- Index for fast lookup by deposit_id
CREATE INDEX IF NOT EXISTS idx_bridge_va_events_deposit_id
  ON bridge_virtual_account_events (deposit_id)
  WHERE deposit_id IS NOT NULL;

-- 4. bridge_virtual_account_events: add payment_rail for reconciliation
ALTER TABLE bridge_virtual_account_events
  ADD COLUMN IF NOT EXISTS payment_rail TEXT DEFAULT NULL;

COMMENT ON COLUMN bridge_virtual_account_events.payment_rail IS
  'Source payment rail: ach_push | wire | sepa | faster_payments | spei | pix';
