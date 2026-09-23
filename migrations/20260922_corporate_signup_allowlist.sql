-- Whitelist de correos @guiracorp.com que pueden registrarse por el flujo publico
-- como clientes. Estar en la whitelist excluye el acceso al panel de staff.
-- Aplicada en produccion como 20260922144639_corporate_signup_allowlist.

CREATE TABLE IF NOT EXISTS private.corporate_signup_allowlist (
  email       text PRIMARY KEY,
  reason      text        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corporate_signup_allowlist_email_lowercase_check
    CHECK (email = LOWER(email)),
  CONSTRAINT corporate_signup_allowlist_email_domain_check
    CHECK (email LIKE '%@guiracorp.com')
);

COMMENT ON TABLE private.corporate_signup_allowlist IS
  'Correos @guiracorp.com autorizados a registrarse por el flujo publico y operar como clientes. Estar aqui excluye tener acceso al panel de staff (ver trigger on_staff_members_allowlist_check).';

ALTER TABLE private.corporate_signup_allowlist ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON private.corporate_signup_allowlist FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON private.corporate_signup_allowlist TO postgres, service_role;

INSERT INTO private.corporate_signup_allowlist (email, reason, created_by)
VALUES (
  'facturas@guiracorp.com',
  'Buzon de facturacion: opera como cliente, sin acceso al panel',
  'migration:20260922120000'
)
ON CONFLICT (email) DO NOTHING;

CREATE OR REPLACE FUNCTION private.block_corporate_domain_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'private', 'public'
AS $function$
DECLARE
  current_email    text;
  current_app_meta jsonb;
BEGIN
  SELECT email, raw_app_meta_data INTO current_email, current_app_meta
  FROM auth.users WHERE id = NEW.id;

  IF current_email IS NOT NULL
     AND LOWER(current_email) LIKE '%@guiracorp.com'
     AND COALESCE(current_app_meta ->> 'staff_invite', 'false') <> 'true'
     AND NOT EXISTS (
       SELECT 1 FROM private.corporate_signup_allowlist a
       WHERE a.email = LOWER(current_email) AND a.is_active
     )
  THEN
    RAISE EXCEPTION
      'Las cuentas @guiracorp.com se crean unicamente por invitacion desde el panel de staff.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.block_allowlisted_from_staff()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'private', 'public'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM private.corporate_signup_allowlist a
    WHERE a.email = LOWER(NEW.email) AND a.is_active
  ) THEN
    RAISE EXCEPTION
      'El correo % esta en la whitelist de registro publico y no puede tener acceso al panel.',
      NEW.email
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.block_allowlisted_from_staff() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.block_allowlisted_from_staff() TO postgres, service_role;

DROP TRIGGER IF EXISTS on_staff_members_allowlist_check ON private.staff_members;
CREATE TRIGGER on_staff_members_allowlist_check
  BEFORE INSERT OR UPDATE ON private.staff_members
  FOR EACH ROW EXECUTE FUNCTION private.block_allowlisted_from_staff();
