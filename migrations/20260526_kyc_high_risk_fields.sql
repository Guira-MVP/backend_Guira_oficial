-- ============================================================================
-- KYC High-Risk Fields — Database Migration
-- Date: 2026-05-26
-- Description: Adds missing columns in the `people` table required by Bridge
--              for high-risk / restricted country customers (e.g. Bolivia).
-- ============================================================================

-- acting_as_intermediary: Bridge requires this boolean for high-risk customers.
-- Indicates whether the customer acts as an intermediary for a third party.
ALTER TABLE people ADD COLUMN IF NOT EXISTS acting_as_intermediary BOOLEAN;
COMMENT ON COLUMN people.acting_as_intermediary IS 'Bridge required field for high-risk customers: true if customer acts as intermediary for a third party';

-- most_recent_occupation: alphanumeric O*NET-SOC code.
-- Required by Bridge for restricted/high-risk countries.
-- Column likely already exists but added with IF NOT EXISTS for safety.
ALTER TABLE people ADD COLUMN IF NOT EXISTS most_recent_occupation TEXT;
COMMENT ON COLUMN people.most_recent_occupation IS 'Bridge occupation code (O*NET-SOC) — required for high-risk/restricted countries';

-- expected_monthly_payments_usd: Bridge enum string for individuals.
-- Required by Bridge for high-risk customers.
ALTER TABLE people ADD COLUMN IF NOT EXISTS expected_monthly_payments_usd TEXT;
COMMENT ON COLUMN people.expected_monthly_payments_usd IS 'Bridge enum: 0_4999 | 5000_9999 | 10000_49999 | 50000_plus — required for high-risk';
