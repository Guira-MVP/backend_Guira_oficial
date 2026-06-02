ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS deposit_reference_code TEXT;

COMMENT ON COLUMN payment_orders.deposit_reference_code IS
  'Código legible (G-DDMMYYYY-RRRRRR) que el cliente coloca en la referencia/concepto de su depósito PSAV. Usado por el staff para verificar que el comprobante corresponde al expediente.';
