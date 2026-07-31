-- Corrección puntual del saldo fantasma diagnosticado 2026-07-31 para
-- semperteguiemmanuel@gmail.com (USDC): amount=5.99, available_amount=102.70,
-- ambos deberían ser 0.
--
-- Causa: causas A+B combinadas (ver 20260620_fix_update_balance_on_ledger_entry_debit_reservation.sql
-- y el fix en webhooks.service.ts del mismo día que esta migración) — la
-- comisión de dos retiros nunca se descontó del saldo real (5.99 = suma de
-- ambas comisiones) y, por solapar dos retiros en el tiempo, el doble ajuste
-- de reserved/available infló available_amount hasta 102.70.
--
-- Un solo ajuste de ledger no alcanza: un débito de 5.99 vía el trigger deja
-- amount en 0 pero solo baja available_amount a 96.71 (102.70-5.99), no a 0,
-- porque esa inflación no vino de una reserva legítima sino del bug. Se
-- corrige en dos pasos dentro de la misma transacción.

DO $$
DECLARE
  v_user_id uuid;
  v_wallet_id uuid;
  v_currency text := 'USDC';
  v_amount_before numeric;
  v_available_before numeric;
  v_reserved_before numeric;
  v_ledger_entry_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM public.profiles WHERE email = 'semperteguiemmanuel@gmail.com';
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuario semperteguiemmanuel@gmail.com no encontrado';
  END IF;

  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_user_id AND is_active = true LIMIT 1;
  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'Wallet activa no encontrada para user %', v_user_id;
  END IF;

  SELECT amount, available_amount, reserved_amount
    INTO v_amount_before, v_available_before, v_reserved_before
    FROM public.balances
   WHERE user_id = v_user_id AND currency = v_currency
   FOR UPDATE;

  -- Guard: abortar si el saldo ya no coincide con el diagnosticado, para no
  -- aplicar esta corrección puntual sobre un estado distinto del verificado.
  IF round(v_amount_before, 2) <> 5.99 OR round(v_available_before, 2) <> 102.70 THEN
    RAISE EXCEPTION 'Balance actual (amount=%, available=%) no coincide con el diagnostico (5.99/102.70) - abortar', v_amount_before, v_available_before;
  END IF;

  -- Paso 1: ledger de ajuste manual, debit de 5.99 — lleva `amount` a 0 vía
  -- el trigger y mantiene la trazabilidad contable (reconciliation.service.ts
  -- compara sum(ledger settled) vs balances.amount).
  INSERT INTO public.ledger_entries (wallet_id, type, amount, currency, status, reference_type, description, metadata)
  VALUES (
    v_wallet_id, 'debit', 5.99, v_currency, 'settled', 'manual_adjustment',
    'Correccion saldo fantasma - comision de retiro nunca descontada (causas A+B, diagnostico 2026-07-31)',
    jsonb_build_object('fix', 'phantom_balance_2026_07')
  )
  RETURNING id INTO v_ledger_entry_id;

  -- Paso 2: corrección directa del remanente de available_amount que el
  -- trigger no puede resolver con un único diff (ver razonamiento arriba).
  UPDATE public.balances
     SET available_amount = 0, updated_at = NOW()
   WHERE user_id = v_user_id AND currency = v_currency;

  INSERT INTO public.audit_logs (performed_by, role, action, table_name, record_id, reason, previous_values, new_values, source)
  VALUES (
    NULL, 'system', 'BALANCE_MANUAL_ADJUSTMENT', 'balances', v_wallet_id,
    'Correccion saldo fantasma - ver ledger_entry ' || v_ledger_entry_id,
    jsonb_build_object('amount', v_amount_before, 'available_amount', v_available_before, 'reserved_amount', v_reserved_before),
    jsonb_build_object('amount', 0, 'available_amount', 0, 'reserved_amount', v_reserved_before),
    'migration_20260731_fix_semperteguiemmanuel_phantom_balance'
  );

  -- Verificación final dentro de la misma transacción
  PERFORM 1 FROM public.balances
   WHERE user_id = v_user_id AND currency = v_currency
     AND round(amount, 2) = 0 AND round(available_amount, 2) = 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verificacion post-fix fallo - revisar manualmente antes de commitear';
  END IF;
END $$;
