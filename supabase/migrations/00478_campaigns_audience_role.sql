-- 00478: campaigns.audience_role — let admin campaigns target DRIVERS.
--
-- Problem (P1-3, marketing audit 2026-07-02): every segment in the admin
-- campaigns page hardcoded role='customer' — there was no way to send a
-- push/email campaign to drivers (only the ad-hoc push in /notifications,
-- with no email, no promo attach, no campaign history).
--
-- The column records which audience a campaign targeted. Existing rows are
-- customer campaigns, hence the default.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS audience_role TEXT NOT NULL DEFAULT 'customer';

-- Idempotent CHECK (ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaigns_audience_role_chk' AND conrelid = 'campaigns'::regclass
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_audience_role_chk
      CHECK (audience_role IN ('customer', 'driver'));
  END IF;
END $$;

COMMENT ON COLUMN campaigns.audience_role IS
  '00478: which audience the campaign targeted (customer | driver).';
