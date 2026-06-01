-- ============================================================
-- Migration: allow_inbound_flow_category
-- Purpose:
--   El flujo va_deposit (depósito en cuenta virtual) es una categoría
--   "inbound" que ya se emite por WebSocket (OrdersGateway), pero el CHECK
--   constraint de payment_orders.flow_category solo permitía 'interbank' y
--   'wallet_ramp'. Esto bloqueaba persistir flow_category='inbound' en el
--   webhook y dejaba la "Categoría" del comprobante en N/D.
-- Date: 2026-06-01
-- ============================================================

ALTER TABLE payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_flow_category_check;

ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_flow_category_check
  CHECK (
    flow_category IS NULL
    OR flow_category = ANY (ARRAY['interbank'::text, 'wallet_ramp'::text, 'inbound'::text])
  );
