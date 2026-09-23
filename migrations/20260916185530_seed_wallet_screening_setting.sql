-- Interruptor del screening AML (Didit) de la direccion cripto de cada
-- beneficiario nuevo. Se siembra APAGADO: cada revision es facturable.
-- Aplicada en staging como 20260916185530_seed_wallet_screening_setting.
insert into public.app_settings (key, value, type, description, is_public)
values (
  'WALLET_SCREENING_ENABLED',
  'false',
  'boolean',
  'Cuando es true, revisa con Didit la dirección cripto de cada beneficiario nuevo antes de registrarlo. Apagado, los beneficiarios se crean sin revisión AML de la dirección.',
  false
)
on conflict (key) do nothing;
