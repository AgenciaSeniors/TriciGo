-- ============================================================
-- Migration 00047: Recurring Rides
-- Auto-create scheduled rides on a weekly pattern
-- ============================================================

-- ── Table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recurring_rides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pickup_location geography(POINT, 4326) NOT NULL,
  pickup_address TEXT NOT NULL,
  dropoff_location geography(POINT, 4326) NOT NULL,
  dropoff_address TEXT NOT NULL,
  service_type TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'tricicoin',
  days_of_week SMALLINT[] NOT NULL CHECK (array_length(days_of_week, 1) BETWEEN 1 AND 7),
  time_of_day TIME NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Havana',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'deleted')),
  next_occurrence_at TIMESTAMPTZ,
  last_ride_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_recurring_rides_user
  ON recurring_rides(user_id) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_recurring_rides_next
  ON recurring_rides(next_occurrence_at) WHERE status = 'active';

-- Updated_at trigger (reuse existing function)
CREATE TRIGGER set_recurring_rides_updated_at
  BEFORE UPDATE ON recurring_rides
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ──────────────────────────────────────────────────────

ALTER TABLE recurring_rides ENABLE ROW LEVEL SECURITY;

CREATE POLICY recurring_rides_owner_select ON recurring_rides
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY recurring_rides_owner_insert ON recurring_rides
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY recurring_rides_owner_update ON recurring_rides
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY recurring_rides_owner_delete ON recurring_rides
  FOR DELETE USING (auth.uid() = user_id);

-- ── compute_next_occurrence ──────────────────────────────────
-- Given days-of-week array, time, and timezone, find the next
-- valid occurrence after p_from. Returns NULL if impossible.

CREATE OR REPLACE FUNCTION compute_next_occurrence(
  p_days   SMALLINT[],
  p_time   TIME,
  p_tz     TEXT DEFAULT 'America/Havana',
  p_from   TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_local_now  TIMESTAMP;
  v_candidate  DATE;
  v_dow        INT;
  v_result     TIMESTAMPTZ;
  i            INT;
BEGIN
  -- Convert reference time to target timezone
  v_local_now := p_from AT TIME ZONE p_tz;

  FOR i IN 0..7 LOOP
    v_candidate := (v_local_now::DATE) + i;
    v_dow := EXTRACT(ISODOW FROM v_candidate)::INT;  -- 1=Mon..7=Sun

    IF v_dow = ANY(p_days) THEN
      -- For today, skip if time already passed (with 30min buffer)
      IF i = 0 AND v_local_now::TIME > (p_time - interval '30 minutes') THEN
        CONTINUE;
      END IF;

      -- Build timestamp in target timezone, then convert to UTC
      v_result := (v_candidate || ' ' || p_time)::TIMESTAMP AT TIME ZONE p_tz;
      RETURN v_result;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

-- ── create_rides_for_recurring ───────────────────────────────
-- Called by pg_cron every 15 minutes. Creates scheduled rides
-- for recurring patterns whose next occurrence is within 24h.

CREATE OR REPLACE FUNCTION create_rides_for_recurring()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_rec   RECORD;
  v_count INT := 0;
  v_next  TIMESTAMPTZ;
BEGIN
  FOR v_rec IN
    SELECT *
    FROM recurring_rides
    WHERE status = 'active'
      AND next_occurrence_at IS NOT NULL
      AND next_occurrence_at <= NOW() + interval '24 hours'
      -- Prevent duplicates: don't create if last created ride is recent enough
      AND (
        last_ride_created_at IS NULL
        OR last_ride_created_at < next_occurrence_at - interval '25 hours'
      )
  LOOP
    -- Insert a scheduled ride
    INSERT INTO rides (
      customer_id, service_type, payment_method,
      pickup_location, pickup_address,
      dropoff_location, dropoff_address,
      estimated_fare_cup, estimated_fare_trc,
      estimated_distance_m, estimated_duration_s,
      exchange_rate_usd_cup,
      is_scheduled, scheduled_at, status,
      discount_amount_cup, surge_multiplier, tip_amount
    ) VALUES (
      v_rec.user_id, v_rec.service_type, v_rec.payment_method,
      v_rec.pickup_location, v_rec.pickup_address,
      v_rec.dropoff_location, v_rec.dropoff_address,
      0, 0,
      0, 0,
      NULL,
      true, v_rec.next_occurrence_at, 'searching',
      0, 1, 0
    );

    -- Advance to the next occurrence
    v_next := compute_next_occurrence(
      v_rec.days_of_week,
      v_rec.time_of_day,
      v_rec.timezone,
      v_rec.next_occurrence_at + interval '1 hour'
    );

    UPDATE recurring_rides SET
      last_ride_created_at = NOW(),
      next_occurrence_at = v_next
    WHERE id = v_rec.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ── pg_cron job ──────────────────────────────────────────────

SELECT cron.schedule(
  'create-recurring-rides',
  '*/15 * * * *',
  $$ SELECT create_rides_for_recurring(); $$
);

-- ── Feature flag ─────────────────────────────────────────────

INSERT INTO feature_flags (key, enabled, description)
VALUES ('recurring_rides_enabled', false, 'Allow riders to create recurring ride schedules')
ON CONFLICT (key) DO NOTHING;
