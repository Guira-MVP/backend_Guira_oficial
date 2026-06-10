-- ═══════════════════════════════════════════════════════════════
--  customer_flow_overrides
--  Override global por cliente de la visibilidad de un flujo de servicio.
--  Prioritario sobre la regla por país; aplica también a clientes bolivianos.
--  Mismo patrón que customer_limit_overrides.
--
--  Tri-estado:
--    fila is_enabled = TRUE   → forzar VISIBLE
--    fila is_enabled = FALSE  → forzar OCULTO
--    sin fila activa          → default por país (profiles.country_code)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS customer_flow_overrides (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  flow_type     TEXT        NOT NULL,          -- uno de los 9 flujos gobernados
  is_enabled    BOOLEAN     NOT NULL,          -- TRUE = forzar visible, FALSE = forzar oculto
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_by    UUID        REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Constraint: no dos overrides ACTIVOS para el mismo (user_id, flow_type)
CREATE UNIQUE INDEX IF NOT EXISTS customer_flow_overrides_active_uniq
  ON customer_flow_overrides (user_id, flow_type)
  WHERE is_active = TRUE;

-- Índices de consulta
CREATE INDEX IF NOT EXISTS customer_flow_overrides_user_id_idx
  ON customer_flow_overrides (user_id);

CREATE INDEX IF NOT EXISTS customer_flow_overrides_flow_type_idx
  ON customer_flow_overrides (flow_type);

-- RLS
ALTER TABLE customer_flow_overrides ENABLE ROW LEVEL SECURITY;

-- Solo service_role puede leer/escribir (el backend usa service_role)
CREATE POLICY "service_role_full_access" ON customer_flow_overrides
  FOR ALL USING (auth.role() = 'service_role');

-- Trigger para updated_at automático
CREATE OR REPLACE FUNCTION update_customer_flow_overrides_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_customer_flow_overrides_updated_at
  BEFORE UPDATE ON customer_flow_overrides
  FOR EACH ROW EXECUTE FUNCTION update_customer_flow_overrides_updated_at();
