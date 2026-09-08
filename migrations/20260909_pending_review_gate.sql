-- ═══════════════════════════════════════════════════════════════════════════
-- Puerta de revisión de staff entre "expediente creado" y "Bridge Transfer
-- enviado al proveedor", para los 4 flujos de salida de fondos:
--   bridge_wallet_to_fiat_bo
--   bridge_wallet_to_crypto
--   bridge_wallet_to_fiat_us   (incluida la rama Perú, que comparte flow_type)
--   wallet_to_world
--
-- Hasta ahora el expediente y el transfer se creaban en la misma petición HTTP:
-- el dinero salía hacia el proveedor sin que nadie hubiese verificado el motivo
-- declarado ni el documento de respaldo del cliente. Con este cambio el
-- expediente nace en 'pending_review' y el transfer se crea recién al aprobar.
--
-- OBLIGATORIA: debe correr ANTES del deploy del backend. Sin ella, todo INSERT
-- de estos 4 flujos viola payment_orders_status_check.
--
-- Aplicar manualmente en Supabase (este repo no tiene runner de migraciones).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Nuevo estado ────────────────────────────────────────────────────────
-- El CHECK original viene del schema inicial (NO existe en migrations/), por
-- eso se recrea entero en vez de alterarlo.
ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_status_check;

ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_status_check CHECK (
    status = ANY (ARRAY[
      'created'::text,
      'pending_review'::text,   -- ← nuevo: esperando revisión del staff
      'waiting_deposit'::text,
      'deposit_received'::text,
      'processing'::text,
      'sent'::text,
      'completed'::text,
      'failed'::text,
      'cancelled'::text,
      'pending'::text,
      'refunded'::text,
      'swept_external'::text
    ])
  );

-- ── 2. Snapshot del contexto de ejecución ──────────────────────────────────
ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS bridge_execution_context jsonb;

COMMENT ON COLUMN public.payment_orders.bridge_execution_context IS
  'Snapshot del contexto necesario para crear el Bridge Transfer al aprobar la '
  'revisión de staff. Solo se escribe en los flujos con puerta de revisión. '
  'Congela lo DERIVADO (riel de destino, divisa, rail_ref, psav_dest_currency, '
  'total_needed, IDs locales) para que la aprobación no recalcule comisiones ni '
  're-resuelva rutas. NO guarda identificadores vivos (bridge_customer_id, '
  'provider_wallet_id, bridge_external_account_id, crypto_address): esos se '
  'releen de su tabla origen en el momento de la aprobación, porque pueden '
  'rotar legítimamente y enviar uno viejo significa dinero al sitio equivocado.';

-- ── 3. Índices únicos parciales: incluir pending_review ────────────────────
-- Estos índices codifican la regla "un solo expediente activo por ruta". Sin
-- pending_review en el predicado, un cliente podría apilar N expedientes en
-- revisión sobre la misma ruta y el staff aprobarlos todos.
--
-- Sus espejos en TypeScript son assertNoConflictingOffRampOrder,
-- assertNoConflictingCryptoOffRamp, assertNoConflictingFiatUsOffRamp y
-- assertNoConflictingWalletToWorld en payment-orders.service.ts: la lista de
-- estados de allí debe coincidir EXACTAMENTE con estos WHERE.

DROP INDEX IF EXISTS public.idx_po_bw2fbo_active_per_src;
CREATE UNIQUE INDEX idx_po_bw2fbo_active_per_src
  ON public.payment_orders USING btree (user_id, source_currency)
  WHERE flow_type = 'bridge_wallet_to_fiat_bo'::text
    AND status = ANY (ARRAY['created'::text, 'pending_review'::text, 'processing'::text]);

DROP INDEX IF EXISTS public.idx_po_bw2c_active_per_src_dest;
CREATE UNIQUE INDEX idx_po_bw2c_active_per_src_dest
  ON public.payment_orders USING btree (user_id, source_currency, destination_network)
  WHERE flow_type = 'bridge_wallet_to_crypto'::text
    AND status = ANY (ARRAY['created'::text, 'pending_review'::text, 'processing'::text]);

DROP INDEX IF EXISTS public.idx_po_bw2fus_active_per_src_supplier;
CREATE UNIQUE INDEX idx_po_bw2fus_active_per_src_supplier
  ON public.payment_orders USING btree (user_id, source_currency, supplier_id)
  WHERE flow_type = 'bridge_wallet_to_fiat_us'::text
    AND status = ANY (ARRAY['created'::text, 'pending_review'::text, 'processing'::text]);

DROP INDEX IF EXISTS public.idx_po_w2w_active_per_src_supplier;
CREATE UNIQUE INDEX idx_po_w2w_active_per_src_supplier
  ON public.payment_orders USING btree (user_id, source_currency, supplier_id)
  WHERE flow_type = 'wallet_to_world'::text
    AND status = ANY (ARRAY['created'::text, 'pending_review'::text, 'waiting_deposit'::text, 'processing'::text]);

-- ── 4. Cola de revisión del panel de staff ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_po_pending_review
  ON public.payment_orders USING btree (created_at DESC)
  WHERE status = 'pending_review'::text;

COMMIT;

-- ── Verificación posterior ─────────────────────────────────────────────────
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'payment_orders_status_check';
-- SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'payment_orders' AND indexname LIKE 'idx_po_%';
