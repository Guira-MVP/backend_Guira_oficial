-- Fix bug: trigger update_balance_on_ledger_entry calculaba available_amount
-- con fórmula incorrecta cuando existía reserved_amount activo durante el settle
-- de un débito (flujos off-ramp: bridge_wallet_to_fiat_us, bridge_wallet_to_crypto).
--
-- Síntoma: el webhook payment_processed completaba la payment_order y el
-- bridge_transfer, pero el ledger entry debit quedaba en 'pending' y el balance
-- no se descontaba. La release_reserved_balance restauraba el available,
-- dejando el saldo intacto como si el retiro no hubiera ocurrido.
--
-- Causa raíz: la fórmula antigua asumía que reserved=0 al momento del settle:
--   available = (amount + v_diff) - reserved  →  puede producir valores negativos
--   si reserved > 0, violando CHECK (available_amount >= 0). El UPDATE hace
--   rollback silencioso (el código no verificaba el error de Supabase).
--
-- Fix: para DEBIT, consumir la reserva primero (GREATEST 0) y sólo descontar
--   de available el exceso que no cubre la reserva (LEAST 0, v_diff + reserved).
--   Para CREDIT, el comportamiento es idéntico al anterior.
--
-- Fix adicional en webhooks.service.ts: release_reserved_balance se llama
--   ANTES de settle ledger (defensa en profundidad).

CREATE OR REPLACE FUNCTION update_balance_on_ledger_entry()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_user_id UUID;
    v_diff    numeric := 0;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'settled' THEN
            v_diff := CASE WHEN NEW.type = 'credit' THEN NEW.amount ELSE -NEW.amount END;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.status = 'settled' AND OLD.status <> 'settled' THEN
            v_diff := CASE WHEN NEW.type = 'credit' THEN NEW.amount ELSE -NEW.amount END;
        ELSIF OLD.status = 'settled' AND NEW.status <> 'settled' THEN
            v_diff := -(CASE WHEN OLD.type = 'credit' THEN OLD.amount ELSE -OLD.amount END);
        END IF;
    END IF;

    IF v_diff <> 0 THEN
        SELECT user_id INTO v_user_id FROM public.wallets WHERE id = NEW.wallet_id;
        IF v_user_id IS NOT NULL THEN
            INSERT INTO public.balances (user_id, currency, amount, available_amount)
            VALUES (v_user_id, NEW.currency, v_diff, GREATEST(v_diff, 0))
            ON CONFLICT (user_id, currency) DO UPDATE SET
                amount = balances.amount + EXCLUDED.amount,
                -- DEBIT (EXCLUDED.amount < 0): consume la reserva primero.
                --   reserved baja hasta 0 como mínimo (GREATEST 0).
                --   available sólo baja si el débito supera la reserva (LEAST 0).
                -- CREDIT (EXCLUDED.amount > 0): reserved no cambia; available sube.
                reserved_amount = CASE
                    WHEN EXCLUDED.amount < 0
                    THEN GREATEST(0, balances.reserved_amount + EXCLUDED.amount)
                    ELSE balances.reserved_amount
                END,
                available_amount = CASE
                    WHEN EXCLUDED.amount < 0
                    THEN balances.available_amount + LEAST(0, EXCLUDED.amount + balances.reserved_amount)
                    ELSE balances.available_amount + EXCLUDED.amount
                END,
                updated_at = NOW();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
