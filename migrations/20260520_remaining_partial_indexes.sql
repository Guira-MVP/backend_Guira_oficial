-- ============================================================
-- Migration: cleanup_and_add_remaining_partial_indexes
-- Purpose:
--   1. Cancel stale duplicate active orders blocking index creation.
--   2. Create partial unique indexes for the 5 remaining flows.
-- Date: 2026-05-20
-- ============================================================

-- ── Cleanup: bolivia_to_wallet ──
-- Keep: cf4a1ec3 (deposit_received, Apr 8 — más avanzada en pipeline)
-- Cancel: c801911a (waiting_deposit, Apr 13 — duplicado)
UPDATE payment_orders
SET status = 'cancelled',
    failure_reason = 'Cancelled by system: duplicate active order detected during idempotency migration'
WHERE id = 'c801911a-9d64-4af2-a9d2-d12c60a68832'
  AND status = 'waiting_deposit';

-- ── Cleanup: world_to_bolivia ──
-- Keep: a2b9fe0f (deposit_received, Apr 11 — más avanzada)
-- Cancel: las 3 en waiting_deposit (Apr 8, 9, 10)
UPDATE payment_orders
SET status = 'cancelled',
    failure_reason = 'Cancelled by system: duplicate active order detected during idempotency migration'
WHERE id IN (
    '8df665bd-c7e1-42fd-98fa-2ea7f64c59a9',
    '5e0f4162-e1c8-4196-9e82-916499deb7e6',
    '298e0e03-6f9c-4e90-bf7e-dc726ca6cf00'
)
  AND status = 'waiting_deposit';

-- ── 1. bolivia_to_wallet: 1 activa por destination_currency ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_po_b2w_active_per_dest_currency
  ON payment_orders (user_id, destination_currency)
  WHERE flow_type = 'bolivia_to_wallet'
    AND status IN ('waiting_deposit', 'deposit_received', 'processing');

-- ── 2. world_to_bolivia: 1 activa por destination_currency (siempre BOB) ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_po_w2b_active_per_dest_currency
  ON payment_orders (user_id, destination_currency)
  WHERE flow_type = 'world_to_bolivia'
    AND status IN ('waiting_deposit', 'deposit_received', 'processing');

-- ── 3. bridge_wallet_to_fiat_bo: 1 activa por source_currency ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_po_bw2fbo_active_per_src
  ON payment_orders (user_id, source_currency)
  WHERE flow_type = 'bridge_wallet_to_fiat_bo'
    AND status IN ('created', 'processing');

-- ── 4. bridge_wallet_to_crypto: 1 activa por source_currency + dest_network ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_po_bw2c_active_per_src_dest
  ON payment_orders (user_id, source_currency, destination_network)
  WHERE flow_type = 'bridge_wallet_to_crypto'
    AND status IN ('created', 'processing');

-- ── 5. bridge_wallet_to_fiat_us: 1 activa por source_currency + supplier ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_po_bw2fus_active_per_src_supplier
  ON payment_orders (user_id, source_currency, supplier_id)
  WHERE flow_type = 'bridge_wallet_to_fiat_us'
    AND status IN ('created', 'processing');
