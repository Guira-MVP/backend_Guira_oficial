-- ============================================================
-- Migration: session_management_rpcs
-- Purpose: RPCs con SECURITY DEFINER para que el backend
--          pueda listar y revocar sesiones activas del usuario
--          accediendo al esquema auth (no expuesto por PostgREST).
-- Date: 2026-06-16
-- ============================================================

-- 1. Listar sesiones activas de un usuario
CREATE OR REPLACE FUNCTION public.get_user_sessions(p_user_id uuid)
RETURNS TABLE (
  id          uuid,
  created_at  timestamptz,
  updated_at  timestamptz,
  user_agent  text,
  ip          text,
  aal         text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = auth, public
AS $$
  SELECT
    s.id,
    s.created_at,
    s.updated_at,
    s.user_agent,
    host(s.ip) AS ip,   -- inet → text sin el sufijo /32
    s.aal::text
  FROM auth.sessions s
  WHERE s.user_id = p_user_id
    AND (s.not_after IS NULL OR s.not_after > NOW())
  ORDER BY s.updated_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_user_sessions(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_user_sessions(uuid) TO service_role;

-- 2. Revocar una sesión específica (solo si pertenece al usuario)
CREATE OR REPLACE FUNCTION public.revoke_user_session(p_user_id uuid, p_session_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = auth, public
AS $$
  DELETE FROM auth.sessions
  WHERE id      = p_session_id
    AND user_id = p_user_id;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_user_session(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.revoke_user_session(uuid, uuid) TO service_role;

-- 3. Revocar todas las sesiones del usuario excepto la actual
CREATE OR REPLACE FUNCTION public.revoke_other_sessions(p_user_id uuid, p_current_session_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public
AS $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM auth.sessions
  WHERE user_id = p_user_id
    AND id <> p_current_session_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_other_sessions(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.revoke_other_sessions(uuid, uuid) TO service_role;
