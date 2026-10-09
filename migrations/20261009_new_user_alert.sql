-- Aviso interno de cliente nuevo.
--
-- Cuando un usuario verifica su correo (o nace ya verificado, como Google),
-- un trigger sobre auth.users avisa al backend por pg_net; el backend envia un
-- correo corto a los destinatarios de app_settings.NEW_USER_ALERT_RECIPIENTS.
--
-- Requiere dos secretos en Supabase Vault (por branch, NO van en la migracion):
--   select vault.create_secret('https://<backend>/api/internal/new-user-alert', 'new_user_alert_url');
--   select vault.create_secret('<mismo valor que INTERNAL_WEBHOOK_SECRET>',      'new_user_alert_secret');
-- Sin ellos el trigger no hace nada.

CREATE EXTENSION IF NOT EXISTS pg_net;

-- Marca de idempotencia: el aviso se envia una sola vez por cliente.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS new_user_alert_sent_at timestamptz;

INSERT INTO public.app_settings (key, value, type, description, is_public)
VALUES
  ('NEW_USER_ALERT_ENABLED', 'true', 'boolean',
   'Envia un correo interno cuando un cliente nuevo verifica su correo.', false),
  ('NEW_USER_ALERT_RECIPIENTS',
   'administracion@guiracorp.com,miguel.angel.tambo.morales@gmail.com', 'string',
   'Correos (separados por coma) que reciben el aviso de cliente nuevo.', false)
ON CONFLICT (key) DO NOTHING;

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.notify_new_user_verified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_url    text;
  v_secret text;
BEGIN
  -- En UPDATE solo interesa la transicion no verificado -> verificado.
  IF TG_OP = 'UPDATE' AND OLD.email_confirmed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Jamas debe romper el registro/login: cualquier fallo se ignora.
  BEGIN
    SELECT decrypted_secret INTO v_url
      FROM vault.decrypted_secrets WHERE name = 'new_user_alert_url' LIMIT 1;
    SELECT decrypted_secret INTO v_secret
      FROM vault.decrypted_secrets WHERE name = 'new_user_alert_secret' LIMIT 1;

    IF v_url IS NOT NULL AND v_secret IS NOT NULL THEN
      PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-internal-secret', v_secret
        ),
        body := jsonb_build_object('user_id', NEW.id),
        timeout_milliseconds := 5000
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_new_user_verified() FROM PUBLIC, anon, authenticated;

-- El prefijo zz_ hace que corra despues de on_auth_user_created (orden alfabetico).
DROP TRIGGER IF EXISTS zz_notify_new_user_verified ON auth.users;
CREATE TRIGGER zz_notify_new_user_verified
  AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION private.notify_new_user_verified();
