-- ============================================================
-- Migration 00259: driver_recurring_shifts (Phase 1 D5)
--
-- Driver-side equivalent to `recurring_rides` (00047). Lets a driver
-- pre-define their typical work shifts (e.g. "Mon–Fri 7am–3pm in Vedado")
-- so the system can:
--   - notify them ~15 min before a scheduled shift starts (handled by
--     a future scheduler/cron, NOT in this migration)
--   - surface "your usual shift starts in 12 min" prompts on the home
--     bottom sheet
--   - feed analytics on shift adherence (planned vs actual online time)
--
-- The frontend (apps/driver/app/profile/recurring-shifts/*) ships in
-- the same PR. Until this migration is applied to prod (MCP guard),
-- the frontend tolerates the absent table by surfacing an empty
-- state — same pattern as 00258 / N2.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE for the
-- helper RPC, and CREATE POLICY guards via DROP/CREATE.
-- ============================================================

-- ── Table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS driver_recurring_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES driver_profiles(id) ON DELETE CASCADE,
  -- Optional friendly name like "Mañana Vedado" or "Turno noche"
  label TEXT,
  -- ISO days: 1=Mon..7=Sun (matches recurring_rides + Postgres ISODOW)
  days_of_week SMALLINT[] NOT NULL CHECK (array_length(days_of_week, 1) BETWEEN 1 AND 7),
  -- Times stored as TIME WITHOUT TIME ZONE; interpreted in `timezone`
  start_time TIME NOT NULL,
  end_time TIME NOT NULL CHECK (end_time != start_time),
  -- Optional preferred operating zone — if set, the driver gets
  -- routing hints toward this zone when the shift fires.
  preferred_zone_id UUID REFERENCES zones(id) ON DELETE SET NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Havana',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'deleted')),
  -- Maintained the same way as recurring_rides — recomputed by the
  -- service layer using compute_next_occurrence() (defined in 00047).
  next_occurrence_at TIMESTAMPTZ,
  last_notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_driver_recurring_shifts_driver
  ON driver_recurring_shifts(driver_id) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_driver_recurring_shifts_next
  ON driver_recurring_shifts(next_occurrence_at) WHERE status = 'active';

-- updated_at trigger (reuses the function declared in 00001 / shared)
DROP TRIGGER IF EXISTS set_driver_recurring_shifts_updated_at ON driver_recurring_shifts;
CREATE TRIGGER set_driver_recurring_shifts_updated_at
  BEFORE UPDATE ON driver_recurring_shifts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ──────────────────────────────────────────────────────

ALTER TABLE driver_recurring_shifts ENABLE ROW LEVEL SECURITY;

-- Owner is the user behind the driver_profile. We resolve via JOIN.
DROP POLICY IF EXISTS driver_recurring_shifts_owner_select ON driver_recurring_shifts;
CREATE POLICY driver_recurring_shifts_owner_select ON driver_recurring_shifts
  FOR SELECT USING (
    driver_id IN (
      SELECT id FROM driver_profiles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS driver_recurring_shifts_owner_insert ON driver_recurring_shifts;
CREATE POLICY driver_recurring_shifts_owner_insert ON driver_recurring_shifts
  FOR INSERT WITH CHECK (
    driver_id IN (
      SELECT id FROM driver_profiles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS driver_recurring_shifts_owner_update ON driver_recurring_shifts;
CREATE POLICY driver_recurring_shifts_owner_update ON driver_recurring_shifts
  FOR UPDATE USING (
    driver_id IN (
      SELECT id FROM driver_profiles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS driver_recurring_shifts_owner_delete ON driver_recurring_shifts;
CREATE POLICY driver_recurring_shifts_owner_delete ON driver_recurring_shifts
  FOR DELETE USING (
    driver_id IN (
      SELECT id FROM driver_profiles WHERE user_id = auth.uid()
    )
  );

-- ── COMMENT ──────────────────────────────────────────────────

COMMENT ON TABLE driver_recurring_shifts IS
  'Driver-side recurring shifts (Phase 1 D5). Mirrors recurring_rides for '
  'the rider, but drivers schedule their *availability windows* — start_time '
  'and end_time delimit the shift. Notification scheduler (cron, future) reads '
  'next_occurrence_at and pushes a reminder ~15 min before the shift starts.';
