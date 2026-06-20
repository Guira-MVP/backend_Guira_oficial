-- Agrega el tipo 'bank_gb' (Faster Payments UK / GBP) a la constraint de psav_accounts.
-- Necesario para que world_to_bolivia soporte GBP como divisa de origen.

ALTER TABLE psav_accounts DROP CONSTRAINT IF EXISTS psav_accounts_type_check;

ALTER TABLE psav_accounts
  ADD CONSTRAINT psav_accounts_type_check
  CHECK (type = ANY (ARRAY[
    'bank_bo'::text,
    'bank_us'::text,
    'bank_mx'::text,
    'bank_eu'::text,
    'bank_co'::text,
    'bank_br'::text,
    'bank_gb'::text,
    'crypto'::text
  ]));
