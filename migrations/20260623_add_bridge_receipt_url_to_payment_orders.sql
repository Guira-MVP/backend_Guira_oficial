-- Agrega columna para almacenar el comprobante de recibo de Bridge (receipt.url).
-- Se separa de receipt_url para que receipt_url quede exclusivamente para el PDF del C.T.A.V.
-- bridge_receipt_url es de uso interno y solo se expone al staff via la API.
ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS bridge_receipt_url TEXT DEFAULT NULL;

COMMENT ON COLUMN payment_orders.bridge_receipt_url IS
  'URL del comprobante de recibo emitido por Bridge (receipt.url). '
  'Solo visible para staff via la API NestJS. No se expone al cliente. '
  'Se separa de receipt_url para que receipt_url quede exclusivamente para el PDF del C.T.A.V.';
