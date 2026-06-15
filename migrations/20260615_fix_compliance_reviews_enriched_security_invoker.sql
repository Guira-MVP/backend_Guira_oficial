-- 20260615_fix_compliance_reviews_enriched_security_invoker.sql
--
-- Auditoría de seguridad Supabase 2026-06-15 — Hallazgo 3.
--
-- La vista compliance_reviews_enriched (20260527_compliance_reviews_enriched_view.sql)
-- se creó sin `security_invoker`, por lo que se ejecuta con los privilegios
-- del propietario de la vista e ignora el RLS de compliance_reviews,
-- kyc_applications, kyb_applications, profiles y businesses. Como la vista
-- tiene SELECT otorgado a anon/authenticated (default del esquema public),
-- cualquiera podía leer PII y observaciones de compliance de todos los
-- usuarios via /rest/v1/compliance_reviews_enriched.
--
-- Con security_invoker = on, la vista respeta el RLS de las tablas
-- subyacentes para el rol que consulta: anon/clientes no-staff obtienen 0
-- filas (igual que consultando las tablas directamente), staff sigue viendo
-- todo (is_staff_or_admin()), y el backend (service_role, que ya bypassea
-- RLS) no cambia su comportamiento.

ALTER VIEW public.compliance_reviews_enriched SET (security_invoker = on);
