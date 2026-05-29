-- Snapshot del fee usado por expedientes que operan via Bridge Liquidation Address.
-- Mantiene trazabilidad aunque cambien fees_config o el fee de la LA despues.

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS fee_source TEXT,
  ADD COLUMN IF NOT EXISTS bridge_liquidation_address_id TEXT,
  ADD COLUMN IF NOT EXISTS bridge_liquidation_fee_percent NUMERIC;

CREATE INDEX IF NOT EXISTS idx_payment_orders_bridge_liquidation_address_id
  ON payment_orders (bridge_liquidation_address_id)
  WHERE bridge_liquidation_address_id IS NOT NULL;
