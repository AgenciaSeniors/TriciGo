-- ============================================================
-- TriciGo — Migration 00005: ride_messages (in-ride chat)
-- ============================================================

CREATE TABLE ride_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ride_messages_ride ON ride_messages(ride_id, created_at ASC);

-- RLS
ALTER TABLE ride_messages ENABLE ROW LEVEL SECURITY;

-- SELECT: ride participants + admins
CREATE POLICY "rm_select" ON ride_messages FOR SELECT USING (
  ride_id IN (SELECT id FROM rides WHERE customer_id = auth.uid())
  OR ride_id IN (
    SELECT r.id FROM rides r
    JOIN driver_profiles dp ON r.driver_id = dp.id
    WHERE dp.user_id = auth.uid()
  )
  OR is_admin()
);

-- INSERT: sender must be auth user AND a ride participant
CREATE POLICY "rm_insert" ON ride_messages FOR INSERT WITH CHECK (
  sender_id = auth.uid()
  AND (
    ride_id IN (SELECT id FROM rides WHERE customer_id = auth.uid())
    OR ride_id IN (
      SELECT r.id FROM rides r
      JOIN driver_profiles dp ON r.driver_id = dp.id
      WHERE dp.user_id = auth.uid()
    )
  )
);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE ride_messages;
