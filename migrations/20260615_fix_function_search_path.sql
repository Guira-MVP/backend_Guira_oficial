-- 20260615_fix_function_search_path.sql
--
-- Auditoría de seguridad Supabase 2026-06-15 — Hallazgos 4, 5, 7.
--
-- Fija search_path = public, pg_temp en funciones que el linter de Supabase
-- marcó como "Function Search Path Mutable" (0011_function_search_path_mutable).
-- Sin esto, una función puede resolver objetos sin calificar (p.ej. nombres
-- de tabla) contra un search_path controlado por quien la invoca.

ALTER FUNCTION public.claim_pending_webhooks(integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_payment_order_ids(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_customer_limit_overrides_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_order_review_requests_updated_at() SET search_path = public, pg_temp;
