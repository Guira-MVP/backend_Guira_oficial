-- ============================================================
-- wallet_to_world (4/4): una sola orden activa por token + proveedor
-- ============================================================
-- Con features.allow_any_from_address Bridge devuelve UNA dirección de
-- depósito por transfer. Si el cliente tuviera dos órdenes activas del mismo
-- token hacia el mismo proveedor, las dos direcciones serían indistinguibles
-- al momento de pagar y el dinero podría liquidarse contra la orden
-- equivocada.
--
-- Espejo de idx_po_bw2fus_active_per_src_supplier
-- (20260520_remaining_partial_indexes.sql), con una diferencia: aquí el
-- estado de espera es 'waiting_deposit' (el cliente todavía no envió los
-- fondos), así que entra en el WHERE junto a 'created' y 'processing'.
--
-- El WHERE debe coincidir EXACTAMENTE con el .in('status', [...]) de
-- assertNoConflictingWalletToWorld() en payment-orders.service.ts.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_po_w2w_active_per_src_supplier
  ON payment_orders (user_id, source_currency, supplier_id)
  WHERE flow_type = 'wallet_to_world'
    AND status IN ('created', 'waiting_deposit', 'processing');
