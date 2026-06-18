-- Columna que indica qué agente PSAV atiende a este cliente.
-- NULL = sin asignar (clientes existentes; el admin los asigna manualmente).
-- Nuevos clientes reciben asignación automática equitativa al aprobar KYC/KYB.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS assigned_psav_id UUID REFERENCES psavs(id);

CREATE INDEX IF NOT EXISTS profiles_assigned_psav_id_idx
  ON profiles(assigned_psav_id);

COMMENT ON COLUMN profiles.assigned_psav_id IS 'PSAV asignado al cliente. Se establece equitativamente al aprobar KYC/KYB. El admin puede reasignarlo.';
