-- Tipo de cuenta del cliente: 'personal' (KYC) o 'company' (KYB).
--
-- Nace como la intención que el cliente declara al registrarse (tarjetas
-- Personal / Empresa) y el backend la sincroniza con lo que realmente envía:
-- al enviar un KYC queda 'personal', al enviar un KYB queda 'company'
-- (onboarding.service.ts, submitKyc/KybApplication).
--
-- Sirve para guiar el onboarding (entra directo al formulario del tipo) y
-- para que el staff sepa qué cuenta quiere el cliente. NO decide comisiones,
-- límites, flujos ni permisos: el valor inicial lo escribe el propio cliente.
-- Vacío = cuenta anterior a este cambio sin solicitud, o invitación de staff.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_type text
  CONSTRAINT profiles_account_type_check CHECK (account_type IN ('personal', 'company'));

-- Parte de 20260928_signup_kyb_fields.sql; solo agrega account_type.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
    INSERT INTO public.profiles (
        id, email, full_name, phone, role, onboarding_status, account_type,
        company_name, tax_id, contact_first_name, contact_last_name, contact_id_number
    )
    VALUES (
        NEW.id,
        NEW.email,
        LEFT(NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'full_name'), ''), 200),
        NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'phone'), ''),
        'client',
        'pending',
        CASE WHEN NEW.raw_user_meta_data ->> 'account_type' IN ('personal', 'company')
             THEN NEW.raw_user_meta_data ->> 'account_type' END,
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

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- Relleno: quien ya tiene una solicitud toma el tipo de la más reciente
-- (KYC → personal, KYB → company). El resto queda vacío.
WITH latest AS (
  SELECT DISTINCT ON (user_id) user_id, kind
  FROM (
    SELECT user_id, 'personal'::text AS kind, created_at FROM public.kyc_applications
    UNION ALL
    SELECT requester_user_id, 'company'::text, created_at FROM public.kyb_applications
  ) apps
  WHERE user_id IS NOT NULL
  ORDER BY user_id, created_at DESC
)
UPDATE public.profiles p
SET account_type = latest.kind
FROM latest
WHERE p.id = latest.user_id
  AND p.account_type IS NULL;
