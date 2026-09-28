-- Registro orientado a KYB (nivel 1 del onboarding).
--
-- El formulario de registro ahora pide los datos de la empresa y de su
-- representante legal: razón social, NIT, nombre(s) y apellido(s) del
-- contacto, CI, correo y teléfono. Se guardan en `profiles` para:
--   1. precargar el onboarding KYB/KYC (features/onboarding/lib/prefill-from-profile.ts)
--      sin volver a pedirlos, y
--   2. que el staff pueda identificar y buscar la cuenta por razón social o NIT
--      antes de que exista una solicitud de onboarding.
--
-- Son datos autodeclarados: lo que se envía a Bridge es lo que queda en el
-- formulario de onboarding al enviarlo, no estas columnas.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS company_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tax_id text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS contact_first_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS contact_last_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS contact_id_number text;

-- Parte de la versión vigente (20260922_handle_new_user_phone.sql). Los
-- valores vienen de raw_user_meta_data, que controla el cliente: el alta va
-- directo a Supabase Auth, así que la validación del formulario (zod) se
-- puede saltar. Aquí se recortan, se acotan en largo y el NIT y el CI solo se
-- guardan si tienen el formato esperado (si no, quedan NULL y el onboarding
-- los vuelve a pedir).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
    INSERT INTO public.profiles (
        id, email, full_name, phone, role, onboarding_status,
        company_name, tax_id, contact_first_name, contact_last_name, contact_id_number
    )
    VALUES (
        NEW.id,
        NEW.email,
        LEFT(NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'full_name'), ''), 200),
        NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'phone'), ''),
        'client',
        'pending',
        LEFT(NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'company_name'), ''), 200),
        CASE WHEN BTRIM(NEW.raw_user_meta_data ->> 'tax_id') ~ '^[0-9]{5,15}$'
             THEN BTRIM(NEW.raw_user_meta_data ->> 'tax_id') END,
        LEFT(NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'contact_first_name'), ''), 100),
        LEFT(NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'contact_last_name'), ''), 100),
        CASE WHEN BTRIM(NEW.raw_user_meta_data ->> 'contact_id_number') ~ '^[0-9]{4,12}([ -]?[A-Za-z0-9]{1,3})?$'
             THEN BTRIM(NEW.raw_user_meta_data ->> 'contact_id_number') END
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$function$;

-- CREATE OR REPLACE conserva los privilegios existentes, pero se reafirma
-- por si el branch arrastra el EXECUTE por defecto a PUBLIC: la función solo
-- la invoca el trigger de auth.users.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS profiles_tax_id_idx ON public.profiles (tax_id) WHERE tax_id IS NOT NULL;
