-- ============================================================
-- wallet_to_world (1/4): habilitar el flow_type en el CHECK
-- ============================================================
-- payment_orders.flow_type tiene un CHECK constraint que viene del schema
-- inicial (NO existe en migrations/, por eso no aparece en los greps). Sin
-- ampliarlo, el INSERT del flujo nuevo falla con 23514 y nada funciona.
--
-- Este archivo es OBLIGATORIO y debe correr ANTES del deploy del backend.
-- Es retrocompatible: solo agrega un valor, los 13 existentes se conservan
-- tal cual.
--
-- Verificación previa recomendada (debe devolver 0 filas):
--   SELECT DISTINCT flow_type FROM payment_orders
--   WHERE flow_type IS NOT NULL AND flow_type NOT IN (
--     'bolivia_to_world','wallet_to_wallet','bolivia_to_wallet','world_to_bolivia',
--     'world_to_wallet','fiat_bo_to_bridge_wallet','crypto_to_bridge_wallet',
--     'fiat_us_to_bridge_wallet','bridge_wallet_to_fiat_bo','bridge_wallet_to_crypto',
--     'bridge_wallet_to_fiat_us','wallet_to_fiat','va_deposit');
-- ============================================================

BEGIN;

ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_flow_type_check;

ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_flow_type_check CHECK (
    flow_type IS NULL OR flow_type = ANY (ARRAY[
      'bolivia_to_world'::text,
      'wallet_to_wallet'::text,
      'bolivia_to_wallet'::text,
      'world_to_bolivia'::text,
      'world_to_wallet'::text,
      'fiat_bo_to_bridge_wallet'::text,
      'crypto_to_bridge_wallet'::text,
      'fiat_us_to_bridge_wallet'::text,
      'bridge_wallet_to_fiat_bo'::text,
      'bridge_wallet_to_crypto'::text,
      'bridge_wallet_to_fiat_us'::text,
      'wallet_to_fiat'::text,
      'va_deposit'::text,
      -- Nuevo: off-ramp on-chain (wallet externa via QR) -> cuenta bancaria del proveedor
      'wallet_to_world'::text
    ])
  );

COMMIT;
