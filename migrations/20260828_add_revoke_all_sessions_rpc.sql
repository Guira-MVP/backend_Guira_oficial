-- ============================================================
-- Migration: add_revoke_all_sessions_rpc
-- Purpose: RPC con SECURITY DEFINER para revocar TODAS las sesiones
--          de un usuario (incluida la actual), usado tras un reset
--          de contraseña vía enlace de recuperación. Complementa a
--          revoke_other_sessions (que preserva la sesión actual).
-- Date: 2026-08-28
-- ============================================================

CREATE OR REPLACE FUNCTION public.revoke_all_sessions(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public
AS $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM auth.sessions
  WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- REVOKE ... FROM PUBLIC no basta: Supabase concede EXECUTE de forma
-- EXPLICITA a anon y authenticated via ALTER DEFAULT PRIVILEGES, y esas
-- concesiones sobreviven al revoke sobre PUBLIC. Sin la segunda linea, la
-- funcion queda expuesta en /rest/v1/rpc/revoke_all_sessions y cualquiera
-- podria cerrar las sesiones de cualquier usuario.
REVOKE EXECUTE ON FUNCTION public.revoke_all_sessions(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revoke_all_sessions(uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.revoke_all_sessions(uuid) TO service_role;
