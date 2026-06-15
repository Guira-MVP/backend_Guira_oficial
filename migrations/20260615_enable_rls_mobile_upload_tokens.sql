-- 20260615_enable_rls_mobile_upload_tokens.sql
--
-- Auditoría de seguridad Supabase 2026-06-15 — Hallazgo 2.
--
-- mobile_upload_tokens nunca tuvo RLS habilitado y además anon/authenticated
-- tenían SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER — es decir,
-- acceso CRUD completo a los tokens de onboarding móvil de cualquier usuario
-- desde /rest/v1/mobile_upload_tokens.
--
-- La tabla solo se usa desde onboarding.service.ts (createMobileToken,
-- resolveMobileToken, getMobileTokenStatus, completeMobileToken) con el
-- cliente service_role; el dispositivo móvil interactúa siempre a través de
-- endpoints del backend, nunca directo contra Supabase. Mismo patrón que
-- customer_limit_overrides / order_review_requests: RLS habilitado + policy
-- exclusiva para service_role.

ALTER TABLE public.mobile_upload_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_full_access ON public.mobile_upload_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.mobile_upload_tokens FROM anon, authenticated;
