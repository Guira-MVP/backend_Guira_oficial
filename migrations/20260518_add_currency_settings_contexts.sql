-- ============================================================
-- Migration: add_currency_settings_contexts
-- Purpose:
--   Extiende currency_settings con dos columnas adicionales para
--   controlar la disponibilidad de divisas por contexto de uso:
--     - is_active_va:       Cuentas Virtuales (Virtual Accounts)
--     - is_active_supplier: Proveedores crypto
--   Esto permite al staff habilitar/deshabilitar divisas de forma
--   independiente por sección desde el panel de administración,
--   sin afectar los otros contextos.
-- Date: 2026-05-18
-- ============================================================

ALTER TABLE currency_settings
  ADD COLUMN IF NOT EXISTS is_active_va       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active_supplier boolean NOT NULL DEFAULT false;

-- Seed: USDC y USDT activos en ambos contextos (igual que en wallet ramp)
UPDATE currency_settings
  SET is_active_va = true, is_active_supplier = true
  WHERE currency IN ('usdc', 'usdt');
