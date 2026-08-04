-- ============================================================
-- Fees de bridge_wallet_to_fiat_us: origen -> destino (2/2)
-- ============================================================
-- Aplicar SOLO despues de confirmar que el backend con el cambio de
-- calculateFee(..., supplier.payment_rail, destCurrency, ...) esta en
-- produccion (ver 20260804_add_ramp_off_fiat_us_destination_fee_rows.sql,
-- que ya sembro las 8 filas de destino real que reemplazan a estas).
--
-- Se desactivan (no se borran, por trazabilidad historica de ordenes
-- pasadas que sí usaron payment_rail='bridge') las filas viejas indexadas
-- por moneda de origen.
-- ============================================================

UPDATE fees_config
SET is_active = false, updated_at = now()
WHERE operation_type = 'ramp_off_fiat_us'
  AND payment_rail = 'bridge'
  AND is_active = true;
