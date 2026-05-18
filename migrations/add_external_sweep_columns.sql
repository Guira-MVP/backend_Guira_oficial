-- ============================================================
--  Migración: Soporte para Virtual Accounts con destino externo
--  (External Sweep — Doble Asiento Contable)
-- ============================================================

-- 1. Agregar columnas a bridge_virtual_accounts
ALTER TABLE bridge_virtual_accounts
  ADD COLUMN IF NOT EXISTS is_external_sweep    boolean     DEFAULT false,
  ADD COLUMN IF NOT EXISTS external_destination_label text  DEFAULT NULL;

-- 2. Agregar valor 'swept_external' al check/enum de payment_orders.status
--    (Si usas CHECK constraint, ajustar aquí. Si es texto libre, no hace falta.)
COMMENT ON COLUMN bridge_virtual_accounts.is_external_sweep IS
  'true si los fondos se envían automáticamente a una wallet externa (Binance, MetaMask, etc.) y NO deben incrementar el balance interno de Guira.';

COMMENT ON COLUMN bridge_virtual_accounts.external_destination_label IS
  'Etiqueta amigable para la wallet externa de destino, ej: Mi Binance USDC';

-- 3. Índice parcial para queries de VAs externas activas
CREATE INDEX IF NOT EXISTS idx_bva_external_sweep_active
  ON bridge_virtual_accounts (user_id)
  WHERE is_external_sweep = true AND status = 'active';
