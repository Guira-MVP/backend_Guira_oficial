-- Enlaza cada canal (psav_accounts) al agente PSAV que lo opera.
-- Migra los registros existentes asignándolos al primer PSAV creado (Hector).

ALTER TABLE psav_accounts
  ADD COLUMN IF NOT EXISTS psav_id UUID REFERENCES psavs(id);

-- Crear el PSAV inicial para Hector Emmanuel Sempertegui Peñaloza.
-- El admin debe actualizar el verification_code real desde el panel.
DO $$
DECLARE
  v_psav_id UUID;
BEGIN
  INSERT INTO psavs (name, verification_code)
  VALUES ('Hector Emmanuel Sempertegui Peñaloza', 'PSAV-HE-001')
  RETURNING id INTO v_psav_id;

  -- Asociar todos los canales existentes a este PSAV
  UPDATE psav_accounts SET psav_id = v_psav_id WHERE psav_id IS NULL;
END $$;

-- Ahora que todos los registros existentes tienen psav_id, hacerlo obligatorio
ALTER TABLE psav_accounts
  ALTER COLUMN psav_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS psav_accounts_psav_id_idx
  ON psav_accounts(psav_id);

COMMENT ON COLUMN psav_accounts.psav_id IS 'FK al agente PSAV dueño de este canal de cobro.';
