-- ============================================================
-- Fix: unique constraints de fees para incluir currency
-- ============================================================
-- customer_fee_overrides: el constraint actual (uq_active_fee_override)
-- solo cubre (user_id, operation_type, payment_rail), ignorando currency.
-- Esto permite overrides duplicados por divisa y causa que calculateFee()
-- devuelva el primero sin importar la divisa de la orden.
--
-- fees_config: no tenía constraint único, lo que podría generar filas
-- duplicadas para el mismo (operation_type, payment_rail, currency).
-- ============================================================

-- Verificar duplicados en customer_fee_overrides antes de continuar:
-- SELECT user_id, operation_type, payment_rail, currency, COUNT(*)
-- FROM customer_fee_overrides WHERE is_active = true
-- GROUP BY 1,2,3,4 HAVING COUNT(*) > 1;

-- 1. Eliminar el constraint incompleto de customer_fee_overrides
DROP INDEX IF EXISTS uq_active_fee_override;
DROP INDEX IF EXISTS customer_fee_overrides_user_operation_active_idx;

-- 2. Crear el constraint correcto que incluye currency
CREATE UNIQUE INDEX uq_active_fee_override_v2
  ON customer_fee_overrides (user_id, operation_type, payment_rail, currency)
  WHERE is_active = TRUE;

-- 3. Agregar unique constraint a fees_config para soportar múltiples
--    tarifas por operación (una por divisa) sin duplicados
CREATE UNIQUE INDEX IF NOT EXISTS uq_fees_config_active
  ON fees_config (operation_type, payment_rail, currency)
  WHERE is_active = TRUE;

-- 4. Corregir filas de fees_config con currency='usdt' cuando USDT está inactivo
--    (interbank_w2w y ramp_on_crypto deberían usar usdc)
UPDATE fees_config
SET currency = 'usdc', updated_at = now()
WHERE operation_type IN ('interbank_w2w', 'ramp_on_crypto')
  AND currency = 'usdt';
