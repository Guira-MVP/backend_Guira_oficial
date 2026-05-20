-- ============================================================
-- Migration: idempotency_keys_and_partial_indexes
-- Purpose:
--   1. Create idempotency_keys table for deduplicating POST requests.
--   2. Add partial unique indexes on payment_orders to prevent
--      conflicting active orders at the DB level (defense in depth).
--   3. Normalize destination_currency to uppercase.
-- Date: 2026-05-20
-- ============================================================

-- 1. Idempotency keys table
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    response_status INT NOT NULL DEFAULT 201,
    response_body JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    CONSTRAINT idempotency_keys_user_key_unique UNIQUE (user_id, idempotency_key)
);

COMMENT ON TABLE idempotency_keys IS
  'Stores idempotency keys for POST endpoints to prevent duplicate resource creation.';
COMMENT ON COLUMN idempotency_keys.idempotency_key IS
  'Client-generated UUID sent via Idempotency-Key header.';
COMMENT ON COLUMN idempotency_keys.response_body IS
  'Cached response body returned on duplicate requests.';
COMMENT ON COLUMN idempotency_keys.expires_at IS
  'Keys expire after 24h to allow legitimate retries later.';

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
  ON idempotency_keys (expires_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY idempotency_keys_user_policy ON idempotency_keys
  FOR ALL USING (user_id = auth.uid());

-- 2. Normalize all destination_currency values to uppercase
UPDATE payment_orders
SET destination_currency = UPPER(destination_currency)
WHERE destination_currency IS NOT NULL
  AND destination_currency <> UPPER(destination_currency);

-- 3. Partial unique index: prevent two active bolivia_to_world orders
--    towards the same destination currency for the same user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_po_btw_active_per_currency
  ON payment_orders (user_id, destination_currency)
  WHERE flow_type = 'bolivia_to_world'
    AND status IN ('waiting_deposit', 'deposit_received', 'processing');

-- 4. Partial unique index: prevent two active Bridge deposit orders
--    on the same source rail for the same user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_po_bridge_active_per_rail
  ON payment_orders (user_id, source_network, source_currency)
  WHERE status = 'waiting_deposit'
    AND bridge_transfer_id IS NOT NULL
    AND flow_type IN ('fiat_bo_to_bridge_wallet', 'crypto_to_bridge_wallet', 'wallet_to_wallet');
