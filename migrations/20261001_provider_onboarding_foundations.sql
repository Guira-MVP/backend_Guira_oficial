-- Onboarding multiproveedor (Bridge + Tazapay) — fundaciones.
--
-- Al aprobar un KYC/KYB el staff ahora despacha a DOS proveedores. Cada uno
-- tiene su propia identidad del cliente y su propio estado, independientes
-- entre sí (la aprobación es por proveedor):
--
--   provider_accounts               identidad del usuario en cada proveedor
--                                   (cus_… en Bridge, ent_… en Tazapay).
--                                   profiles.bridge_customer_id se sigue
--                                   escribiendo como hoy; esta tabla es la
--                                   fuente nueva y se rellena desde ella.
--   provider_onboarding_submissions cada envío de un expediente KYC/KYB a un
--                                   proveedor, con estado, motivo de no
--                                   elegibilidad y último error.
--   provider_submission_documents   qué documento de Guira ya se subió a qué
--                                   proveedor, para que un reintento no lo
--                                   duplique (Tazapay sube archivo por archivo).
--
-- webhook_events: la unicidad pasa a (provider, provider_event_id) para que
-- dos proveedores con el mismo id de evento no se descarten entre sí.
--
-- Todas las tablas nuevas: RLS activo sin policies (solo service_role).
-- REVOKE explícito a anon y authenticated: REVOKE FROM PUBLIC no alcanza en
-- Supabase.

DO $$
BEGIN
  CREATE DOMAIN public.money_provider AS text
    CHECK (VALUE IN ('bridge', 'tazapay'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── provider_accounts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.provider_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider       public.money_provider NOT NULL,
  external_id    text,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'submitted', 'requires_action', 'approved', 'rejected', 'disabled')),
  raw_status     text,
  status_reason  text,
  approved_at    timestamptz,
  rejected_at    timestamptz,
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_provider_external_uq
  ON public.provider_accounts (provider, external_id) WHERE external_id IS NOT NULL;

-- Relleno: todo cliente con customer de Bridge.
INSERT INTO public.provider_accounts (user_id, provider, external_id, status, approved_at)
SELECT p.id,
       'bridge',
       p.bridge_customer_id,
       CASE WHEN p.onboarding_status = 'approved' THEN 'approved' ELSE 'submitted' END,
       CASE WHEN p.onboarding_status = 'approved' THEN p.updated_at END
FROM public.profiles p
WHERE p.bridge_customer_id IS NOT NULL
ON CONFLICT (user_id, provider) DO NOTHING;

-- ── provider_onboarding_submissions ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.provider_onboarding_submissions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider             public.money_provider NOT NULL,
  kyc_application_id   uuid REFERENCES public.kyc_applications(id) ON DELETE CASCADE,
  kyb_application_id   uuid REFERENCES public.kyb_applications(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN (
                         'pending', 'creating', 'draft', 'uploading_documents', 'submitted',
                         'requires_action', 'approved', 'rejected',
                         'failed_retryable', 'failed_terminal',
                         'not_eligible', 'pending_provider_confirmation'
                       )),
  raw_status           text,
  external_id          text,
  ineligibility_reason text,
  idempotency_key      text NOT NULL,
  attempt_count        integer NOT NULL DEFAULT 0,
  request_payload      jsonb,   -- REDACTADO: sin base64, sin URLs firmadas, sin credenciales
  response_payload     jsonb,
  last_error_code      text,
  last_error_message   text,
  submitted_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(kyc_application_id, kyb_application_id) = 1),
  UNIQUE (provider, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_kyc_provider_uq
  ON public.provider_onboarding_submissions (kyc_application_id, provider)
  WHERE kyc_application_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pos_kyb_provider_uq
  ON public.provider_onboarding_submissions (kyb_application_id, provider)
  WHERE kyb_application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_provider_status_idx
  ON public.provider_onboarding_submissions (provider, status, updated_at);
CREATE INDEX IF NOT EXISTS pos_user_idx
  ON public.provider_onboarding_submissions (user_id);

-- ── provider_submission_documents ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.provider_submission_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id      uuid NOT NULL REFERENCES public.provider_onboarding_submissions(id) ON DELETE CASCADE,
  document_id        uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  -- Casilla del proveedor a la que corresponde (un mismo archivo puede ir en
  -- dos: p. ej. el testimonio como estatutos y como estructura accionaria).
  slot               text NOT NULL,
  provider_file_name text,
  provider_url       text,
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, document_id, slot)
);

-- ── RLS y permisos ────────────────────────────────────────────────────────
ALTER TABLE public.provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_onboarding_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_submission_documents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.provider_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.provider_onboarding_submissions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.provider_submission_documents FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.provider_accounts TO service_role;
GRANT ALL ON TABLE public.provider_onboarding_submissions TO service_role;
GRANT ALL ON TABLE public.provider_submission_documents TO service_role;

-- ── webhook_events: unicidad por proveedor ────────────────────────────────
DROP INDEX IF EXISTS public.uq_webhook_events_provider_event_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_events_provider_provider_event_id
  ON public.webhook_events (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- ── Interruptor del envío a Tazapay ───────────────────────────────────────
INSERT INTO public.app_settings (key, value, type, description, is_public)
VALUES
  ('TAZAPAY_ONBOARDING_ENABLED', 'false', 'boolean',
   'Al aprobar un KYC/KYB, enviar también el expediente a Tazapay (además de Bridge).',
   false)
ON CONFLICT (key) DO NOTHING;
