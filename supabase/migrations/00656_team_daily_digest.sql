-- 00656: team daily digest (docs/superpowers/specs/2026-10-11-team-daily-digest-design.md).
--
-- At 7:00 Havana time every panel account (super_admin, admin, marketing) gets an e-mail with the
-- previous day's numbers. The send-team-digest Edge Function renders and sends it; this file holds
-- the database side:
--   1. team_digest_runs (one row per day: the day is sent once) and team_digest_optouts, both lock
--      tables for the service role only; the settings team_digest_enabled (off at launch) and
--      team_digest_preview_to (one account id: only that account gets it).
--   2. _team_digest_totals(day) and team_daily_metrics(day): every number of the e-mail.
--   3. team_digest_recipients(), claim_team_digest(day), finish_team_digest(...),
--      set_team_digest_optout(user, out).
--   4. dispatch_team_digest() (cron, hourly at :05) and check_team_digest_overdue() (cron, */15).
-- Functions the cron calls let their errors through (CLAUDE.md, "Una función de cron no atrapa sus
-- propios errores"). Rehearsal: supabase/tests/00656/run.sh.

SET lock_timeout = '10s';

-- 1. Run log, opt-outs and settings ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_digest_runs (
  day         date PRIMARY KEY,
  status      text NOT NULL DEFAULT 'sending',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  recipients  integer NOT NULL DEFAULT 0,
  sent        integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  last_error  text,
  CONSTRAINT team_digest_runs_status_check CHECK (status IN ('sending', 'sent', 'failed'))
);
-- One row per person who chose; opted_out = false is a person who came back. Kept as a flag so
-- coming back is an UPDATE, never a DELETE.
CREATE TABLE IF NOT EXISTS public.team_digest_optouts (
  user_id    uuid PRIMARY KEY REFERENCES public.users (id) ON DELETE CASCADE,
  opted_out  boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Lock tables: only the SECURITY DEFINER functions below and the service role touch them.
ALTER TABLE public.team_digest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_digest_optouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_digest_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.team_digest_optouts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_digest_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_digest_optouts TO service_role;

INSERT INTO public.platform_config (key, value) VALUES
  ('team_digest_enabled', '"false"'::jsonb),
  ('team_digest_preview_to', '""'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 3. Recipients, run log and opt-outs ------------------------------------------------------
-- Every active panel account with a provable address (00635: mailable_user_emails), minus the
-- platform account and whoever opted out. With team_digest_preview_to set, only that account; a
-- value that is no account's id sends to nobody.
CREATE OR REPLACE FUNCTION public.team_digest_recipients()
RETURNS TABLE (user_id uuid, role text, email text, full_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  c_platform CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_preview text := btrim(coalesce(public.get_platform_config_text('team_digest_preview_to', ''), ''));
BEGIN
  RETURN QUERY
  WITH staff AS (
    SELECT u.id, u.role::text AS role, coalesce(btrim(u.full_name), '') AS full_name
    FROM public.users u
    WHERE u.role IN ('super_admin', 'admin', 'marketing')
      AND coalesce(u.is_active, true)
      AND u.id <> c_platform
      AND NOT EXISTS (SELECT 1 FROM public.team_digest_optouts o WHERE o.user_id = u.id AND o.opted_out)
      AND (v_preview = '' OR u.id::text = v_preview)
  )
  SELECT s.id, s.role, m.email, s.full_name
  FROM staff s
  JOIN public.mailable_user_emails(ARRAY(SELECT s2.id FROM staff s2)) m ON m.user_id = s.id
  ORDER BY s.role, s.id;
END;
$$;

-- One winner per day. A send stuck in 'sending' for 30 minutes died; it becomes 'failed' and is
-- never claimed again: a retry could send it twice.
CREATE OR REPLACE FUNCTION public.claim_team_digest(p_day date)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'claim_team_digest: p_day is required' USING DETAIL = 'team_digest_bad_day';
  END IF;
  UPDATE public.team_digest_runs
     SET status = 'failed', finished_at = now(), last_error = coalesce(last_error, 'interrupted')
   WHERE status = 'sending' AND started_at < now() - interval '30 minutes';
  INSERT INTO public.team_digest_runs (day) VALUES (p_day) ON CONFLICT (day) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

-- The outcome, only while the day is still 'sending'. Nothing sent to anyone (with recipients or
-- with an error) is 'failed'; anything else is 'sent', with its failures counted.
CREATE OR REPLACE FUNCTION public.finish_team_digest(p_day date, p_recipients integer, p_sent integer, p_failed integer, p_error text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.team_digest_runs
     SET status = CASE WHEN coalesce(p_sent, 0) = 0 AND (coalesce(p_recipients, 0) > 0 OR p_error IS NOT NULL)
                       THEN 'failed' ELSE 'sent' END,
         finished_at = now(),
         recipients = coalesce(p_recipients, 0),
         sent = coalesce(p_sent, 0),
         failed = coalesce(p_failed, 0),
         last_error = left(p_error, 500)
   WHERE day = p_day AND status = 'sending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

-- p_out = true stops the digest for that account, false brings it back. false for an unknown id.
CREATE OR REPLACE FUNCTION public.set_team_digest_optout(p_user uuid, p_out boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user) THEN
    RETURN false;
  END IF;
  INSERT INTO public.team_digest_optouts (user_id, opted_out) VALUES (p_user, coalesce(p_out, true))
  ON CONFLICT (user_id) DO UPDATE SET opted_out = EXCLUDED.opted_out, updated_at = now();
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.team_digest_recipients() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_digest_recipients() TO service_role;
REVOKE ALL ON FUNCTION public.claim_team_digest(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_team_digest(date) TO service_role;
REVOKE ALL ON FUNCTION public.finish_team_digest(date, integer, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_team_digest(date, integer, integer, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.set_team_digest_optout(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_team_digest_optout(uuid, boolean) TO service_role;

RESET lock_timeout;
