-- ============================================================
-- Sprint 10 — Wallet Recharge Requests
-- Allows customers to request wallet top-ups (admin-approved)
-- ============================================================

CREATE TABLE IF NOT EXISTS wallet_recharge_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  processed_by UUID REFERENCES users(id),
  processed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wallet_recharge_requests ENABLE ROW LEVEL SECURITY;

-- Users can read/insert their own requests
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'wallet_recharge_requests' AND policyname = 'wrr_own_select') THEN
    CREATE POLICY "wrr_own_select" ON wallet_recharge_requests FOR SELECT USING (user_id = auth.uid() OR is_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'wallet_recharge_requests' AND policyname = 'wrr_own_insert') THEN
    CREATE POLICY "wrr_own_insert" ON wallet_recharge_requests FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'wallet_recharge_requests' AND policyname = 'wrr_admin') THEN
    CREATE POLICY "wrr_admin" ON wallet_recharge_requests FOR ALL USING (is_admin());
  END IF;
END $$;
