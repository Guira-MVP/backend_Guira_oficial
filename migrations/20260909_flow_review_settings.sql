-- ═══════════════════════════════════════════════════════════════════════════
-- Switch por flujo de la puerta de revisión de staff.
--
-- Hasta ahora la puerta estaba cableada a 4 flujos en el código. Con esta tabla
-- el staff decide desde el panel, flujo por flujo, si el expediente pasa por
-- revisión humana antes de ejecutarse o si sale directo como antes.
--
-- Los 10 flujos arrancan con la revisión ACTIVADA: es la política pedida
-- ("que siempre haya una validación por el staff"). El panel permite apagarla
-- por flujo cuando el volumen no la justifique.
--
-- Aplicar ANTES del deploy del backend: sin filas, resolveFlowReviewSetting cae
-- al valor por defecto seguro (revisión activada) y la cola se llenaría igual,
-- pero el panel no tendría nada que mostrar.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.flow_review_settings (
  flow_type text PRIMARY KEY,
  -- Etiqueta en español para el panel. Vive en la tabla y no en el frontend
  -- para que añadir un flujo nuevo no exija tocar dos repos.
  label text NOT NULL,
  -- Agrupación visual del panel: coincide con payment_orders.flow_category.
  flow_category text NOT NULL CHECK (flow_category IN ('interbank', 'wallet_ramp')),
  requires_staff_review boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.flow_review_settings IS
  'Switch por flujo de la puerta de revision de staff. requires_staff_review=true '
  'hace que el expediente nazca en pending_review y no se ejecute (ni se muestren '
  'instrucciones de deposito al cliente) hasta que un miembro del staff lo apruebe.';

COMMENT ON COLUMN public.flow_review_settings.requires_staff_review IS
  'Apagarlo NO afecta a los expedientes que ya estan en pending_review: esos '
  'siguen necesitando una decision del staff. Solo cambia el comportamiento de '
  'los expedientes que se creen a partir de ese momento.';

-- Semilla: los 10 flujos gobernados, todos con revisión activada.
INSERT INTO public.flow_review_settings (flow_type, label, flow_category, requires_staff_review, sort_order)
VALUES
  ('bolivia_to_world',          'Bolivia al exterior',            'interbank',   true, 10),
  ('bolivia_to_wallet',         'Bolivia a saldo',                'interbank',   true, 20),
  ('world_to_bolivia',          'Exterior a Bolivia',             'interbank',   true, 30),
  ('wallet_to_wallet',          'Saldo a saldo',                  'interbank',   true, 40),
  ('fiat_bo_to_bridge_wallet',  'Bolivianos a saldo',             'wallet_ramp', true, 50),
  ('crypto_to_bridge_wallet',   'Cripto a saldo',                 'wallet_ramp', true, 60),
  ('bridge_wallet_to_fiat_bo',  'Saldo a Bolivia',                'wallet_ramp', true, 70),
  ('bridge_wallet_to_crypto',   'Saldo a cripto',                 'wallet_ramp', true, 80),
  ('bridge_wallet_to_fiat_us',  'Saldo al exterior',              'wallet_ramp', true, 90),
  ('wallet_to_world',           'Wallet externa al exterior',     'wallet_ramp', true, 100)
ON CONFLICT (flow_type) DO NOTHING;

ALTER TABLE public.flow_review_settings ENABLE ROW LEVEL SECURITY;

-- El backend accede con service_role; el cliente no tiene por qué leer esta
-- tabla (su expediente ya le dice en qué estado está).
DROP POLICY IF EXISTS "service_role_full_access" ON public.flow_review_settings;
CREATE POLICY "service_role_full_access" ON public.flow_review_settings
  FOR ALL USING (auth.role() = 'service_role');

COMMIT;

-- ── Verificación posterior ─────────────────────────────────────────────────
-- SELECT flow_type, requires_staff_review FROM flow_review_settings ORDER BY sort_order;
