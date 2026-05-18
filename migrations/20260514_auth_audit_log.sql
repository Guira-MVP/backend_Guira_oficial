-- ============================================================
-- Migration: auth_audit_log
-- OWASP A07 Fix - Hallazgo 5: Auditoría de eventos de autenticación
-- ============================================================
-- Tabla para registrar eventos críticos de autenticación:
--   login_success, login_failed, register_success, register_duplicate,
--   logout, token_refresh, token_refresh_failed,
--   password_reset_request, password_reset_success, password_reset_failed
-- ============================================================

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    TEXT NOT NULL,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email         TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  metadata      JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice para consultas por usuario
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_user_id
  ON auth_audit_log (user_id)
  WHERE user_id IS NOT NULL;

-- Índice para consultas por tipo de evento + fecha
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_event_type_created
  ON auth_audit_log (event_type, created_at DESC);

-- Índice para detección de ataques por IP
CREATE INDEX IF NOT EXISTS idx_auth_audit_log_ip_created
  ON auth_audit_log (ip_address, created_at DESC)
  WHERE ip_address IS NOT NULL;

-- RLS: solo el service_role puede insertar/leer (el backend usa service_role)
ALTER TABLE auth_audit_log ENABLE ROW LEVEL SECURITY;

-- Política: no se permite acceso directo desde clientes (anon/authenticated)
-- El backend inserta usando service_role que bypasea RLS.
-- Si se necesita consultar desde un panel admin, crear una política específica.

COMMENT ON TABLE auth_audit_log IS 'Registro de auditoría de eventos de autenticación (OWASP A07)';
COMMENT ON COLUMN auth_audit_log.event_type IS 'Tipo de evento: login_success, login_failed, register_success, logout, password_reset_request, etc.';
COMMENT ON COLUMN auth_audit_log.metadata IS 'Datos adicionales del evento (ej: error_message para fallos)';
