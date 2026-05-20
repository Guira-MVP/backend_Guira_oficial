-- ── auth_rate_limits ────────────────────────────────────────────────────────
-- Tabla de seguimiento de intentos por IP para el RateLimitGuard.
-- Faltaba migration; la lógica ya existía en rate-limit.guard.ts.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier       TEXT NOT NULL,
  identifier_type  TEXT NOT NULL DEFAULT 'ip',
  action           TEXT NOT NULL,
  attempt_count    INTEGER DEFAULT 0,
  first_attempt_at TIMESTAMPTZ,
  last_attempt_at  TIMESTAMPTZ,
  blocked_until    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE(identifier, identifier_type, action)
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_identifier_action
  ON auth_rate_limits(identifier, action);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_blocked_until
  ON auth_rate_limits(blocked_until);

-- Solo el backend (service role) accede a esta tabla
ALTER TABLE auth_rate_limits ENABLE ROW LEVEL SECURITY;

-- ── Configuración dinámica del rate limiter ──────────────────────────────────
-- Permite modificar los parámetros desde el dashboard de staff sin reiniciar.
INSERT INTO app_settings (key, value, type, description, is_public, updated_at)
VALUES
  ('RATE_LIMIT_MAX_ATTEMPTS',   '5',  'number', 'Intentos máximos antes de bloquear por IP',        false, now()),
  ('RATE_LIMIT_WINDOW_MINUTES', '15', 'number', 'Ventana de tiempo para contar intentos (minutos)',  false, now()),
  ('RATE_LIMIT_BLOCK_MINUTES',  '15', 'number', 'Duración del bloqueo tras exceder el límite (min)', false, now())
ON CONFLICT (key) DO NOTHING;
