-- ═══════════════════════════════════════════════════════════════
--  quote_history
--  Cotizaciones informales que el staff genera para prospectos que
--  preguntan por WhatsApp/llamada cuánto costaría un envío. No crea
--  órdenes ni toca fees_config/customer_fee_overrides: la comisión y
--  el spread aquí guardados son un override puntual, solo para el
--  PDF que se le envía a ese cliente.
--
--  comparison_flows (JSONB) — snapshot congelado de las alternativas
--  mostradas junto a la cotización principal en el PDF: otros países
--  del mismo flujo (a tarifa estándar, sin override) y el beneficio
--  de fondeo sin comisión (fiat_bo_to_bridge_wallet /
--  crypto_to_bridge_wallet). Se calcula en el frontend al momento de
--  generar la cotización y se guarda tal cual, para que el PDF sea
--  siempre reproducible con los mismos números que se le mostraron
--  al cliente.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS quote_history (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  flow                  TEXT          NOT NULL,
  flow_label            TEXT          NOT NULL,
  origin_currency       TEXT          NOT NULL,
  destination_currency  TEXT          NOT NULL,
  payment_rail          TEXT,
  amount_origin         NUMERIC(18,2) NOT NULL,
  exchange_rate         NUMERIC(18,6),
  commission_percent    NUMERIC(5,2)  NOT NULL,
  commission_amount     NUMERIC(18,2) NOT NULL,
  spread_percent        NUMERIC(5,2)  NOT NULL DEFAULT 0,
  net_amount            NUMERIC(18,2) NOT NULL,
  receives_amount       NUMERIC(18,2) NOT NULL,
  client_phone          TEXT          NOT NULL,
  client_name           TEXT,
  client_company        TEXT,
  notes                 TEXT,
  comparison_flows      JSONB,
  created_by            UUID          REFERENCES auth.users(id),
  created_by_name       TEXT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- comparison_flows debe ser siempre un array JSON cuando está presente
ALTER TABLE quote_history
  DROP CONSTRAINT IF EXISTS quote_history_comparison_flows_is_array;
ALTER TABLE quote_history
  ADD CONSTRAINT quote_history_comparison_flows_is_array
  CHECK (comparison_flows IS NULL OR jsonb_typeof(comparison_flows) = 'array');

-- Índices para el historial (búsqueda por staff, por teléfono, orden cronológico)
CREATE INDEX IF NOT EXISTS quote_history_created_by_idx
  ON quote_history (created_by);
CREATE INDEX IF NOT EXISTS quote_history_client_phone_idx
  ON quote_history (client_phone);
CREATE INDEX IF NOT EXISTS quote_history_created_at_idx
  ON quote_history (created_at DESC);

-- RLS
ALTER TABLE quote_history ENABLE ROW LEVEL SECURITY;

-- El backend usa service_role para todas las operaciones (patrón idéntico a announcements)
DROP POLICY IF EXISTS "service_role_full_access" ON quote_history;
CREATE POLICY "service_role_full_access" ON quote_history
  FOR ALL USING (auth.role() = 'service_role');

-- Defensa en profundidad: si algún día se lee directo desde el cliente Supabase,
-- solo staff/admin/super_admin pueden ver el historial de cotizaciones.
DROP POLICY IF EXISTS "staff_and_admin_read" ON quote_history;
CREATE POLICY "staff_and_admin_read" ON quote_history
  FOR SELECT USING (private.is_staff_or_admin());
