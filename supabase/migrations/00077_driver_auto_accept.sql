-- Add auto-accept preference to driver profiles
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS auto_accept_enabled BOOLEAN NOT NULL DEFAULT false;

-- Only allow auto-accept for experienced drivers
-- (enforcement in app, not DB constraint — drivers can toggle but system checks eligibility)
