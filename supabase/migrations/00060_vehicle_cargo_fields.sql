-- ============================================================
-- Migration: Add cargo capability fields to vehicles
-- ============================================================

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS accepts_cargo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS max_cargo_weight_kg INTEGER;
