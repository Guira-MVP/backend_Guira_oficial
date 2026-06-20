-- Índice parcial para la detección eficiente de órdenes world_to_bolivia activas
-- por divisa de origen. Soporta assertNoConflictingWorldToBoliviaOrder().
-- Permite que un usuario tenga una orden activa por divisa (USD→BOB y EUR→BOB
-- simultáneamente), igual que bolivia_to_world permite una por divisa destino.

CREATE INDEX IF NOT EXISTS idx_po_w2b_active_per_src_currency
  ON payment_orders (user_id, flow_type, currency)
  WHERE flow_type = 'world_to_bolivia'
    AND status IN ('waiting_deposit', 'deposit_received', 'processing');
