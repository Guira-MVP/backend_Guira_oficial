-- bolivia_to_world (interbank_bo_out) USD hoy cobra la misma comisión sin importar
-- el riel (ACH vs Wire) porque fees_config solo tenía una fila payment_rail='psav'
-- para currency='usd'. Repuntamos esa fila a 'ach' y clonamos una fila 'wire' con
-- los mismos valores como punto de partida (el staff los diferencia después desde
-- la pestaña Comisiones). Se mantiene el mismo id de la fila original para no
-- romper referencias existentes.
--
-- Se hace lo mismo con customer_fee_overrides: las excepciones por-cliente que ya
-- existían en psav/usd (ambas inactivas) se repuntan a 'ach' y se clonan a 'wire',
-- para no perder esa configuración una vez que el backend deje de resolver fees de
-- USD contra payment_rail='psav'.

-- 1. fees_config: repuntar la fila global usd/psav -> usd/ach
UPDATE fees_config
SET payment_rail = 'ach',
    description = 'Bolivia → Exterior — liquidación destino USD vía ACH',
    updated_at = now()
WHERE operation_type = 'interbank_bo_out'
  AND payment_rail = 'psav'
  AND currency = 'usd';

-- 2. fees_config: clonar a usd/wire
INSERT INTO fees_config (operation_type, payment_rail, currency, fee_type, fee_percent, fee_fixed, min_fee, max_fee, is_active, description)
SELECT operation_type, 'wire', currency, fee_type, fee_percent, fee_fixed, min_fee, max_fee, is_active,
       'Bolivia → Exterior — liquidación destino USD vía Wire'
FROM fees_config
WHERE operation_type = 'interbank_bo_out'
  AND payment_rail = 'ach'
  AND currency = 'usd'
ON CONFLICT DO NOTHING;

-- 3. customer_fee_overrides: repuntar excepciones existentes usd/psav -> usd/ach
UPDATE customer_fee_overrides
SET payment_rail = 'ach',
    updated_at = now()
WHERE operation_type = 'interbank_bo_out'
  AND payment_rail = 'psav'
  AND currency = 'usd';

-- 4. customer_fee_overrides: clonar esas mismas excepciones a usd/wire
INSERT INTO customer_fee_overrides (user_id, operation_type, payment_rail, currency, fee_type, fee_percent, fee_fixed, min_fee, max_fee, is_active, valid_from, valid_until, notes, created_by)
SELECT user_id, operation_type, 'wire', currency, fee_type, fee_percent, fee_fixed, min_fee, max_fee, is_active, valid_from, valid_until, notes, created_by
FROM customer_fee_overrides
WHERE operation_type = 'interbank_bo_out'
  AND payment_rail = 'ach'
  AND currency = 'usd'
ON CONFLICT DO NOTHING;
