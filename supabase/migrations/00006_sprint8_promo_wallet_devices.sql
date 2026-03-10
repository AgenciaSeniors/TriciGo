-- ============================================================
-- Sprint 8 — Promo on rides, push tokens, promotion usage,
-- wallet account auto-creation, promo increment
-- ============================================================

-- 1. Promo columns on rides
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS promo_code_id UUID REFERENCES promotions(id),
  ADD COLUMN IF NOT EXISTS discount_amount_cup INTEGER NOT NULL DEFAULT 0;

-- 2. Push token storage
CREATE TABLE IF NOT EXISTS user_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  push_token TEXT,
  platform TEXT NOT NULL DEFAULT 'android',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, push_token)
);

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ud_own" ON user_devices FOR ALL USING (user_id = auth.uid());
CREATE POLICY "ud_admin" ON user_devices FOR ALL USING (is_admin());

-- 3. Promo usage tracking (1 use per user per promo)
CREATE TABLE IF NOT EXISTS promotion_uses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES promotions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  ride_id UUID REFERENCES rides(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(promotion_id, user_id)
);

ALTER TABLE promotion_uses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pu_own" ON promotion_uses FOR SELECT USING (user_id = auth.uid() OR is_admin());
CREATE POLICY "pu_insert" ON promotion_uses FOR INSERT WITH CHECK (user_id = auth.uid());

-- 4. Ensure wallet account function (idempotent)
CREATE OR REPLACE FUNCTION ensure_wallet_account(
  p_user_id UUID,
  p_type wallet_account_type DEFAULT 'customer_cash'
)
RETURNS UUID AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM wallet_accounts
    WHERE user_id = p_user_id AND account_type = p_type;
  IF v_id IS NULL THEN
    INSERT INTO wallet_accounts (id, user_id, account_type, balance, held_balance, currency)
    VALUES (gen_random_uuid(), p_user_id, p_type, 0, 0, 'TRC')
    ON CONFLICT (user_id, account_type) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM wallet_accounts
        WHERE user_id = p_user_id AND account_type = p_type;
    END IF;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Increment promo uses atomically
CREATE OR REPLACE FUNCTION increment_promo_uses(p_promo_id UUID)
RETURNS VOID AS $$
  UPDATE promotions SET current_uses = current_uses + 1 WHERE id = p_promo_id;
$$ LANGUAGE sql SECURITY DEFINER;

-- 6. Wallet insert policy for client-side ensureAccount calls
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'wallet_accounts' AND policyname = 'wa_insert_own'
  ) THEN
    CREATE POLICY "wa_insert_own" ON wallet_accounts FOR INSERT
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
