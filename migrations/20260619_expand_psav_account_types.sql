-- Amplía el CHECK constraint de psav_accounts.type para incluir los nuevos tipos de canal bancario
-- Nuevos tipos: bank_mx (México), bank_eu (Europa), bank_co (Colombia), bank_br (Brasil)

ALTER TABLE psav_accounts DROP CONSTRAINT psav_accounts_type_check;

ALTER TABLE psav_accounts
  ADD CONSTRAINT psav_accounts_type_check
  CHECK (type = ANY (ARRAY[
    'bank_bo'::text,
    'bank_us'::text,
    'bank_mx'::text,
    'bank_eu'::text,
    'bank_co'::text,
    'bank_br'::text,
    'crypto'::text
  ]));
