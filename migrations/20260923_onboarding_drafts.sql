-- ═══════════════════════════════════════════════════════════════════
--  Borrador de onboarding KYC/KYB guardado en la DB
--
--  Hasta ahora el progreso del formulario solo vivía en localStorage del
--  navegador (sin cifrar — hallazgo H-7 de la auditoría del 2026-09-16) y
--  los archivos solo se subían al presionar "Enviar Solicitud". Si el
--  cliente cambiaba de dispositivo o se le cortaba el internet perdía todo,
--  y el staff no veía nada de quien empezó y no terminó.
--
--  Decisiones:
--
--  1) Tabla aparte y no columnas en people/businesses/*_applications: el
--     borrador no pasa por los DTOs estrictos ni toca los datos que después
--     van al proveedor, y no dispara audit_sensitive_tables() (cada
--     autosave copiaría PII a audit_logs — hallazgo H-1).
--
--  2) Una fila por usuario (UNIQUE user_id) para que el backend haga un
--     upsert real ON CONFLICT y autosaves concurrentes no dupliquen filas.
--
--  3) La fila se BORRA al enviar la solicitud con éxito: desde ese momento
--     los datos viven en people/businesses y no queda una segunda copia.
--
--  4) Solo el backend (service_role) accede. Se revoca explícitamente a
--     anon y authenticated: REVOKE FROM PUBLIC no alcanza en Supabase.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.onboarding_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('personal', 'company')),
  step            smallint NOT NULL DEFAULT 2 CHECK (step BETWEEN 1 AND 6),

  -- Valores del formulario tal cual los tiene el cliente (sin validar:
  -- es un borrador). El backend limita tamaño, profundidad y claves.
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- [{ key, label, step, reason: 'missing'|'invalid', message }]
  -- Informativo para el staff; lo calcula el formulario con los mismos
  -- esquemas que validan el envío. No bloquea nada.
  missing_fields  jsonb NOT NULL DEFAULT '[]'::jsonb,
  progress_pct    smallint NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS onboarding_drafts_updated_at_idx
  ON public.onboarding_drafts (updated_at DESC);

DROP TRIGGER IF EXISTS trg_updated_at ON public.onboarding_drafts;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.onboarding_drafts
  FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

ALTER TABLE public.onboarding_drafts ENABLE ROW LEVEL SECURITY;
-- Sin policies a propósito: solo service_role (que ignora RLS).
REVOKE ALL ON TABLE public.onboarding_drafts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.onboarding_drafts TO service_role;

-- ── Documentos subidos durante el borrador ─────────────────────────
--
--  Los archivos ahora se suben en cuanto el cliente los elige.
--
--  is_draft  = subido y todavía no enviado a revisión. Mientras sea true,
--              reemplazarlo o quitarlo lo BORRA (Storage + fila): nadie lo
--              revisó y no tiene sentido guardar la foto equivocada. Al
--              enviar pasa a false y vuelve la regla de siempre (superseded,
--              con historial para compliance).
--  draft_key = a qué persona del formulario pertenece cuando todavía no
--              existe su fila en DB. Solo UBOs: 'ubo:<client_uid>'.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS draft_key text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS is_draft boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS documents_user_draft_key_active_idx
  ON public.documents (user_id, draft_key)
  WHERE status = 'pending';
