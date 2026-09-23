-- Configuracion del re-screening periodico de wallets de beneficiarios.
-- Se siembra APAGADO y con intervalo de 30 dias.
-- Aplicada en staging como 20260916203604_wallet_rescreening_settings.
insert into public.app_settings (key, value, type, description, is_public)
values
  (
    'WALLET_RESCREENING_ENABLED',
    'false',
    'boolean',
    'Cuando es true, un proceso automático revisa periódicamente las direcciones cripto de los beneficiarios ya registrados. Apagado, solo se revisan al crearlos.',
    false
  ),
  (
    'WALLET_RESCREENING_INTERVAL_DAYS',
    '30',
    'number',
    'Días tras los cuales la dirección de un beneficiario vuelve a revisarse. 30 es el estándar de la industria para monitoreo continuo de contrapartes.',
    false
  ),
  (
    'WALLET_RESCREENING_BATCH_SIZE',
    '25',
    'number',
    'Máximo de beneficiarios revisados por ciclo (el proceso corre cada hora). Es el techo de gasto: cada revisión cuesta 0.15 USD.',
    false
  )
on conflict (key) do nothing;
