-- ============================================================
-- Migration: audit_log_retention
-- OWASP A09 Fix: Política de retención de logs de auditoría
-- Retención: 90 días para auth_audit_log, 365 días para audit_logs
-- ============================================================

-- Función de limpieza que puede invocarse desde un cron job externo
-- (Render cron, Supabase pg_cron, o llamada programada desde el backend)
CREATE OR REPLACE FUNCTION public.purge_old_audit_logs()
RETURNS TABLE(auth_log_deleted int, audit_log_deleted int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_deleted int;
  v_audit_deleted int;
BEGIN
  -- auth_audit_log: retener 90 días (eventos de autenticación)
  DELETE FROM auth_audit_log
  WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS v_auth_deleted = ROW_COUNT;

  -- audit_logs: retener 365 días (operaciones de negocio — fintechs suelen requerir 1 año)
  DELETE FROM audit_logs
  WHERE created_at < now() - interval '365 days';
  GET DIAGNOSTICS v_audit_deleted = ROW_COUNT;

  RETURN QUERY SELECT v_auth_deleted, v_audit_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_old_audit_logs() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.purge_old_audit_logs() TO service_role;

COMMENT ON FUNCTION public.purge_old_audit_logs IS
  'Elimina registros de auditoría expirados. Invocar desde cron job periódico (semanal).
   auth_audit_log: retención 90 días. audit_logs: retención 365 días.';

-- Programar limpieza semanal si pg_cron está disponible
-- (Supabase Pro/Team lo incluye; ignorar si no está instalado)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'purge-audit-logs-weekly',
      '0 3 * * 0',  -- Domingos a las 3:00 AM UTC
      'SELECT public.purge_old_audit_logs()'
    );
  END IF;
END;
$$;
