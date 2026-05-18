-- ============================================================================
-- KYB Audit Fixes — Database Migration
-- Date: 2026-05-01
-- Description: Adds missing columns identified in KYB compliance audit
-- ============================================================================

-- P2-A: Add position column to business_ubos for Bridge `title` field
-- Bridge requires `title` when has_control=true for associated_persons.
ALTER TABLE business_ubos ADD COLUMN IF NOT EXISTS position TEXT;
COMMENT ON COLUMN business_ubos.position IS 'P2-A: Bridge title field - required when has_control=true';

-- P3-A: Add is_dao column to businesses  
-- Bridge accepts is_dao boolean for DAO (Decentralized Autonomous Organization) businesses.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_dao BOOLEAN DEFAULT false;
COMMENT ON COLUMN businesses.is_dao IS 'P3-A: Bridge is_dao boolean for DAO businesses';

-- Missing column: conducts_money_services_description
-- Bridge requires this when conducts_money_services=true.
-- The DTO and payload builder already reference this field, but the DB column was missing.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS conducts_money_services_description TEXT;
COMMENT ON COLUMN businesses.conducts_money_services_description IS 'Bridge: description of money services, required when conducts_money_services=true';

-- ============================================================================
-- Verification queries (run after migration to confirm)
-- ============================================================================
-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'business_ubos' AND column_name = 'position';

-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'businesses' AND column_name IN ('is_dao', 'conducts_money_services_description');
