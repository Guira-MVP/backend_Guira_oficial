-- Reserva un lote de beneficiarios cripto pendientes de re-screening.
-- FOR UPDATE SKIP LOCKED + marca rescreen_claimed_at evita que dos
-- instancias del cron revisen (y facturen) la misma wallet.
-- Requiere 20260916203611_suppliers_compliance_status.sql.
-- Aplicada en staging como 20260916203623_claim_suppliers_for_rescreening.
create or replace function public.claim_suppliers_for_rescreening(
  p_interval_days integer default 30,
  p_batch_size integer default 25
)
 returns setof suppliers
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_cutoff timestamptz := NOW() - make_interval(days => GREATEST(COALESCE(p_interval_days, 30), 0));
  v_claim_cutoff timestamptz := NOW() - INTERVAL '1 hour';
BEGIN
  RETURN QUERY
  UPDATE suppliers s
  SET bank_details = jsonb_set(
        jsonb_set(
          COALESCE(s.bank_details, '{}'::jsonb),
          '{wallet_screening}',
          COALESCE(s.bank_details -> 'wallet_screening', '{}'::jsonb),
          true
        ),
        '{wallet_screening,rescreen_claimed_at}',
        to_jsonb(NOW()),
        true
      )
  WHERE s.id IN (
    SELECT inner_s.id
    FROM suppliers inner_s
    WHERE inner_s.payment_rail = 'crypto'
      AND inner_s.is_active = true
      AND inner_s.compliance_status IS NULL
      AND LOWER(COALESCE(inner_s.bank_details ->> 'wallet_network', 'solana'))
          IN ('ethereum', 'solana', 'tron', 'polygon')
      AND COALESCE(
            (inner_s.bank_details -> 'wallet_screening' ->> 'rescreen_claimed_at')::timestamptz,
            '-infinity'::timestamptz
          ) < v_claim_cutoff
      AND (
        inner_s.bank_details -> 'wallet_screening' IS NULL
        OR COALESCE(
             (inner_s.bank_details -> 'wallet_screening' ->> 'screened_at')::timestamptz,
             '-infinity'::timestamptz
           ) < v_cutoff
        OR inner_s.bank_details -> 'wallet_screening' ->> 'status' = 'Error'
      )
    ORDER BY COALESCE(
               (inner_s.bank_details -> 'wallet_screening' ->> 'screened_at')::timestamptz,
               '-infinity'::timestamptz
             ) ASC
    LIMIT GREATEST(COALESCE(p_batch_size, 25), 0)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING s.*;
END;
$function$;

revoke execute on function public.claim_suppliers_for_rescreening(integer, integer)
  from public, anon, authenticated;
