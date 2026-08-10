-- ============================================================
-- wallet_to_world (2/4): comisiones globales por riel de destino
-- ============================================================
-- operation_type nuevo y propio del flujo: ramp_off_wallet_world.
-- No comparte tarifas con ramp_off_fiat_us -- el coste on-chain es distinto
-- y el staff debe poder tarifar cada uno por separado.
--
-- Se cobra por la combinación riel/divisa de DESTINO (igual que la versión
-- nueva de ramp_off_fiat_us), no por el token de origen: ACH y Wire pueden
-- tener comisiones distintas aunque el cliente envíe el mismo USDC.
--
-- IMPORTANTE: estas 8 filas son además el INTERRUPTOR DE REGIÓN del flujo.
-- Poner una en is_active=false retira esa región del wizard del cliente y
-- hace que el backend rechace la operación con un error claro
-- (ver assertFeeConfigured en fees.service.ts).
--
-- Debe correr ANTES de que el staff intente inicializar overrides por
-- cliente: initOperationOverrides() lee estas filas y lanza NotFoundException
-- si no encuentra ninguna.
--
-- Idempotente vía WHERE NOT EXISTS (el índice único uq_fees_config_active es
-- parcial WHERE is_active, no se puede usar ON CONFLICT directamente).
-- ============================================================

INSERT INTO fees_config (operation_type, payment_rail, currency, fee_type, fee_percent, fee_fixed, min_fee, max_fee, is_active, description)
SELECT v.operation_type, v.payment_rail, v.currency, v.fee_type, v.fee_percent, v.fee_fixed, v.min_fee, v.max_fee, v.is_active, v.description
FROM (VALUES
  ('ramp_off_wallet_world', 'ach', 'usd', 'percent', 3, 0, 0, 500, true, 'Wallet externa -> Exterior -- destino ACH (USD)'),
  ('ramp_off_wallet_world', 'wire', 'usd', 'percent', 3, 0, 0, 500, true, 'Wallet externa -> Exterior -- destino Wire (USD)'),
  ('ramp_off_wallet_world', 'sepa', 'eur', 'percent', 3, 0, 0, 500, true, 'Wallet externa -> Exterior -- destino SEPA (EUR)'),
  ('ramp_off_wallet_world', 'pix', 'brl', 'percent', 3, 0, 0, 500, true, 'Wallet externa -> Exterior -- destino Pix (BRL)'),
  ('ramp_off_wallet_world', 'bre_b', 'cop', 'percent', 3, 0, 0, 500, true, 'Wallet externa -> Exterior -- destino Bre-B (COP)'),
  ('ramp_off_wallet_world', 'co_bank_transfer', 'cop', 'percent', 3, 0, 0, 500, true, 'Wallet externa -> Exterior -- destino transferencia bancaria (COP)'),
  ('ramp_off_wallet_world', 'faster_payments', 'gbp', 'percent', 3, 0, 0, 500, true, 'Wallet externa -> Exterior -- destino Faster Payments (GBP)'),
  ('ramp_off_wallet_world', 'spei', 'mxn', 'percent', 3, 0, 0, 500, true, 'Wallet externa -> Exterior -- destino SPEI (MXN)')
) AS v(operation_type, payment_rail, currency, fee_type, fee_percent, fee_fixed, min_fee, max_fee, is_active, description)
WHERE NOT EXISTS (
  SELECT 1 FROM fees_config fc
  WHERE fc.operation_type = v.operation_type
    AND fc.payment_rail = v.payment_rail
    AND fc.currency = v.currency
);
