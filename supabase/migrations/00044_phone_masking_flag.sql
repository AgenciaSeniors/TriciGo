-- ============================================================
-- Migration 00044: Phone Masking Feature Flag
-- ============================================================

INSERT INTO feature_flags (key, enabled, description)
VALUES ('phone_masking_enabled', false, 'Mask phone numbers in ride display (show only last 4 digits)')
ON CONFLICT (key) DO NOTHING;
