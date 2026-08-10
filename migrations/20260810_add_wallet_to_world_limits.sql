-- ============================================================
-- Migration: add_wallet_to_world_limits
-- Purpose:
--   wallet_to_world (3/4) — límites mínimo y máximo del servicio nuevo.
--
--   getGlobalLimits() (payment-orders.service.ts) deriva las claves como
--   MIN_${flow_type.toUpperCase()}_USD / MAX_${...}. Si las filas no existen
--   cae a un máximo por defecto de 999999, dejando el flujo prácticamente
--   sin techo — por eso esta migración es necesaria, no opcional.
--
--   Se arranca con el mismo par que Bridge Wallet → Fiat US (0 / 25000) para
--   que el comportamiento sea comparable desde el día 1; el staff los ajusta
--   luego desde el panel (tab Comisiones).
--
--   Con estas 2 claves el bloque "Límites por Servicio — Rampas Bridge" pasa
--   de 10 claves (5 pares) a 12 claves (6 pares).
-- Date: 2026-08-10
-- ============================================================

INSERT INTO app_settings (key, value, description) VALUES
  -- ── Ramp: Wallet Externa → Exterior ──
  ('MIN_WALLET_TO_WORLD_USD', '0',        'Monto mínimo USD para el servicio Wallet Externa → Exterior'),
  ('MAX_WALLET_TO_WORLD_USD', '25000.00', 'Monto máximo USD para el servicio Wallet Externa → Exterior')

ON CONFLICT (key) DO NOTHING;
