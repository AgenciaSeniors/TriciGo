-- Fix: apply arrived_at_destination enum + transitions with admin/super_admin roles
-- Migration 00096 was never applied to production, and 00098 missed these transitions.

-- 1. Add enum value (idempotent)
ALTER TYPE ride_status ADD VALUE IF NOT EXISTS 'arrived_at_destination' AFTER 'in_progress';

-- 2. Valid transitions with admin/super_admin roles included
INSERT INTO valid_transitions (from_status, to_status, allowed_roles) VALUES
  ('in_progress', 'arrived_at_destination', ARRAY['driver', 'admin', 'super_admin']::user_role[]),
  ('arrived_at_destination', 'completed', ARRAY['driver', 'admin', 'super_admin']::user_role[]),
  ('arrived_at_destination', 'disputed', ARRAY['customer', 'driver', 'admin', 'super_admin']::user_role[])
ON CONFLICT (from_status, to_status) DO UPDATE SET allowed_roles = EXCLUDED.allowed_roles;

-- 3. Timestamp column
ALTER TABLE rides ADD COLUMN IF NOT EXISTS arrived_at_destination_at TIMESTAMPTZ;
