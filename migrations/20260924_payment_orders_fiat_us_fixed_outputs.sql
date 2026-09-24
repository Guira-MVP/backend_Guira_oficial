-- bridge_wallet_to_fiat_us con destino no-USD pasa a Fixed Outputs: el Transfer
-- lleva source.amount (USDC reservados) y destination.amount (lo que recibe el
-- proveedor, garantizado por Bridge). La diferencia contra el mínimo de Bridge
-- es el colchón/ganancia cambiaria (spread de USD_X) y termina en la wallet
-- "Fixed Outputs Excess Funds" como developer exchange fee.
ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS fx_mode text,
  ADD COLUMN IF NOT EXISTS fx_buffer_amount numeric,
  ADD COLUMN IF NOT EXISTS receipt_exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS developer_exchange_fee_amount numeric,
  ADD COLUMN IF NOT EXISTS developer_exchange_fee_currency text;

ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_fx_mode_check;
ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_fx_mode_check
  CHECK (fx_mode IS NULL OR fx_mode = 'fixed_output');

COMMENT ON COLUMN public.payment_orders.fx_mode IS
  'fixed_output: el monto destino (amount_destination) está garantizado por Bridge Fixed Outputs.';
COMMENT ON COLUMN public.payment_orders.fx_buffer_amount IS
  'USDC reservados por encima del mínimo de Bridge al cotizar (colchón = spread de USD_X).';
COMMENT ON COLUMN public.payment_orders.receipt_exchange_rate IS
  'receipt.exchange_rate de Bridge (destino / source original, incluye comisión). Solo Fixed Outputs.';
COMMENT ON COLUMN public.payment_orders.developer_exchange_fee_amount IS
  'Ganancia cambiaria real que Bridge acreditó a Guira (receipt.developer_exchange_fee.amount).';
COMMENT ON COLUMN public.payment_orders.developer_exchange_fee_currency IS
  'Divisa de developer_exchange_fee_amount (Bridge la reporta en la divisa destino).';
