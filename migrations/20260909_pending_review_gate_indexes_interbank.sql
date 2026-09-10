-- ═══════════════════════════════════════════════════════════════════════════
-- Cierra los índices de anti-duplicado que quedaron fuera al ampliar la puerta
-- de revisión a los 10 flujos.
--
-- Los índices parciales que impiden "un solo expediente activo por ruta" fueron
-- escritos cuando 'pending_review' no existía. Un expediente en revisión es tan
-- activo como uno esperando depósito —de hecho va a generarlo— así que sin
-- incluirlo el cliente puede acumular varios sobre la misma ruta y el staff
-- aprobarlos todos.
--
-- El caso más grave es idx_po_bridge_active_per_rail: Bridge reutiliza la
-- dirección de depósito para el mismo customer + moneda + red, así que tres
-- transfers aprobados a la vez compartirían dirección y un depósito podría
-- liquidarse contra el expediente equivocado.
--
-- Aplicar junto con 20260909_pending_review_gate.sql.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Interbank: un expediente activo por divisa ─────────────────────────────
-- Espejo en TS: assertNoConflictingBoliviaToWorldOrder, assertNoConflictingPsavOrder
-- y assertNoConflictingWorldToBoliviaOrder. La lista de estados debe coincidir.

DROP INDEX IF EXISTS public.idx_po_btw_active_per_currency;
CREATE UNIQUE INDEX idx_po_btw_active_per_currency
  ON public.payment_orders USING btree (user_id, destination_currency)
  WHERE flow_type = 'bolivia_to_world'::text
    AND status = ANY (ARRAY['pending_review'::text, 'waiting_deposit'::text, 'deposit_received'::text, 'processing'::text]);

DROP INDEX IF EXISTS public.idx_po_b2w_active_per_dest_currency;
CREATE UNIQUE INDEX idx_po_b2w_active_per_dest_currency
  ON public.payment_orders USING btree (user_id, destination_currency)
  WHERE flow_type = 'bolivia_to_wallet'::text
    AND status = ANY (ARRAY['pending_review'::text, 'waiting_deposit'::text, 'deposit_received'::text, 'processing'::text]);

DROP INDEX IF EXISTS public.idx_po_w2b_active_per_dest_currency;
CREATE UNIQUE INDEX idx_po_w2b_active_per_dest_currency
  ON public.payment_orders USING btree (user_id, destination_currency)
  WHERE flow_type = 'world_to_bolivia'::text
    AND status = ANY (ARRAY['pending_review'::text, 'waiting_deposit'::text, 'deposit_received'::text, 'processing'::text]);

DROP INDEX IF EXISTS public.idx_po_w2b_active_per_src_currency;
CREATE INDEX idx_po_w2b_active_per_src_currency
  ON public.payment_orders USING btree (user_id, flow_type, currency)
  WHERE flow_type = 'world_to_bolivia'::text
    AND status = ANY (ARRAY['pending_review'::text, 'waiting_deposit'::text, 'deposit_received'::text, 'processing'::text]);

-- ── Colisión de dirección de depósito en Bridge ────────────────────────────
-- Espejo en TS: assertNoConflictingBridgeDepositOrder.
-- Un expediente ocupa la dirección si ya tiene transfer esperando fondos, o si
-- está en revisión y va a generar uno al aprobarse (todavía sin transfer_id).
DROP INDEX IF EXISTS public.idx_po_bridge_active_per_rail;
CREATE UNIQUE INDEX idx_po_bridge_active_per_rail
  ON public.payment_orders USING btree (user_id, source_network, source_currency)
  WHERE flow_type = ANY (ARRAY['fiat_bo_to_bridge_wallet'::text, 'crypto_to_bridge_wallet'::text, 'wallet_to_wallet'::text])
    AND (
      (status = 'waiting_deposit'::text AND bridge_transfer_id IS NOT NULL)
      OR status = 'pending_review'::text
    );

COMMIT;

-- ── Verificación posterior ─────────────────────────────────────────────────
-- SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'payment_orders' AND indexname LIKE 'idx_po_%'
--   ORDER BY indexname;
