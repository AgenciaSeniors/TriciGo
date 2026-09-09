-- 00585 — Record WHY a device has no push token
--
-- PROBLEM. `user_devices` can only ever record a SUCCESS. On the server, a user
-- who refused the OS notification permission, one who was never asked, and one
-- whose token minting threw are the same thing: a missing row. Both apps
-- already computed the reason — `registerPushTokenForUser` returns
-- 'registered' | 'denied' | 'error' — and every one of its three call sites
-- discarded that value inside a `catch {}`. So the reason existed for a moment
-- on the device and was never written down anywhere.
--
-- MEASURED 2026-09-08 (prod):
--   * 24 of the 91 drivers who went online in the last 30 days have a push
--     token. 67 do not.
--   * Passengers are identical (17 of 60), so this is not a driver-app bug —
--     it is the shared registration/permission path.
--   * A live send: `targets=51 total_tokens=11` on a reactivation push.
--   * 52 of the 81 ride offers that expired went to drivers with no token:
--     they did not ignore the offer, they never heard about it.
--   * Ruled out with evidence, not opinion: tokens are NOT being deleted
--     (`failed=0` on every recent send, zero "Cleaned dead token" lines);
--     `ride_offer` is exempt from `notification_preferences`; the UNIQUE
--     constraint and the RLS policies on `user_devices` are correct.
--
-- WHAT THIS ADDS. One row per (user, app) saying how the last registration
-- attempt ended. The distinction that decides what to build next:
--
--   never_asked  we never put the question to them        -> our bug
--   blocked      refused, and the OS will not ask again   -> needs Settings
--   denied       refused, a prompt could still work       -> needs a better ask
--   error        permission was fine, plumbing failed     -> a real bug
--   registered   token minted and stored
--
-- The apps write this fire-and-forget and swallow every failure, so an app
-- build may ship before this migration is applied with no user-visible effect.

CREATE TABLE IF NOT EXISTS public.push_registration_status (
  user_id    uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  app        text        NOT NULL,
  outcome    text        NOT NULL,
  platform   text,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app)
);

-- Idempotent CHECKs (ADD CONSTRAINT has no IF NOT EXISTS).
DO $checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_registration_status_app_chk') THEN
    ALTER TABLE public.push_registration_status
      ADD CONSTRAINT push_registration_status_app_chk CHECK (app IN ('client', 'driver'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_registration_status_outcome_chk') THEN
    ALTER TABLE public.push_registration_status
      ADD CONSTRAINT push_registration_status_outcome_chk
      CHECK (outcome IN ('registered', 'never_asked', 'denied', 'blocked', 'error'));
  END IF;

  -- `detail` carries an error message, never a payload. The apps already cap
  -- it; this stops a stack trace from bloating the row if one ever does not.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_registration_status_detail_len') THEN
    ALTER TABLE public.push_registration_status
      ADD CONSTRAINT push_registration_status_detail_len CHECK (detail IS NULL OR length(detail) <= 300);
  END IF;
END $checks$;

COMMENT ON TABLE public.push_registration_status IS
  '00585: why each device does or does not hold a push token. user_devices records only successes; this records the reason for the silence.';
COMMENT ON COLUMN public.push_registration_status.outcome IS
  'registered | never_asked (we never asked) | denied (refused, askable) | blocked (refused, Settings only) | error (permission fine, plumbing failed)';

-- RLS: same shape as user_devices (ud_own / ud_admin). A FOR ALL policy with
-- no WITH CHECK reuses USING for INSERT/UPDATE, which is what we want: a user
-- may only ever write their own row.
ALTER TABLE public.push_registration_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prs_own ON public.push_registration_status;
CREATE POLICY prs_own ON public.push_registration_status
  FOR ALL USING (user_id = auth.uid());

DROP POLICY IF EXISTS prs_admin ON public.push_registration_status;
CREATE POLICY prs_admin ON public.push_registration_status
  FOR ALL USING (is_admin());

-- Deliberately NOT mirroring user_devices' inherited `GRANT ALL TO anon`:
-- nothing anonymous registers a push token.
REVOKE ALL ON public.push_registration_status FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.push_registration_status TO authenticated;
GRANT ALL ON public.push_registration_status TO service_role;

-- Who can actually be reached with a ride offer right now. Useful the moment
-- this migration is applied — it needs no app change, because the token count
-- alone already names the unreachable drivers. `outcome` fills in later, as
-- rebuilt apps report in.
CREATE OR REPLACE VIEW public.driver_push_reachability
WITH (security_invoker = true) AS
SELECT
  dp.id                AS driver_profile_id,
  dp.user_id,
  u.full_name,
  u.phone,
  dp.status,
  dp.is_online,
  (SELECT count(*) FROM public.user_devices ud WHERE ud.user_id = dp.user_id) AS push_tokens,
  prs.outcome          AS last_registration_outcome,
  prs.platform         AS last_registration_platform,
  prs.detail           AS last_registration_detail,
  prs.updated_at       AS last_registration_at
FROM public.driver_profiles dp
JOIN public.users u ON u.id = dp.user_id
LEFT JOIN public.push_registration_status prs
       ON prs.user_id = dp.user_id AND prs.app = 'driver'
WHERE dp.status = 'approved';

COMMENT ON VIEW public.driver_push_reachability IS
  '00585: approved drivers with their push token count and last registration outcome. security_invoker, so the caller''s RLS on users/driver_profiles decides what is visible.';

REVOKE ALL ON public.driver_push_reachability FROM anon;
GRANT SELECT ON public.driver_push_reachability TO authenticated;
