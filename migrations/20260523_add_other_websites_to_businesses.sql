-- ============================================================================
-- Migration: add other_websites column to businesses
-- Date: 2026-05-23
-- Description: Adds other_websites (text[]) column to businesses table.
--   Bridge API accepts other_websites[] for secondary web presence / social media.
--   Required: not set (nullable). Only sent to Bridge when non-empty.
-- ============================================================================

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS other_websites TEXT[];
COMMENT ON COLUMN businesses.other_websites IS 'Bridge other_websites: array of secondary websites and social media handles';
