-- ═══════════════════════════════════════════════════════════════
--  announcements
--  Comunicados de novedades que el staff publica desde el panel y
--  que el cliente ve como un modal al iniciar sesión.
--
--  Contenido estructurado:
--    title / badge / body  → cabecera del modal
--    items (JSONB)         → lista [{ flag, label, description }]
--    cta_label / cta_url   → botón opcional
--
--  version se incrementa al editar el contenido: sirve para que un
--  cliente que ya cerró el modal vuelva a verlo tras una edición.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS announcements (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT        NOT NULL,
  badge        TEXT,                              -- p.ej. "Próximamente"
  body         TEXT,                              -- párrafo introductorio
  items        JSONB       NOT NULL DEFAULT '[]', -- [{ "flag": "PE", "label": "Perú", "description": "…" }]
  cta_label    TEXT,
  cta_url      TEXT,
  version      INT         NOT NULL DEFAULT 1,
  is_active    BOOLEAN     NOT NULL DEFAULT FALSE,
  publish_at   TIMESTAMPTZ,                       -- NULL = visible desde ya
  expires_at   TIMESTAMPTZ,                       -- NULL = sin caducidad
  created_by   UUID        REFERENCES auth.users(id),
  updated_by   UUID        REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- items debe ser siempre un array JSON
ALTER TABLE announcements
  DROP CONSTRAINT IF EXISTS announcements_items_is_array;
ALTER TABLE announcements
  ADD CONSTRAINT announcements_items_is_array
  CHECK (jsonb_typeof(items) = 'array');

-- Vigencia coherente
ALTER TABLE announcements
  DROP CONSTRAINT IF EXISTS announcements_valid_window;
ALTER TABLE announcements
  ADD CONSTRAINT announcements_valid_window
  CHECK (publish_at IS NULL OR expires_at IS NULL OR expires_at > publish_at);

-- Índice para la consulta del cliente (anuncio activo más reciente)
CREATE INDEX IF NOT EXISTS announcements_active_idx
  ON announcements (created_at DESC)
  WHERE is_active = TRUE;

-- RLS
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

-- Solo service_role puede leer/escribir (el backend usa service_role)
DROP POLICY IF EXISTS "service_role_full_access" ON announcements;
CREATE POLICY "service_role_full_access" ON announcements
  FOR ALL USING (auth.role() = 'service_role');

-- Trigger para updated_at automático
CREATE OR REPLACE FUNCTION update_announcements_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_announcements_updated_at ON announcements;
CREATE TRIGGER trg_announcements_updated_at
  BEFORE UPDATE ON announcements
  FOR EACH ROW EXECUTE FUNCTION update_announcements_updated_at();
