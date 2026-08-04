-- ============================================================
-- Fees de bridge_wallet_to_fiat_us: origen -> destino (1/2)
-- ============================================================
-- Hasta ahora ramp_off_fiat_us se cobraba por la divisa de ORIGEN (el
-- token cripto que retira el cliente) con payment_rail fijo 'bridge' -- ACH
-- y Wire (y cualquier otro riel) siempre pagaban la misma comisión.
--
-- Se agregan 8 filas nuevas, una por cada combinación real de riel/divisa
-- de DESTINO, todas arrancando con el mismo 3% / min 0 / max 500 que tenía
-- la fila anterior (usdc/bridge) como punto de partida -- el staff las
-- ajusta luego una por una desde el panel.
--
-- Seguro de correr ANTES del deploy del backend nuevo: el código viejo solo
-- consulta payment_rail='bridge', estas filas nuevas no lo afectan.
-- Idempotente vía WHERE NOT EXISTS (el índice único uq_fees_config_active
-- es parcial WHERE is_active, no se puede usar ON CONFLICT directamente).
--
-- Las filas viejas (ramp_off_fiat_us/*/bridge) se desactivan en un segundo
-- archivo (20260804_deactivate_ramp_off_fiat_us_bridge_rows.sql) recién
-- después de confirmar que el backend nuevo está en producción.
-- ============================================================

INSERT INTO fees_config (operation_type, payment_rail, currency, fee_type, fee_percent, fee_fixed, min_fee, max_fee, is_active, description)
SELECT v.operation_type, v.payment_rail, v.currency, v.fee_type, v.fee_percent, v.fee_fixed, v.min_fee, v.max_fee, v.is_active, v.description
FROM (VALUES
  ('ramp_off_fiat_us', 'ach', 'usd', 'percent', 3, 0, 0, 500, true, 'Wallet -> Fiat US -- destino ACH (USD)'),
  ('ramp_off_fiat_us', 'wire', 'usd', 'percent', 3, 0, 0, 500, true, 'Wallet -> Fiat US -- destino Wire (USD)'),
  ('ramp_off_fiat_us', 'sepa', 'eur', 'percent', 3, 0, 0, 500, true, 'Wallet -> Fiat US -- destino SEPA (EUR)'),
  ('ramp_off_fiat_us', 'pix', 'brl', 'percent', 3, 0, 0, 500, true, 'Wallet -> Fiat US -- destino Pix (BRL)'),
  ('ramp_off_fiat_us', 'bre_b', 'cop', 'percent', 3, 0, 0, 500, true, 'Wallet -> Fiat US -- destino Bre-B (COP)'),
  ('ramp_off_fiat_us', 'co_bank_transfer', 'cop', 'percent', 3, 0, 0, 500, true, 'Wallet -> Fiat US -- destino transferencia bancaria (COP)'),
  ('ramp_off_fiat_us', 'faster_payments', 'gbp', 'percent', 3, 0, 0, 500, true, 'Wallet -> Fiat US -- destino Faster Payments (GBP)'),
  ('ramp_off_fiat_us', 'spei', 'mxn', 'percent', 3, 0, 0, 500, true, 'Wallet -> Fiat US -- destino SPEI (MXN)')
) AS v(operation_type, payment_rail, currency, fee_type, fee_percent, fee_fixed, min_fee, max_fee, is_active, description)
WHERE NOT EXISTS (
  SELECT 1 FROM fees_config fc
  WHERE fc.operation_type = v.operation_type
    AND fc.payment_rail = v.payment_rail
    AND fc.currency = v.currency
);
