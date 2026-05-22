-- Create the initial profile from the Auth signup payload so registration does
-- not need a second public backend call keyed only by email.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, role, onboarding_status)
    VALUES (
        NEW.id,
        NEW.email,
        NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'full_name'), ''),
        'client',
        'pending'
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;
