-- SUG-06: Índice parcial en payment_orders(bridge_transfer_id)
-- Optimiza la búsqueda del webhook handleTransferComplete que busca
-- payment_orders por bridge_transfer_id en cada evento transfer.complete.
-- Solo indexa filas con bridge_transfer_id NOT NULL (la mayoría de órdenes
-- interbank no lo tienen, así que el índice parcial ahorra espacio).

CREATE INDEX IF NOT EXISTS idx_payment_orders_bridge_transfer_id
ON payment_orders(bridge_transfer_id)
WHERE bridge_transfer_id IS NOT NULL;
