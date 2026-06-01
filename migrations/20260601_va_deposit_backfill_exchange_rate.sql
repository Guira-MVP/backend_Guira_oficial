-- ============================================================
-- Migration: va_deposit_backfill_exchange_rate
-- Purpose:
--   Reparar expedientes de depósitos en cuenta virtual (va_deposit) que se
--   crearon antes del fix del webhook y quedaron con campos sin poblar:
--     1. exchange_rate_applied = NULL  → el comprobante mostraba "Tasa de
--        Cambio: N/D" y el expediente del staff aparecía vacío.
--     2. flow_category = NULL           → el PDF mostraba "Categoría: N/D".
--
--   El depósito fiat → stablecoin (USD/EUR → USDC) de Bridge es a la par,
--   por lo que 1.0 es el valor correcto cuando no hubo conversión real.
--   Las órdenes nuevas ya se persisten correctamente desde el webhook.
-- Date: 2026-06-01
-- ============================================================

UPDATE payment_orders
SET exchange_rate_applied = 1.0
WHERE flow_type = 'va_deposit'
  AND exchange_rate_applied IS NULL;

UPDATE payment_orders
SET flow_category = 'inbound'
WHERE flow_type = 'va_deposit'
  AND flow_category IS NULL;
