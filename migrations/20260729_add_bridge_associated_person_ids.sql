-- Persist the Bridge associated-person IDs used to synchronize KYB corrections.
-- These values are provider identifiers, not user-controlled input.

ALTER TABLE business_directors
  ADD COLUMN IF NOT EXISTS bridge_associated_person_id TEXT;

ALTER TABLE business_ubos
  ADD COLUMN IF NOT EXISTS bridge_associated_person_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS business_directors_bridge_associated_person_id_key
  ON business_directors (bridge_associated_person_id)
  WHERE bridge_associated_person_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS business_ubos_bridge_associated_person_id_key
  ON business_ubos (bridge_associated_person_id)
  WHERE bridge_associated_person_id IS NOT NULL;

COMMENT ON COLUMN business_directors.bridge_associated_person_id IS
  'Bridge associated-person ID for the director; used for KYB correction synchronization.';

COMMENT ON COLUMN business_ubos.bridge_associated_person_id IS
  'Bridge associated-person ID for the UBO; used for KYB correction synchronization.';
