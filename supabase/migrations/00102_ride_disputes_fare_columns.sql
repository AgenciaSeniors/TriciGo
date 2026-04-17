-- ============================================================
-- Migration 00102: Add fare snapshot columns to ride_disputes
-- BUG-044: TS types expect ride_final_fare_trc and
-- ride_estimated_fare_trc but DB lacks these columns.
-- ============================================================

ALTER TABLE ride_disputes
  ADD COLUMN IF NOT EXISTS ride_estimated_fare_trc INTEGER,
  ADD COLUMN IF NOT EXISTS ride_final_fare_trc INTEGER;

-- CHECK constraints to prevent negative fares
ALTER TABLE ride_disputes
  ADD CONSTRAINT chk_estimated_fare_non_negative
    CHECK (ride_estimated_fare_trc IS NULL OR ride_estimated_fare_trc >= 0);

ALTER TABLE ride_disputes
  ADD CONSTRAINT chk_final_fare_non_negative
    CHECK (ride_final_fare_trc IS NULL OR ride_final_fare_trc >= 0);
