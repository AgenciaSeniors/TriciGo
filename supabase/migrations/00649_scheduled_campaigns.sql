-- ============================================================
-- 00649: scheduled campaigns that actually send
-- Spec: docs/superpowers/specs/2026-10-09-scheduled-campaigns-design.md
--
-- Until now the admin page stored "Programar para" campaigns as status 'scheduled' and nothing
-- ever sent them. "Enviar ahora" ran in the browser. From here on the panel only inserts the
-- campaign; the Edge Function send-campaign sends it, either at once (the panel calls it) or when
-- the cron job send-due-campaigns finds it due.
--
-- Lifecycle: scheduled -> sending -> sent | failed; scheduled -> cancelled.
-- ============================================================
SET lock_timeout = '10s';

-- 1. Columns and status CHECK -------------------------------------------------------------
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS recipient_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS push_sent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_sent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz,
  ADD COLUMN IF NOT EXISTS canceled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.campaigns'::regclass AND conname = 'campaigns_status_chk') THEN
    ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_status_chk
      CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'));
  END IF;
END $chk$;

CREATE INDEX IF NOT EXISTS idx_campaigns_due ON public.campaigns (scheduled_at) WHERE status = 'scheduled';

-- 2. Client writes ------------------------------------------------------------------------
-- Status and counters change only through the functions below. The admin ALL policy keeps
-- SELECT, INSERT and DELETE; marketing keeps its SELECT and INSERT policies (00642).
REVOKE UPDATE, TRUNCATE ON public.campaigns FROM anon, authenticated;
REVOKE INSERT ON public.campaigns FROM anon;

CREATE OR REPLACE FUNCTION public.tg_campaigns_client_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Only direct client writes (PostgREST). The service role, cron and SQL keep what they send.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  NEW.created_by := auth.uid();
  -- Legacy: the panel before 00649 sent from the browser and then stored the campaign as 'sent'.
  -- A tab opened before the deploy still does. Turning that row into 'scheduled' would send it
  -- a second time, so it is kept as it comes.
  IF NEW.status = 'sent' THEN
    RETURN NEW;
  END IF;
  NEW.status := 'scheduled';
  NEW.scheduled_at := GREATEST(COALESCE(NEW.scheduled_at, now()), now());
  NEW.sent_at := NULL;
  NEW.started_at := NULL;
  NEW.sent_count := 0;
  NEW.recipient_count := 0;
  NEW.push_sent := 0;
  NEW.email_sent := 0;
  NEW.last_error := NULL;
  NEW.canceled_at := NULL;
  NEW.canceled_by := NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_campaigns_client_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_campaigns_client_insert ON public.campaigns;
CREATE TRIGGER trg_campaigns_client_insert
  BEFORE INSERT ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.tg_campaigns_client_insert();

-- 3. Recipients ----------------------------------------------------------------------------
-- An array, not a set: PostgREST caps a set at 1000 rows, an array is one value.
-- Same segments the panel computed in the browser until 00649, evaluated at send time,
-- never including blocked accounts (users.is_active = false).
CREATE OR REPLACE FUNCTION public.campaign_recipient_ids(p_campaign_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_segment text;
  v_city uuid;
  v_audience text;
  v_ids uuid[];
BEGIN
  SELECT segment_type, segment_city_id, audience_role
    INTO v_segment, v_city, v_audience
  FROM public.campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN
    RETURN '{}'::uuid[];
  END IF;

  IF v_segment = 'all' THEN
    SELECT array_agg(u.id) INTO v_ids FROM public.users u
    WHERE u.role::text = v_audience AND u.is_active;

  ELSIF v_segment = 'new_users' THEN
    SELECT array_agg(u.id) INTO v_ids FROM public.users u
    WHERE u.role::text = v_audience AND u.is_active AND u.created_at >= now() - interval '7 days';

  ELSIF v_segment = 'power_users' AND v_audience = 'customer' THEN
    SELECT array_agg(x.customer_id) INTO v_ids FROM (
      SELECT r.customer_id FROM public.rides r JOIN public.users u ON u.id = r.customer_id
      WHERE u.is_active GROUP BY r.customer_id HAVING count(*) > 10
    ) x;

  ELSIF v_segment = 'power_users' THEN
    SELECT array_agg(dp.user_id) INTO v_ids FROM public.driver_profiles dp
    JOIN public.users u ON u.id = dp.user_id
    WHERE u.is_active AND COALESCE(dp.total_rides_completed, dp.total_rides, 0) > 10;

  ELSIF v_segment = 'inactive' AND v_audience = 'customer' THEN
    SELECT array_agg(u.id) INTO v_ids FROM public.users u
    WHERE u.role::text = v_audience AND u.is_active
      AND NOT EXISTS (SELECT 1 FROM public.rides r
                      WHERE r.customer_id = u.id AND r.created_at >= now() - interval '30 days');

  ELSIF v_segment = 'inactive' THEN
    SELECT array_agg(u.id) INTO v_ids FROM public.users u
    WHERE u.role::text = v_audience AND u.is_active
      AND NOT EXISTS (SELECT 1 FROM public.rides r
                      JOIN public.driver_profiles dp ON dp.id = r.driver_id
                      WHERE dp.user_id = u.id AND r.created_at >= now() - interval '30 days');

  ELSIF v_segment = 'by_city' AND v_city IS NOT NULL THEN
    SELECT array_agg(u.id) INTO v_ids FROM public.users u
    WHERE u.role::text = v_audience AND u.is_active AND u.city_id = v_city;
  END IF;

  RETURN COALESCE(v_ids, '{}'::uuid[]);
END;
$$;
REVOKE ALL ON FUNCTION public.campaign_recipient_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_recipient_ids(uuid) TO service_role;

-- 4. Claim ---------------------------------------------------------------------------------
-- One statement, FOR UPDATE SKIP LOCKED: the panel button and the cron can never take the same
-- campaign twice. The locking SELECT is a MATERIALIZED CTE so it runs exactly once: written as
-- `c.id IN (SELECT ... LIMIT ... FOR UPDATE SKIP LOCKED)` the planner makes it the inner side of
-- a nested-loop semi join, rescans it for every outer row, and p_limit stops holding.
CREATE OR REPLACE FUNCTION public.claim_campaigns(p_campaign_id uuid DEFAULT NULL, p_limit integer DEFAULT 5)
RETURNS SETOF public.campaigns
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH due AS MATERIALIZED (
    SELECT d.id FROM public.campaigns d
     WHERE d.status = 'scheduled'
       AND d.scheduled_at <= now()
       AND (p_campaign_id IS NULL OR d.id = p_campaign_id)
     ORDER BY d.scheduled_at, d.id
     LIMIT GREATEST(p_limit, 0)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.campaigns c
     SET status = 'sending', started_at = now()
    FROM due
   WHERE c.id = due.id
     AND c.status = 'scheduled'
  RETURNING c.*;
$$;
REVOKE ALL ON FUNCTION public.claim_campaigns(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_campaigns(uuid, integer) TO service_role;

-- 5. Cancel --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_campaign(p_campaign_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_created_by uuid;
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo puedes cancelar las campañas que creaste.', DETAIL = 'campaign_cancel_forbidden';
  END IF;

  SELECT status, created_by INTO v_status, v_created_by
  FROM public.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF NOT public.is_admin() AND v_created_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo puedes cancelar las campañas que creaste.', DETAIL = 'campaign_cancel_forbidden';
  END IF;

  IF v_status <> 'scheduled' THEN
    RETURN v_status;
  END IF;

  UPDATE public.campaigns
     SET status = 'cancelled', canceled_at = now(), canceled_by = auth.uid()
   WHERE id = p_campaign_id;
  RETURN 'cancelled';
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_campaign(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_campaign(uuid) TO authenticated, service_role;

-- 6. Dispatcher and cron job ------------------------------------------------------------------
-- No EXCEPTION handler on purpose: a failure must reach check_cron_sql_failures (00596).
CREATE OR REPLACE FUNCTION public.dispatch_due_campaigns()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_due integer;
BEGIN
  -- A send that died halfway is never retried automatically: a retry could send twice.
  UPDATE public.campaigns
     SET status = 'failed', last_error = 'interrupted'
   WHERE status = 'sending' AND started_at < now() - interval '15 minutes';

  SELECT count(*) INTO v_due FROM public.campaigns
  WHERE status = 'scheduled' AND scheduled_at <= now();

  IF v_due > 0 THEN
    PERFORM public.cron_http_post('send-due-campaigns',
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-campaign',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || public.get_service_role_key(),
        'apikey', public.get_service_role_key()),
      body := '{"due": true}'::jsonb,
      timeout_milliseconds := 30000);
  END IF;
  RETURN v_due;
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_due_campaigns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_due_campaigns() TO service_role;

SELECT cron.schedule('send-due-campaigns', '* * * * *', 'SELECT public.dispatch_due_campaigns();');

-- 7. Self-checks ----------------------------------------------------------------------------
DO $check$
BEGIN
  IF has_function_privilege('authenticated', 'public.claim_campaigns(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.campaign_recipient_ids(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.dispatch_due_campaigns()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cancel_campaign(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00649: a client role can execute a server-only campaign function';
  END IF;
  IF has_table_privilege('authenticated', 'public.campaigns', 'UPDATE') THEN
    RAISE EXCEPTION '00649: authenticated can still UPDATE public.campaigns';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-due-campaigns'
                 AND command = 'SELECT public.dispatch_due_campaigns();') THEN
    RAISE EXCEPTION '00649: cron job send-due-campaigns is missing';
  END IF;
END $check$;

RESET lock_timeout;
