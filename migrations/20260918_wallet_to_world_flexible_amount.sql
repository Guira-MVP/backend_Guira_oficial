-- ============================================================
-- wallet_to_world: importe flexible — normalizar tarifas
-- ============================================================
-- El flujo pasa de monto fijo (amount + developer_fee absoluto) a importe
-- flexible (features.flexible_amount + developer_fee_percent). Con ese cambio
-- Bridge solo entiende un PORCENTAJE: aplica developer_fee_percent sobre el
-- monto que realmente reciba en la dirección de depósito.
--
-- Consecuencia para fees_config: min_fee y max_fee dejan de tener efecto en
-- este flujo. No hay forma de expresarlos en la API de Bridge y el backend ya
-- no los usa (createWalletToWorld no llama a calculateFee cuando no hay monto).
-- Se ponen en 0 para que el panel de staff no muestre un tope que en realidad
-- nunca se aplica — un max_fee de 500 visible pero inoperante es peor que no
-- tener ninguno.
--
-- NO se toca fee_type ni fee_percent: las 8 filas ya son 'percent' y ese
-- porcentaje es justamente el que se envía a Bridge.
--
-- El backend rechaza la creación del expediente si la tarifa aplicable no es
-- 'percent' (ver createWalletToWorld → getFeeConfigRow), así que una fila
-- 'fixed'/'mixed' aquí deshabilitaría el destino en vez de cobrar de menos.
--
-- Idempotente: el UPDATE deja el mismo estado si se corre dos veces.
-- Date: 2026-09-18
-- ============================================================

UPDATE fees_config
SET min_fee = 0,
    max_fee = 0
WHERE operation_type = 'ramp_off_wallet_world';
