-- ============================================================
-- Migration: webhook_events_unique_provider_event_id
-- Purpose: Hacer efectiva la deduplicacion de webhooks de Bridge.
-- Date: 2026-09-01
-- ============================================================
--
-- PROBLEMA
-- webhooks.service.ts (sinkEvent) captura el error 23505 con el comentario
-- "Evento duplicado ignorado" y hace return sin procesar. La intencion es
-- correcta, pero NUNCA se ejecuta: sobre provider_event_id solo existia
-- idx_webhook_events_provider_event_id, un btree normal. Un indice sirve para
-- buscar rapido, no para impedir repetidos, asi que la base jamas devolvia
-- 23505 y cada reintento de Bridge se insertaba y se procesaba otra vez.
--
-- Estado medido en produccion antes de esta migracion:
--   1367 filas | 18 provider_event_id duplicados | 46 filas excedentes
--   los 18 duplicados fueron procesados mas de una vez
--   tipos afectados: virtual_account.activity.created (depositos),
--                    bridge_wallet.activity.created, transfer.updated
--
-- POR QUE ES SEGURO PONER LA CONSTRAINT
-- El riesgo seria descartar eventos legitimos distintos que compartieran id.
-- Verificado que no ocurre: los 18 ids duplicados tienen todos
-- count(distinct event_type)=1, count(distinct raw_payload)=1 y
-- count(distinct status)=1 — son copias byte a byte, reintentos puros de
-- Bridge. Los ids son de la forma wh_<...>, identificadores de entrega unicos
-- por evento. La constraint solo puede rechazar reentregas identicas.
--
-- NO HACE FALTA TOCAR EL BACKEND: al existir la constraint, el if del 23505
-- que ya esta escrito empieza a funcionar como su autor pretendia.

-- Sin BEGIN/COMMIT explicito: el runner de migraciones ya envuelve el script
-- en una transaccion, y anidarla haria que el COMMIT de aqui cerrara la suya.
-- Es la convencion del resto de migraciones del repo.

-- ── 1. Tabla de archivo ──────────────────────────────────────
-- Se archivan, NO se borran: son registro de auditoria de una fintech.
CREATE TABLE IF NOT EXISTS public.webhook_events_duplicates (
  LIKE public.webhook_events INCLUDING DEFAULTS
);

ALTER TABLE public.webhook_events_duplicates
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.webhook_events_duplicates IS
  'Reentregas identicas de Bridge que se insertaron por duplicado antes de '
  'existir uq_webhook_events_provider_event_id (2026-09-01). Se conservan por '
  'auditoria; no las consume ningun proceso.';

-- ── 2. Mover las filas excedentes ────────────────────────────
-- Se conserva la primera recibida de cada provider_event_id. El desempate por
-- id evita que dos filas con el mismo received_at se conserven ambas (o
-- ninguna), que dejaria la migracion a medias y haria fallar el paso 3.
WITH excedentes AS (
  SELECT w.id
  FROM public.webhook_events w
  WHERE w.provider_event_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.webhook_events x
      WHERE x.provider_event_id = w.provider_event_id
        AND (x.received_at < w.received_at
          OR (x.received_at = w.received_at AND x.id < w.id))
    )
),
movidas AS (
  DELETE FROM public.webhook_events w
  USING excedentes e
  WHERE w.id = e.id
  RETURNING w.*
)
INSERT INTO public.webhook_events_duplicates (
  id, provider, event_type, provider_event_id, raw_payload, headers,
  signature_verified, status, retry_count, last_error, bridge_api_version,
  received_at, processing_started_at, processed_at
)
SELECT
  id, provider, event_type, provider_event_id, raw_payload, headers,
  signature_verified, status, retry_count, last_error, bridge_api_version,
  received_at, processing_started_at, processed_at
FROM movidas;

-- ── 3. La constraint ─────────────────────────────────────────
-- Indice PARCIAL: hay 8 filas legitimas con provider_event_id NULL (llegaron
-- sin id de entrega). Un indice unico normal solo admitiria una de ellas y la
-- migracion fallaria.
--
-- Sin CONCURRENTLY a proposito: no puede correr dentro de una transaccion y
-- aqui la tabla tiene ~1300 filas, asi que el lock dura milisegundos.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_events_provider_event_id
  ON public.webhook_events (provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- ── 4. Permisos de la tabla de archivo ───────────────────────
-- Mismo criterio que el resto del esquema: solo el backend (service_role).
-- REVOKE ... FROM PUBLIC no basta en Supabase — hay que revocar de forma
-- explicita a anon y authenticated, que reciben grants via ALTER DEFAULT
-- PRIVILEGES. Ver 20260828_harden_revoke_all_sessions_grants.sql.
ALTER TABLE public.webhook_events_duplicates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.webhook_events_duplicates FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_events_duplicates FROM anon, authenticated;
GRANT  ALL ON TABLE public.webhook_events_duplicates TO service_role;
