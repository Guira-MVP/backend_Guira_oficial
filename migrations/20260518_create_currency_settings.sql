-- ============================================================
-- Migration: create_currency_settings
-- Purpose:
--   Crea tabla currency_settings para gestión dinámica de
--   divisas desde el panel staff. Reemplaza las constantes
--   hardcodeadas WALLET_RAMP_ACTIVE_DEST_CURRENCIES en el
--   frontend y permite activar/desactivar divisas sin deploy.
-- Date: 2026-05-18
-- ============================================================

CREATE TABLE IF NOT EXISTS currency_settings (
  currency      text PRIMARY KEY,
  label         text        NOT NULL,
  currency_type text        NOT NULL DEFAULT 'crypto',
  is_active     boolean     NOT NULL DEFAULT false,
  sort_order    integer     NOT NULL DEFAULT 0,
  updated_at    timestamptz          DEFAULT now(),
  updated_by    uuid REFERENCES auth.users(id)
);

-- RLS: lectura pública (autenticada por SupabaseAuthGuard en backend),
--      escritura solo via service_role (backend usa service_role key)
ALTER TABLE currency_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "currency_settings_select"
  ON currency_settings FOR SELECT
  USING (true);

CREATE POLICY "currency_settings_service_write"
  ON currency_settings FOR ALL
  USING (auth.role() = 'service_role');

-- Seed inicial
INSERT INTO currency_settings (currency, label, currency_type, is_active, sort_order) VALUES
  ('usdc',  'USDC',  'crypto', true,  1),
  ('usdt',  'USDT',  'crypto', true,  2),
  ('eurc',  'EURC',  'crypto', false, 3),
  ('pyusd', 'PYUSD', 'crypto', false, 4),
  ('usdb',  'USDB',  'crypto', false, 5)
ON CONFLICT (currency) DO NOTHING;
