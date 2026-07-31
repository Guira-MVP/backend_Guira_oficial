-- Fix causa B-variante del bug de saldo fantasma en retiros (diagnóstico 2026-07-31).
--
-- settle_and_release_reserved (usada solo por bridge_wallet_to_fiat_bo, ver
-- webhooks.service.ts handleTransferComplete) hacía:
--   1) UPDATE ledger_entries SET status='settled' — esto dispara el trigger
--      update_balance_on_ledger_entry, que YA ajusta correctamente
--      amount/reserved_amount/available_amount.
--   2) Un segundo UPDATE balances que volvía a mover reserved_amount y
--      available_amount por p_amount, duplicando el ajuste del paso 1.
--
-- Verificado en una transacción de prueba con ROLLBACK (cuenta QA, moneda
-- EURC aislada): tras el settle de un débito de 40 sobre un balance de 100,
-- `amount` bajaba correctamente a 60, pero `available_amount` quedaba en 100
-- (el trigger lo dejó en 60, y el segundo UPDATE de esta función lo revertía
-- sumando +40 de más). Mismo patrón que la causa B ya corregida en
-- webhooks.service.ts (release_reserved_balance duplicado con el trigger).
--
-- Fix: eliminar el segundo UPDATE de balances — el trigger pasa a ser la
-- única fuente de ajuste, igual que en el camino offRampFlows de TypeScript.

CREATE OR REPLACE FUNCTION public.settle_and_release_reserved(
  p_user_id uuid, p_currency text, p_amount numeric, p_reference_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.ledger_entries
     SET status = 'settled'
   WHERE reference_type = 'payment_order'
     AND reference_id = p_reference_id
     AND status = 'pending';
  -- El UPDATE anterior dispara update_balance_on_ledger_entry, que ya ajusta
  -- reserved_amount y available_amount correctamente. No volver a tocar
  -- balances aquí — hacerlo duplicaba el ajuste (causa B-variante).

  IF NOT EXISTS (
    SELECT 1 FROM public.balances WHERE user_id = p_user_id AND currency = p_currency
  ) THEN
    RAISE WARNING 'settle_and_release_reserved: no balance found for user % currency %', p_user_id, p_currency;
  END IF;
END;
$function$;
