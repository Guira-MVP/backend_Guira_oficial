-- ============================================================
-- Migration: add_per_service_min_max_limits
-- Purpose:
--   Agrega claves individuales de mínimo y máximo por servicio
--   en app_settings. Los valores iniciales se copian de las
--   claves globales actuales (MIN/MAX_INTERBANK_USD y MIN/MAX_RAMP_USD).
--   Las claves globales se mantienen como fallback.
-- Date: 2026-05-08
-- ============================================================

INSERT INTO app_settings (key, value, description) VALUES
  -- ── Interbank: Bolivia → Mundo ──
  ('MIN_BOLIVIA_TO_WORLD_USD',  '1',        'Monto mínimo USD para el servicio Bolivia → Mundo'),
  ('MAX_BOLIVIA_TO_WORLD_USD',  '50000.00', 'Monto máximo USD para el servicio Bolivia → Mundo'),

  -- ── Interbank: Bolivia → Wallet ──
  ('MIN_BOLIVIA_TO_WALLET_USD', '1',        'Monto mínimo USD para el servicio Bolivia → Wallet'),
  ('MAX_BOLIVIA_TO_WALLET_USD', '50000.00', 'Monto máximo USD para el servicio Bolivia → Wallet'),

  -- ── Interbank: Wallet → Wallet ──
  ('MIN_WALLET_TO_WALLET_USD',  '1',        'Monto mínimo USD para el servicio Wallet → Wallet'),
  ('MAX_WALLET_TO_WALLET_USD',  '50000.00', 'Monto máximo USD para el servicio Wallet → Wallet'),

  -- ── Interbank: Mundo → Bolivia ──
  ('MIN_WORLD_TO_BOLIVIA_USD',  '1',        'Monto mínimo USD para el servicio Mundo → Bolivia'),
  ('MAX_WORLD_TO_BOLIVIA_USD',  '50000.00', 'Monto máximo USD para el servicio Mundo → Bolivia'),

  -- ── Ramp: Fiat BO → Bridge Wallet ──
  ('MIN_FIAT_BO_TO_BRIDGE_WALLET_USD', '0',        'Monto mínimo USD para el servicio Fiat BO → Bridge Wallet'),
  ('MAX_FIAT_BO_TO_BRIDGE_WALLET_USD', '25000.00', 'Monto máximo USD para el servicio Fiat BO → Bridge Wallet'),

  -- ── Ramp: Crypto → Bridge Wallet ──
  ('MIN_CRYPTO_TO_BRIDGE_WALLET_USD',  '0',        'Monto mínimo USD para el servicio Crypto → Bridge Wallet'),
  ('MAX_CRYPTO_TO_BRIDGE_WALLET_USD',  '25000.00', 'Monto máximo USD para el servicio Crypto → Bridge Wallet'),

  -- ── Ramp: Bridge Wallet → Fiat BO ──
  ('MIN_BRIDGE_WALLET_TO_FIAT_BO_USD', '0',        'Monto mínimo USD para el servicio Bridge Wallet → Fiat BO'),
  ('MAX_BRIDGE_WALLET_TO_FIAT_BO_USD', '25000.00', 'Monto máximo USD para el servicio Bridge Wallet → Fiat BO'),

  -- ── Ramp: Bridge Wallet → Crypto ──
  ('MIN_BRIDGE_WALLET_TO_CRYPTO_USD',  '0',        'Monto mínimo USD para el servicio Bridge Wallet → Crypto'),
  ('MAX_BRIDGE_WALLET_TO_CRYPTO_USD',  '25000.00', 'Monto máximo USD para el servicio Bridge Wallet → Crypto'),

  -- ── Ramp: Bridge Wallet → Fiat US ──
  ('MIN_BRIDGE_WALLET_TO_FIAT_US_USD', '0',        'Monto mínimo USD para el servicio Bridge Wallet → Fiat US'),
  ('MAX_BRIDGE_WALLET_TO_FIAT_US_USD', '25000.00', 'Monto máximo USD para el servicio Bridge Wallet → Fiat US')

ON CONFLICT (key) DO NOTHING;
