-- Tabla maestra del agente PSAV.
-- Cada fila es una persona/entidad que opera canales de cobro para Guira.
CREATE TABLE IF NOT EXISTS psavs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  verification_code TEXT        NOT NULL,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE psavs ENABLE ROW LEVEL SECURITY;

-- Staff (y superiores) puede leer todos los PSAVs
CREATE POLICY "staff reads psavs"
  ON psavs FOR SELECT
  TO authenticated
  USING (is_staff_or_admin());

-- Solo admin/super_admin puede crear, editar o eliminar
CREATE POLICY "admin manages psavs"
  ON psavs FOR ALL
  TO authenticated
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid())
    IN ('admin', 'super_admin')
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid())
    IN ('admin', 'super_admin')
  );

COMMENT ON TABLE psavs IS 'Agentes PSAV que operan canales de cobro. Cada agente puede tener múltiples psav_accounts.';
COMMENT ON COLUMN psavs.verification_code IS 'Código interno de autenticación del agente — no se muestra a clientes finales.';
