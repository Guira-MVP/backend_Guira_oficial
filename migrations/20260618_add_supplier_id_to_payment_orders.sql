-- Agregar referencia al proveedor crypto seleccionado en órdenes bridge_wallet_to_crypto
-- Permite trazabilidad de qué proveedor pre-configurado se usó en cada transferencia.

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL;

COMMENT ON COLUMN payment_orders.supplier_id IS
  'Proveedor (supplier) seleccionado como destino. Aplica principalmente a bridge_wallet_to_crypto.';
