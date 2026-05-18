-- Unicidad de proveedores por email + rail de pago
-- Para fiat:   UNIQUE (user_id, contact_email, payment_rail)
-- Para crypto: UNIQUE (user_id, contact_email, wallet_network)
--              donde wallet_network se extrae de bank_details->>'wallet_network'
--
-- Se usa índice parcial (WHERE is_active = true) para que el soft-delete permita
-- "recrear" un proveedor con el mismo email+rail sin colisión.

-- ──────────────────────────────────────────────────
-- 1. Limpiar duplicados FIAT existentes
--    Conserva el registro más antiguo (created_at ASC) por (user_id, email, rail)
-- ──────────────────────────────────────────────────
WITH fiat_dupes AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, contact_email, payment_rail
      ORDER BY created_at ASC
    ) AS rn
  FROM suppliers
  WHERE is_active = true
    AND contact_email IS NOT NULL
    AND payment_rail <> 'crypto'
)
UPDATE suppliers
SET is_active = false, updated_at = now()
WHERE id IN (SELECT id FROM fiat_dupes WHERE rn > 1);

-- ──────────────────────────────────────────────────
-- 2. Limpiar duplicados CRYPTO existentes
--    Conserva el registro más antiguo por (user_id, email, wallet_network)
-- ──────────────────────────────────────────────────
WITH crypto_dupes AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, contact_email, (bank_details->>'wallet_network')
      ORDER BY created_at ASC
    ) AS rn
  FROM suppliers
  WHERE is_active = true
    AND contact_email IS NOT NULL
    AND payment_rail = 'crypto'
)
UPDATE suppliers
SET is_active = false, updated_at = now()
WHERE id IN (SELECT id FROM crypto_dupes WHERE rn > 1);

-- ──────────────────────────────────────────────────
-- 3. Índice único para proveedores FIAT
-- ──────────────────────────────────────────────────
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS suppliers_unique_fiat_email_rail
  ON suppliers (user_id, contact_email, payment_rail)
  WHERE is_active = true
    AND contact_email IS NOT NULL
    AND payment_rail <> 'crypto';

-- ──────────────────────────────────────────────────
-- 4. Índice único para proveedores CRYPTO (por red)
-- ──────────────────────────────────────────────────
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS suppliers_unique_crypto_email_network
  ON suppliers (user_id, contact_email, (bank_details->>'wallet_network'))
  WHERE is_active = true
    AND contact_email IS NOT NULL
    AND payment_rail = 'crypto';
