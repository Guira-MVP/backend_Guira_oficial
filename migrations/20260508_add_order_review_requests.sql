-- ═══════════════════════════════════════════════════════════════
--  order_review_requests
--  Solicitudes de creación de expediente que exceden el límite máximo.
--  El cliente envía la solicitud; el staff la revisa y aprueba o rechaza.
--  Si es aprobada, el backend crea el payment_order con el payload original.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS order_review_requests (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Quién solicitó
  user_id          UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Servicio y montos
  flow_type        TEXT         NOT NULL,
  amount           NUMERIC(18,2) NOT NULL,
  currency         TEXT         NOT NULL,
  amount_usd_equiv NUMERIC(18,2) NOT NULL,  -- equivalente USD al momento de la solicitud
  limit_usd        NUMERIC(18,2) NOT NULL,  -- límite máximo vigente en ese momento
  excess_usd       NUMERIC(18,2) NOT NULL,  -- cuánto excede (amount_usd - limit_usd)

  -- Payload completo serializado (para recrear la orden al aprobar)
  request_payload  JSONB        NOT NULL,

  -- Justificación del cliente
  client_reason    TEXT         NOT NULL,
  document_url     TEXT,

  -- Estado
  status           TEXT         NOT NULL DEFAULT 'pending_review',
  -- valores: pending_review | approved | rejected | expired | cancelled_by_user

  -- Revisión del staff
  reviewed_by      UUID         REFERENCES auth.users(id),
  reviewed_at      TIMESTAMPTZ,
  staff_notes      TEXT,

  -- Referencia al expediente generado si fue aprobado
  payment_order_id UUID         REFERENCES payment_orders(id),

  -- Expiración automática
  expires_at       TIMESTAMPTZ  NOT NULL,

  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_orr_user_id    ON order_review_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_orr_status     ON order_review_requests (status);
CREATE INDEX IF NOT EXISTS idx_orr_flow_type  ON order_review_requests (flow_type);
CREATE INDEX IF NOT EXISTS idx_orr_created_at ON order_review_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orr_expires_at ON order_review_requests (expires_at) WHERE status = 'pending_review';

-- RLS: solo service_role (el backend usa service_role)
ALTER TABLE order_review_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON order_review_requests
  FOR ALL USING (auth.role() = 'service_role');

-- Trigger updated_at
CREATE OR REPLACE FUNCTION update_order_review_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_review_requests_updated_at
  BEFORE UPDATE ON order_review_requests
  FOR EACH ROW EXECUTE FUNCTION update_order_review_requests_updated_at();

-- Configuración: horas antes de que una solicitud expire automáticamente
INSERT INTO app_settings (key, value, description)
VALUES ('ORDER_REVIEW_EXPIRY_HOURS', '48', 'Horas antes de que una solicitud de revisión por exceso de límite expire automáticamente')
ON CONFLICT (key) DO NOTHING;
