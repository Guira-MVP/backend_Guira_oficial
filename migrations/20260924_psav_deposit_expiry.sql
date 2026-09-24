-- Plazo de depósito del cliente en los flujos con depósito PSAV
-- (bolivia_to_world, bolivia_to_wallet, world_to_bolivia, fiat_bo_to_bridge_wallet).
-- El plazo arranca cuando el expediente pasa a 'waiting_deposit' y un cron
-- cancela los vencidos, registrando cancelled_by_role = 'system'.

ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS deposit_expires_at timestamptz;

COMMENT ON COLUMN public.payment_orders.deposit_expires_at IS
  'Vencimiento del plazo para que el cliente deposite y suba el comprobante (flujos PSAV). NULL = sin plazo.';

CREATE INDEX IF NOT EXISTS idx_po_waiting_deposit_expires
  ON public.payment_orders (deposit_expires_at)
  WHERE status = 'waiting_deposit';

ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_cancelled_by_role_check;
ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_cancelled_by_role_check
  CHECK (cancelled_by_role IS NULL OR cancelled_by_role = ANY (ARRAY['client'::text, 'staff'::text, 'system'::text]));

INSERT INTO public.app_settings (key, value, type, description)
VALUES (
  'PSAV_DEPOSIT_EXPIRY_MINUTES',
  '10',
  'string',
  'Minutos que tiene el cliente para depositar y subir el comprobante en flujos PSAV antes de la cancelación automática'
)
ON CONFLICT (key) DO NOTHING;
