-- ============================================================
-- wallet_to_world: normalizar overrides de cliente no porcentuales
-- ============================================================
-- Acompaña a 20260918_wallet_to_world_flexible_amount.sql.
--
-- El flujo pasó a importe flexible: el transfer a Bridge viaja con
-- developer_fee_percent y features.flexible_amount, así que Bridge solo puede
-- aplicar un PORCENTAJE sobre el monto que reciba. Un fee_fixed no tiene forma
-- de expresarse en su API, y el backend rechaza el expediente si la tarifa
-- aplicable no es 'percent' (ver createWalletToWorld → getFeeConfigRow).
--
-- En PRODUCCIÓN había 3 overrides ACTIVOS con fee_type='mixed' en wire/usd
-- (1.8%+$15 y 1.5%+$15 x2). Sin esta conversión esos 3 clientes no habrían
-- podido crear expedientes wallet_to_world por Wire.
--
-- Decisión de negocio (confirmada antes del despliegue): se CONSERVA el
-- porcentaje pactado y se descarta el componente fijo. El cliente sigue
-- operando y paga algo menos; la alternativa (desactivar el override y caer al
-- 3% global) le habría subido la comisión.
--
-- Solo filas ACTIVAS: una inactiva no interviene en el cobro, y si alguien la
-- reactivara el backend fallaría de forma explícita en vez de cobrar de menos.
-- El panel de staff ya no permite elegir 'fijo'/'mixto' en esta operación.
--
-- Idempotente: el WHERE deja de encontrar filas en la segunda corrida.
-- Date: 2026-09-18
-- ============================================================

UPDATE customer_fee_overrides
SET fee_type = 'percent',
    fee_fixed = 0
WHERE operation_type = 'ramp_off_wallet_world'
  AND is_active = true
  AND fee_type <> 'percent';
