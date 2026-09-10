-- ═══════════════════════════════════════════════════════════════════════════
-- Switch por flujo de la puerta de revisión de staff — VARIANTE DE PRODUCCIÓN.
--
-- Idéntica a 20260909_flow_review_settings.sql salvo en un punto: la semilla de
-- los 10 flujos entra con requires_staff_review = FALSE.
--
-- POR QUÉ: en staging la puerta arranca encendida porque es el entorno donde se
-- prueba. En producción encenderla el día del deploy detiene la operativa de
-- golpe — todo expediente nuevo quedaría esperando a que un humano lo apruebe,
-- sin que el equipo esté organizado para atender esa cola. Se despliega apagada
-- y se enciende flujo por flujo desde el panel de staff (tab "Revisión"),
-- cuando el equipo esté listo.
--
-- LAS FILAS TIENEN QUE EXISTIR. FlowReviewSettingsService.requiresReview() es
-- fail-closed: si no encuentra fila para un flujo devuelve TRUE. Sembrar los 10
-- en false es justamente lo que mantiene la operativa igual tras el deploy.
--
-- Aplicar ANTES del deploy del backend, junto con las otras tres migraciones.
-- Aplicar SOLO en producción (hhvkphzfaxlwguvzguxf). En staging ya corrió
-- 20260909_flow_review_settings.sql con la semilla en true.
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

-- Semilla: los 10 flujos gobernados, todos con la revisión APAGADA.
INSERT INTO public.flow_review_settings (flow_type, label, flow_category, requires_staff_review, sort_order)
VALUES
  ('bolivia_to_world',          'Bolivia al exterior',            'interbank',   false, 10),
  ('bolivia_to_wallet',         'Bolivia a saldo',                'interbank',   false, 20),
  ('world_to_bolivia',          'Exterior a Bolivia',             'interbank',   false, 30),
  ('wallet_to_wallet',          'Saldo a saldo',                  'interbank',   false, 40),
  ('fiat_bo_to_bridge_wallet',  'Bolivianos a saldo',             'wallet_ramp', false, 50),
  ('crypto_to_bridge_wallet',   'Cripto a saldo',                 'wallet_ramp', false, 60),
  ('bridge_wallet_to_fiat_bo',  'Saldo a Bolivia',                'wallet_ramp', false, 70),
  ('bridge_wallet_to_crypto',   'Saldo a cripto',                 'wallet_ramp', false, 80),
  ('bridge_wallet_to_fiat_us',  'Saldo al exterior',              'wallet_ramp', false, 90),
  ('wallet_to_world',           'Wallet externa al exterior',     'wallet_ramp', false, 100)
ON CONFLICT (flow_type) DO NOTHING;

ALTER TABLE public.flow_review_settings ENABLE ROW LEVEL SECURITY;

-- El backend accede con service_role; el cliente no tiene por qué leer esta
-- tabla (su expediente ya le dice en qué estado está).
DROP POLICY IF EXISTS "service_role_full_access" ON public.flow_review_settings;
CREATE POLICY "service_role_full_access" ON public.flow_review_settings
  FOR ALL USING (auth.role() = 'service_role');

COMMIT;

-- ── Verificación posterior ─────────────────────────────────────────────────
-- Debe devolver 10 filas, todas en false:
-- SELECT flow_type, requires_staff_review FROM flow_review_settings ORDER BY sort_order;
