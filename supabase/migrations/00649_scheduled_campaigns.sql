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
--
-- SET LOCAL: the setting ends with the transaction (supabase db push, MCP apply_migration and the
-- SQL Editor each run the file in one), so there is no RESET to forget. 3 s, not more: the foreign
-- key to auth.users (section 8) locks that table against GoTrue's writes, i.e. logins.
-- ============================================================
SET LOCAL lock_timeout = '3s';

-- 1. Columns and CHECKs -------------------------------------------------------------------
-- canceled_by gets its foreign key to auth.users at the end of the file (section 8).
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS recipient_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS push_sent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_sent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz,
  ADD COLUMN IF NOT EXISTS canceled_by uuid;

-- Every existing row satisfies them (prod on 2026-10-09: 2 rows, both 'sent', channel 'both' and
-- 'push', segment 'all', audience 'customer'). campaigns_audience_role_chk exists since 00478; it
-- is listed so that a database without it gets it, and the self-check below can rely on it.
DO $chk$
DECLARE
  v_c record;
BEGIN
  FOR v_c IN
    SELECT * FROM (VALUES
      ('campaigns_status_chk',
       $c$CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'))$c$),
      -- A scheduled row without a time would never be due, so never sent.
      ('campaigns_scheduled_at_chk', $c$CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL)$c$),
      ('campaigns_channel_chk', $c$CHECK (channel IN ('push', 'email', 'both'))$c$),
      ('campaigns_segment_type_chk',
       $c$CHECK (segment_type IN ('all', 'new_users', 'power_users', 'inactive', 'by_city'))$c$),
      ('campaigns_audience_role_chk', $c$CHECK (audience_role IN ('customer', 'driver'))$c$)
    ) AS t (con_name, con_def)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                   WHERE conrelid = 'public.campaigns'::regclass AND conname = v_c.con_name) THEN
      EXECUTE format('ALTER TABLE public.campaigns ADD CONSTRAINT %I %s', v_c.con_name, v_c.con_def);
    END IF;
  END LOOP;
END $chk$;

CREATE INDEX IF NOT EXISTS idx_campaigns_due ON public.campaigns (scheduled_at) WHERE status = 'scheduled';

-- 2. Client writes ------------------------------------------------------------------------
-- Status and counters change only through the functions below. The admin ALL policy keeps
-- SELECT, INSERT and DELETE; marketing keeps its SELECT and INSERT policies (00642).
-- Revoking a table privilege also revokes the same privilege on every column (no column-level
-- UPDATE grant survives this).
REVOKE UPDATE, TRUNCATE, TRIGGER ON public.campaigns FROM PUBLIC, anon, authenticated;
REVOKE INSERT ON public.campaigns FROM PUBLIC, anon;
-- MAINTAIN exists from PostgreSQL 17 (prod); the local rehearsal runs 16, which has no such privilege.
DO $maintain$
BEGIN
  IF current_setting('server_version_num')::integer >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON public.campaigns FROM PUBLIC, anon, authenticated';
  END IF;
END $maintain$;

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

CREATE OR REPLACE TRIGGER trg_campaigns_client_insert
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
-- Only for panel users (authenticated): a caller without a JWT is never admin nor marketing.
CREATE OR REPLACE FUNCTION public.cancel_campaign(p_campaign_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_created_by uuid;
  v_rows integer;
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo puedes cancelar las campañas que creaste.', DETAIL = 'campaign_cancel_forbidden';
  END IF;

  -- FOR UPDATE: a claim that holds the row (scheduled -> sending, not committed yet) makes this
  -- wait and then read 'sending'. Without the lock, a cancel in the middle of a claim would
  -- overwrite 'sending' with 'cancelled' while send-campaign sends the campaign.
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

  -- Second safeguard, should the lock above ever go: only a row that is still scheduled is cancelled.
  UPDATE public.campaigns
     SET status = 'cancelled', canceled_at = now(), canceled_by = auth.uid()
   WHERE id = p_campaign_id AND status = 'scheduled';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    SELECT status INTO v_status FROM public.campaigns WHERE id = p_campaign_id;
    RETURN COALESCE(v_status, 'not_found');
  END IF;
  RETURN 'cancelled';
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_campaign(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_campaign(uuid) TO authenticated;

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
  v_key text;
BEGIN
  -- A send that died halfway is never retried automatically: a retry could send twice.
  UPDATE public.campaigns
     SET status = 'failed', last_error = 'interrupted'
   WHERE status = 'sending' AND started_at < now() - interval '15 minutes';

  SELECT count(*) INTO v_due FROM public.campaigns
  WHERE status = 'scheduled' AND scheduled_at <= now();

  IF v_due > 0 THEN
    -- Without the vault secret the call would carry no key and send-campaign would answer 401
    -- every minute, unseen. Failing the run makes check_cron_sql_failures report it.
    v_key := public.get_service_role_key();
    IF v_key IS NULL OR v_key = '' THEN
      RAISE EXCEPTION 'dispatch_due_campaigns: no service role key in the vault, % due campaign(s) not sent', v_due
        USING DETAIL = 'campaign_dispatch_no_service_key';
    END IF;
    PERFORM public.cron_http_post('send-due-campaigns',
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-campaign',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key,
        'apikey', v_key),
      body := '{"due": true}'::jsonb,
      timeout_milliseconds := 30000);
  END IF;
  RETURN v_due;
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_due_campaigns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_due_campaigns() TO service_role;

-- cron.schedule updates an existing job's schedule and command but keeps its active flag. This
-- migration exists so the job runs: a job that someone paused is switched back on.
DO $cron$
DECLARE
  v_job bigint;
BEGIN
  v_job := cron.schedule('send-due-campaigns', '* * * * *', 'SELECT public.dispatch_due_campaigns();');
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_job AND NOT active) THEN
    PERFORM cron.alter_job(v_job, active := true);
  END IF;
END $cron$;

-- 7. Pasted from Windows (CRLF), the bodies would carry \r: recreate them from the catalog
--    without it, so their md5 matches git.
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.tg_campaigns_client_insert()', 'public.campaign_recipient_ids(uuid)',
    'public.claim_campaigns(uuid, integer)', 'public.cancel_campaign(uuid)',
    'public.dispatch_due_campaigns()']::regprocedure[]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END $crlf$;

-- 8. canceled_by -> auth.users, last ------------------------------------------------------
-- Adding a foreign key takes SHARE ROW EXCLUSIVE on auth.users until commit, and GoTrue writes
-- there on every login. Last in the file, so logins wait at most for the self-checks below;
-- lock_timeout (3 s) caps the wait for the lock itself.
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'public.campaigns'::regclass AND conname = 'campaigns_canceled_by_fkey') THEN
    ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_canceled_by_fkey
      FOREIGN KEY (canceled_by) REFERENCES auth.users (id) ON DELETE SET NULL;
  END IF;
END $fk$;

-- 9. Self-checks ----------------------------------------------------------------------------
-- has_any_column_privilege: a column-level INSERT or UPDATE grant is enough to write.
DO $check$
DECLARE
  v_name text;
  v_enabled text;
BEGIN
  IF has_function_privilege('anon', 'public.claim_campaigns(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_campaigns(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.campaign_recipient_ids(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.campaign_recipient_ids(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.dispatch_due_campaigns()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.dispatch_due_campaigns()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cancel_campaign(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00649: a client role can execute a server-only campaign function';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.cancel_campaign(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00649: authenticated cannot execute cancel_campaign';
  END IF;

  IF has_any_column_privilege('anon', 'public.campaigns', 'INSERT')
     OR has_any_column_privilege('anon', 'public.campaigns', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.campaigns', 'UPDATE')
     OR has_table_privilege('anon', 'public.campaigns', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.campaigns', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.campaigns', 'TRIGGER')
     OR has_table_privilege('authenticated', 'public.campaigns', 'TRIGGER') THEN
    RAISE EXCEPTION '00649: a client role can still write public.campaigns outside the functions';
  END IF;
  IF current_setting('server_version_num')::integer >= 170000 THEN
    IF has_table_privilege('anon', 'public.campaigns', 'MAINTAIN')
       OR has_table_privilege('authenticated', 'public.campaigns', 'MAINTAIN') THEN
      RAISE EXCEPTION '00649: a client role still has MAINTAIN on public.campaigns';
    END IF;
  END IF;
  -- What the panel (insert, list) and send-campaign (result writes) still need.
  IF NOT (has_table_privilege('authenticated', 'public.campaigns', 'SELECT')
          AND has_table_privilege('authenticated', 'public.campaigns', 'INSERT')
          AND has_table_privilege('service_role', 'public.campaigns', 'SELECT')
          AND has_table_privilege('service_role', 'public.campaigns', 'UPDATE')) THEN
    RAISE EXCEPTION '00649: the panel or the service role lost a privilege it needs on public.campaigns';
  END IF;

  SELECT tgenabled::text INTO v_enabled FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'public.campaigns'::regclass AND tgname = 'trg_campaigns_client_insert'
     AND tgfoid = 'public.tg_campaigns_client_insert()'::regprocedure
     AND tgtype = 7;  -- BEFORE INSERT FOR EACH ROW
  IF v_enabled IS NULL OR v_enabled NOT IN ('O', 'A') THEN
    RAISE EXCEPTION '00649: trigger trg_campaigns_client_insert is missing or disabled';
  END IF;

  FOREACH v_name IN ARRAY ARRAY['campaigns_status_chk', 'campaigns_scheduled_at_chk', 'campaigns_channel_chk',
                                'campaigns_segment_type_chk', 'campaigns_audience_role_chk']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                   WHERE conrelid = 'public.campaigns'::regclass AND conname = v_name
                     AND contype = 'c' AND convalidated) THEN
      RAISE EXCEPTION '00649: CHECK % is missing on public.campaigns', v_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'public.campaigns'::regclass AND conname = 'campaigns_canceled_by_fkey'
                   AND contype = 'f' AND confrelid = 'auth.users'::regclass AND confdeltype = 'n'
                   AND convalidated) THEN
    RAISE EXCEPTION '00649: foreign key campaigns_canceled_by_fkey is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-due-campaigns' AND schedule = '* * * * *'
                 AND command = 'SELECT public.dispatch_due_campaigns();' AND active) THEN
    RAISE EXCEPTION '00649: cron job send-due-campaigns is missing or inactive';
  END IF;
END $check$;
