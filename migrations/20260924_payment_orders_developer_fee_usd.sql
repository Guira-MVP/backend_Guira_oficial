-- bolivia_to_world pasa a ejecutarse siempre por Bridge Transfer con monto de
-- destino fijo (Fixed Outputs), y la comisión la cobra Bridge como developer_fee.
-- Se congela aquí, en USD, al crear el expediente, para que la aprobación envíe
-- exactamente ese valor sin reconvertir fee_amount (BOB) con otra tasa.
ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS developer_fee_usd numeric;

COMMENT ON COLUMN public.payment_orders.developer_fee_usd IS
  'Comisión en USD enviada a Bridge como developer_fee (bolivia_to_world). Congelada al crear el expediente.';
