-- Agrega el identificador único del C.T.A.V. a las órdenes de pago.
-- Solo se genera para: bolivia_to_world, bolivia_to_wallet, fiat_bo_to_bridge_wallet.
ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS ctav_id UUID UNIQUE DEFAULT NULL;

COMMENT ON COLUMN payment_orders.ctav_id IS
  'UUID único del Comprobante de Transferencia de Activos Virtuales (C.T.A.V.). '
  'Solo aplica a flujos PSAV (bolivia_to_world, bolivia_to_wallet, fiat_bo_to_bridge_wallet). '
  'Se genera la primera vez que se produce el comprobante y se reutiliza en regeneraciones.';
