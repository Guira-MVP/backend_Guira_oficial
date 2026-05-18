-- Elimina las claves de límite globales genéricas.
-- Cada servicio ahora tiene su propia clave MIN/MAX_*_USD, por lo que
-- los fallbacks por categoría (INTERBANK, RAMP) y el de PAYOUT son obsoletos.
DELETE FROM app_settings
WHERE key IN (
  'MIN_INTERBANK_USD',
  'MAX_INTERBANK_USD',
  'MIN_RAMP_USD',
  'MAX_RAMP_USD',
  'MIN_PAYOUT_USD',
  'MAX_PAYOUT_USD'
);
