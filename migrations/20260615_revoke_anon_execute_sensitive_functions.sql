-- 20260615_revoke_anon_execute_sensitive_functions.sql
--
-- Auditoría de seguridad Supabase 2026-06-15 — Hallazgos 1, 4, 5, 6.
--
-- Varias funciones SECURITY DEFINER (y una función auxiliar de búsqueda)
-- tenían EXECUTE otorgado a PUBLIC/anon/authenticated, quedando expuestas
-- como RPCs públicas vía /rest/v1/rpc/<funcion> sin pasar por el backend
-- ni por RLS. Todas se usan exclusivamente desde el backend (NestJS) con
-- el cliente service_role, que conserva su GRANT EXECUTE explícito y no
-- se ve afectado por estos REVOKE.

-- Hallazgo 1 — RPCs financieras: permiten leer/modificar balances y
-- ledger_entries de cualquier usuario sin autenticación.
REVOKE EXECUTE ON FUNCTION public.reserve_balance(uuid, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_reserved_balance(uuid, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.settle_and_release_reserved(uuid, text, numeric, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_user_balance(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calculate_balance_from_ledger(uuid) FROM PUBLIC, anon, authenticated;

-- Hallazgo 4 — claim_pending_webhooks: "reclama" webhook_events pendientes
-- de Bridge; expuesta permitía interferir con el procesamiento de webhooks.
REVOKE EXECUTE ON FUNCTION public.claim_pending_webhooks(integer) FROM PUBLIC, anon, authenticated;

-- Hallazgo 5 — search_payment_order_ids: superficie RPC innecesaria, solo
-- usada por el backend (admin search de payment_orders).
REVOKE EXECUTE ON FUNCTION public.search_payment_order_ids(text) FROM PUBLIC, anon, authenticated;

-- Hallazgo 6 — funciones-trigger SECURITY DEFINER. No son invocables vía
-- RPC (Postgres rechaza ejecutar funciones RETURNS trigger fuera de un
-- trigger), pero se revoca EXECUTE por defense-in-depth / least privilege.
-- No afecta el disparo de los triggers (no depende de GRANT EXECUTE).
REVOKE EXECUTE ON FUNCTION public.audit_sensitive_tables() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_kyb_submitted() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_kyc_submitted() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_balance_on_ledger_entry() FROM PUBLIC, anon, authenticated;

-- Nota: is_staff_or_admin() NO se toca — se usa en ~40 políticas RLS
-- evaluadas para anon/authenticated; revocar EXECUTE rompería esas
-- políticas (ver auditoria_seguridad_supabase_2026-06-15.md, hallazgo 10).
