-- ============================================================
-- Migration: session_metadata
-- Purpose: Que el panel "Sesiones activas" muestre el dispositivo e IP
--          reales del usuario en vez de los del servidor.
-- Date: 2026-09-01
-- ============================================================
--
-- PROBLEMA
-- auth.sessions.user_agent / .ip los escribe GoTrue con los datos de QUIEN LE
-- HACE LA PETICION A EL, y en Guira hay tres actores tocando la misma sesion:
--
--   Backend NestJS      login (signInWithPassword corre en servidor)  -> 'node'
--   Middleware Next.js  refresco SSR en cada request                  -> 'Next.js Middleware'
--   Navegador           auto-refresh de supabase-js                   -> UA real
--
-- Cada fila acaba mostrando a quien la toco por ultimo. Medido en produccion:
-- 27 de 42 sesiones vivas (64%) tenian 'node' o 'Next.js Middleware' con la IP
-- de Render (74.220.50.x). En el panel salian como "Navegador desconocido".
--
-- SOLUCION
-- Guardar aparte los datos buenos. En el login el navegador llama a
-- POST /auth/login contra NUESTRO backend, asi que llega su User-Agent real y
-- —desde que trust proxy usa lista de CIDRs— tambien su IP real.
-- get_user_sessions prefiere este metadato y cae a auth.sessions si no existe,
-- de modo que las sesiones anteriores a esta migracion siguen mostrandose.

-- ── 1. La tabla ──────────────────────────────────────────────
-- FK contra auth.sessions con ON DELETE CASCADE: cuando GoTrue purga la
-- sesion (logout, timeout de inactividad, revocacion), su metadato se va con
-- ella. Sin cron ni limpieza manual.
CREATE TABLE IF NOT EXISTS public.session_metadata (
  session_id uuid PRIMARY KEY
    REFERENCES auth.sessions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_metadata_user_id
  ON public.session_metadata (user_id);

COMMENT ON TABLE public.session_metadata IS
  'Dispositivo e IP reales desde los que nacio cada sesion. auth.sessions no '
  'sirve para esto porque GoTrue graba ahi los datos de quien le hace la '
  'peticion, que en Guira es el backend o el middleware SSR, no el navegador.';

-- ── 2. Permisos ──────────────────────────────────────────────
-- Solo el backend (service_role). RLS activo sin policies = denegar a todos;
-- service_role bypasea RLS. REVOKE ... FROM PUBLIC no basta en Supabase: hay
-- que revocar explicitamente a anon y authenticated, que reciben grants via
-- ALTER DEFAULT PRIVILEGES. Ver 20260828_harden_revoke_all_sessions_grants.sql.
ALTER TABLE public.session_metadata ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.session_metadata FROM PUBLIC;
REVOKE ALL ON TABLE public.session_metadata FROM anon, authenticated;
GRANT  ALL ON TABLE public.session_metadata TO service_role;

-- ── 3. get_user_sessions prefiere el metadato propio ─────────
-- Mismas columnas de salida y mismos permisos que antes: el contrato con el
-- backend no cambia. El coalesce hace la migracion transparente — las sesiones
-- creadas antes de hoy no tienen metadato y siguen leyendo de auth.sessions.
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
    COALESCE(m.user_agent, s.user_agent)      AS user_agent,
    COALESCE(m.ip_address, host(s.ip))        AS ip,
    s.aal::text
  FROM auth.sessions s
  LEFT JOIN public.session_metadata m ON m.session_id = s.id
  WHERE s.user_id = p_user_id
    AND (s.not_after IS NULL OR s.not_after > NOW())
  ORDER BY s.updated_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_user_sessions(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_user_sessions(uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_user_sessions(uuid) TO service_role;
