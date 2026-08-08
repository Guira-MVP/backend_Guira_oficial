-- bolivia_to_wallet (interbank_bo_wallet): el cotizador del panel va a mostrar la
-- comisión global en vez de "Depende del proveedor elegido al crear la orden".
-- fees_config ya tenía filas sembradas al 3% para los 5 tokens destino
-- (eurc/pyusd/usdb/usdc/usdt), pero solo usdc estaba activa. Se activan las 4
-- restantes; no se inserta ni se inventa ningún porcentaje nuevo.

UPDATE fees_config
SET is_active = true,
    updated_at = now()
WHERE operation_type = 'interbank_bo_wallet'
  AND payment_rail = 'psav'
  AND currency IN ('eurc', 'pyusd', 'usdb', 'usdt')
  AND is_active = false;
