-- ============================================================================
-- KYB Audit Fix — Ownership Structure Attestation
-- Date: 2026-07-29
-- Description: Bridge requires attested_ownership_structure_at on at least one
-- associated_person with has_control=true (the control person / legal
-- representative), OR a signed ownership document, to satisfy the
-- control_person_ownership_attestation requirement. Guira's KYB flow only
-- supports the attestation path — this column was missing entirely, so the
-- field was never sent to Bridge, risking an RFI/rejection.
-- ============================================================================

ALTER TABLE business_directors
  ADD COLUMN IF NOT EXISTS attested_ownership_structure_at TIMESTAMPTZ;

COMMENT ON COLUMN business_directors.attested_ownership_structure_at IS
  'Bridge AssociatedPerson.attested_ownership_structure_at — timestamp when this control person certified the UBO ownership structure. Satisfies Bridge''s control_person_ownership_attestation requirement without a separate ownership document.';
