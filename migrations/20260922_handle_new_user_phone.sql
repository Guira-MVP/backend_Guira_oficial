-- El registro público ahora captura teléfono (E.164) junto con nombre/correo.
-- profiles.phone ya existía (usado como fallback en ProfilesService.getClientPhone),
-- pero nunca se poblaba porque el trigger no lo leía del payload de signup.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, phone, role, onboarding_status)
    VALUES (
        NEW.id,
        NEW.email,
        NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'full_name'), ''),
        NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'phone'), ''),
        'client',
        'pending'
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$function$;
