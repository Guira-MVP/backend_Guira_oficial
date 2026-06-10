-- ═══════════════════════════════════════════════════════════════
--  profiles.country_code
--  Materializa el país de origen del cliente a nivel de perfil para
--  resolver la visibilidad de flujos por país de forma simple e indexable.
--
--  Fuente: onboarding.
--    Persona  → people.country_of_residence (fallback: people.country)
--    Empresa  → businesses.country_of_incorporation (fallback: businesses.country)
--  ISO 3166-1 alpha-3 (alpha-2 tolerado en runtime). NULL = país indeterminado
--  → tratado como Bolivia (permisivo) por la lógica de negocio.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS country_code TEXT;

-- Backfill personas naturales
UPDATE profiles p
SET country_code = UPPER(COALESCE(pe.country_of_residence, pe.country))
FROM people pe
WHERE pe.user_id = p.id
  AND p.country_code IS NULL
  AND COALESCE(pe.country_of_residence, pe.country) IS NOT NULL;

-- Backfill empresas
UPDATE profiles p
SET country_code = UPPER(COALESCE(b.country_of_incorporation, b.country))
FROM businesses b
WHERE b.user_id = p.id
  AND p.country_code IS NULL
  AND COALESCE(b.country_of_incorporation, b.country) IS NOT NULL;

CREATE INDEX IF NOT EXISTS profiles_country_code_idx ON profiles (country_code);
