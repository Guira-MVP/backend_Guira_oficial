-- ============================================================
-- Migration: backfill_untracked_payment_orders_columns
-- Purpose:
--   Versionar en el repo columnas de payment_orders que fueron agregadas
--   directamente en la base de datos vía MCP y que no tenían archivo de
--   migración correspondiente. Esto evita drift de esquema entre entornos.
--
--   Idempotente (IF NOT EXISTS): en la DB de producción ya existen y este
--   script no las recrea; en entornos nuevos/limpios las crea.
-- Date: 2026-06-01
-- ============================================================

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS sender_bank_name TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deposit_message  TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS exchange_rate    NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS exchange_fee     NUMERIC DEFAULT NULL;

COMMENT ON COLUMN payment_orders.sender_bank_name IS
  'Nombre del banco remitente (depósitos en cuenta virtual / VA).';
COMMENT ON COLUMN payment_orders.deposit_message IS
  'Mensaje/referencia de depósito asociado a la instrucción de pago.';
COMMENT ON COLUMN payment_orders.exchange_rate IS
  'Tasa de cambio cruda reportada por el proveedor (informativa). El valor que '
  'consume el comprobante PDF y el expediente es exchange_rate_applied.';
COMMENT ON COLUMN payment_orders.exchange_fee IS
  'Comisión de conversión propia del proveedor (Bridge), cuando aplica.';
