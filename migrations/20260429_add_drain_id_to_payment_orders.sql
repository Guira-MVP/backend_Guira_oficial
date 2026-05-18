-- Campo para almacenar el drain_id de Bridge (vinculación webhook drain → expediente)
ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS bridge_drain_id TEXT;
