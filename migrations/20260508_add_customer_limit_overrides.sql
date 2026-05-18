-- ═══════════════════════════════════════════════════════════════
--  customer_limit_overrides
--  Límites personalizados de monto (min/max USD) por cliente VIP.
--  Mismo patrón que customer_fee_overrides.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS customer_limit_overrides (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  flow_type     TEXT        NOT NULL,          -- uno de los 9 servicios
  min_usd       NUMERIC(18,2),                 -- NULL = usar global
  max_usd       NUMERIC(18,2),                 -- NULL = usar global
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  valid_from    DATE        NOT NULL DEFAULT CURRENT_DATE,
  valid_until   DATE,                          -- NULL = sin vencimiento
  notes         TEXT,
  created_by    UUID        REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Constraint: no dos overrides ACTIVOS para el mismo (user_id, flow_type)
CREATE UNIQUE INDEX IF NOT EXISTS customer_limit_overrides_active_uniq
  ON customer_limit_overrides (user_id, flow_type)
  WHERE is_active = TRUE;

-- Índices de consulta
CREATE INDEX IF NOT EXISTS customer_limit_overrides_user_id_idx
  ON customer_limit_overrides (user_id);

CREATE INDEX IF NOT EXISTS customer_limit_overrides_flow_type_idx
  ON customer_limit_overrides (flow_type);

-- RLS
ALTER TABLE customer_limit_overrides ENABLE ROW LEVEL SECURITY;

-- Solo service_role puede leer/escribir (el backend usa service_role)
CREATE POLICY "service_role_full_access" ON customer_limit_overrides
  FOR ALL USING (auth.role() = 'service_role');

-- Trigger para updated_at automático
CREATE OR REPLACE FUNCTION update_customer_limit_overrides_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_limit_overrides_updated_at
  BEFORE UPDATE ON customer_limit_overrides
  FOR EACH ROW EXECUTE FUNCTION update_customer_limit_overrides_updated_at();
