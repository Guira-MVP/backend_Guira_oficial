-- Semilla de configuración para el entorno de STAGING.
--
-- El panel de staff (staff-config-panel.tsx) tiene 6 tabs de configuración.
-- Tres de ellos leían de tablas que en staging quedaron vacías al crear el
-- branch, así que la UI se veía sin datos:
--
--   - "VA Fees"       -> public.va_fee_defaults              (0 filas)
--   - "Divisas"       -> public.currency_settings            (0 filas)
--   - "Depósitos VA"  -> public.va_source_currency_settings  (0 filas)
--
-- Los otros tres tabs ("Tasas", "Comisiones", "Variables") ya tenían datos
-- vía exchange_rates_config / fees_config / app_settings.
--
-- Los valores replican los de producción al 2026-09-03 para que staging se
-- comporte igual, incluidos los flags is_active (la mayoría en false: es el
-- estado real de producción, no un error).
--
-- `updated_by` se deja en NULL a propósito: en producción apunta a un usuario
-- concreto que no existe en staging, y ambas columnas tienen FK
-- (auth.users / profiles). Nunca copiar ese UUID entre entornos.
--
-- Idempotente: ON CONFLICT DO NOTHING en las tres tablas, así que reaplicarla
-- no duplica ni pisa cambios que el staff haya hecho luego desde el panel.

-- ── Tab "Divisas" → currency_settings (PK: currency) ────────────────────
INSERT INTO public.currency_settings
  (currency, label, currency_type, is_active, sort_order, is_active_va, is_active_supplier, updated_by)
VALUES
  ('usdc',  'USDC',  'crypto', true,  1, true,  true,  NULL),
  ('usdt',  'USDT',  'crypto', false, 2, false, false, NULL),
  ('eurc',  'EURC',  'crypto', false, 3, false, false, NULL),
  ('pyusd', 'PYUSD', 'crypto', false, 4, false, false, NULL),
  ('usdb',  'USDB',  'crypto', false, 5, false, false, NULL)
ON CONFLICT (currency) DO NOTHING;

-- ── Tab "Depósitos VA" → va_source_currency_settings (PK: currency) ─────
INSERT INTO public.va_source_currency_settings
  (currency, label, rail_label, flag_iso, is_active, sort_order, is_active_supplier, updated_by)
VALUES
  ('usd', 'Dólar Estadounidense', 'ACH / Wire',      'US', true,  1, true,  NULL),
  ('eur', 'Euro',                 'SEPA',            'EU', false, 2, true,  NULL),
  ('mxn', 'Peso Mexicano',        'SPEI',            'MX', false, 3, false, NULL),
  ('brl', 'Real Brasileño',       'PIX',             'BR', false, 4, false, NULL),
  ('gbp', 'Libra Esterlina',      'Faster Payments', 'GB', false, 5, false, NULL),
  ('cop', 'Peso Colombiano',      'Bre-B',           'CO', false, 6, true,  NULL)
ON CONFLICT (currency) DO NOTHING;

-- ── Tab "VA Fees" → va_fee_defaults (UNIQUE: source_currency+destination_type) ──
-- destination_type sólo admite 'wallet_bridge' | 'wallet_external' (CHECK).
INSERT INTO public.va_fee_defaults
  (source_currency, destination_type, fee_percent, updated_by)
VALUES
  ('usd', 'wallet_bridge',   3,   NULL),
  ('usd', 'wallet_external', 1.0, NULL),
  ('eur', 'wallet_bridge',   3,   NULL),
  ('eur', 'wallet_external', 1.0, NULL),
  ('mxn', 'wallet_bridge',   3,   NULL),
  ('mxn', 'wallet_external', 1.0, NULL),
  ('brl', 'wallet_bridge',   3,   NULL),
  ('brl', 'wallet_external', 1.0, NULL),
  ('gbp', 'wallet_bridge',   3,   NULL),
  ('gbp', 'wallet_external', 1.0, NULL),
  ('cop', 'wallet_bridge',   3,   NULL),
  ('cop', 'wallet_external', 1.0, NULL)
ON CONFLICT (source_currency, destination_type) DO NOTHING;
