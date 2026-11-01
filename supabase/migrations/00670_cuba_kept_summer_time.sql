-- 00670: Cuba kept summer time (UTC-4) until 2027-11-07
--
-- WHY
--   On 2026-11-01 Cuba did not fall back: the government kept summer time
--   (UTC-4) until 2027-11-07 to cut evening blackouts. tzdata, in Postgres as
--   on phones, still applies the old rule: from 2026-11-01 05:00 UTC
--   'America/Havana' is UTC-5. Measured on prod that day:
--     SELECT utc_offset FROM pg_timezone_names WHERE name = 'America/Havana';  -- -05:00
--   So every server computation "in Havana time" ran an hour behind Cuba's
--   clock: the fare band the estimate snapshot and the waiting charge pick
--   (a ride at 18:30 got the 12-18 rate), the start of the corporate month
--   budget, the team digest's day and send hour, and the admin metrics.
--
-- WHAT
--   1. public.cuba_tz(p_at timestamptz DEFAULT now()): the IANA zone that
--      shows Cuba's clock at an instant. 'America/Santo_Domingo' (UTC-4 all
--      year, no DST) inside [2026-11-01 05:00Z, 2027-11-07 05:00Z), the span
--      where tzdata is wrong; 'America/Havana' outside, where it is right.
--      Same rule as cubaTimeZone() in packages/utils/src/date.ts and
--      supabase/functions/_shared/cuba-time.ts: keep the three in sync.
--   2. The 20 live functions that wrote the literal 'America/Havana' now
--      call public.cuba_tz(<instant>): the parameter that stands for "now"
--      where the function has one (p_now, p_arrived_at), now() elsewhere.
--      Patched in place from the LIVE body (pg_get_functiondef), each one
--      only if its body is the md5 measured on 2026-11-01, and each checked
--      against the md5 the same replacement gives offline. A body nobody
--      knows aborts the migration instead of being rewritten.
--
-- KNOWN LIMIT
--   Functions that convert many past rows with one zone (reports over a long
--   window) use the zone of now(): a row older than 2026-03-08 (UTC-5) shows
--   an hour late while the extension lasts. Reports here look back days or
--   weeks, so no current report is affected.
--
-- IDEMPOTENT: re-running finds the patched md5s and skips them.

-- ── 1. The zone ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cuba_tz(p_at timestamptz DEFAULT now())
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $cuba_tz$ SELECT CASE WHEN p_at >= timestamptz '2026-11-01 05:00:00+00' AND p_at < timestamptz '2027-11-07 05:00:00+00' THEN 'America/Santo_Domingo' ELSE 'America/Havana' END $cuba_tz$;

COMMENT ON FUNCTION public.cuba_tz(timestamptz) IS
  '00670: IANA zone of Cuba''s official clock at an instant. Cuba kept UTC-4 from 2026-11-01 to '
  '2027-11-07 while tzdata falls back to UTC-5; inside that span this returns America/Santo_Domingo. '
  'Mirrors cubaTimeZone() (packages/utils/src/date.ts, supabase/functions/_shared/cuba-time.ts).';

-- Trigger functions that run as the client (tg_recurring_rides_client_guard)
-- call it too.
REVOKE ALL ON FUNCTION public.cuba_tz(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cuba_tz(timestamptz) TO anon, authenticated, service_role;

-- ── 2. Patch the live functions ─────────────────────────────────────────────
DO $patch$
DECLARE
  r      record;
  v_md5  text;
  v_def  text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public._team_digest_totals(date)', 'a7b5c96c51cc27b0567d12e26ed826cd', 'cfc76615b07ff5415740ab3e123fef9f', ''),
    ('public._wait_charge_for(text,timestamp with time zone,timestamp with time zone)', 'caf3762b1dc87fce94e0b1f79bf39231', 'cd7a8577019dd8945d6e5575639e63ea', 'p_arrived_at'),
    ('public._write_ride_estimate_snapshot(public.rides,boolean)', '3158ab50b99457c52815b1bb75c1a008', '34756a7ea1e38b482cd1c1e0aa9865a7', ''),
    ('public.admin_deliveries_by_day(integer)', '283a77a52d989b77022b00cd85a8f766', '03c084967be3709ea1c3569dd70a3026', ''),
    ('public.admin_launch_pulse(integer)', '8a1937bbe51baf3772cfd067f7d3df2e', '3cb4919f1fab027a9be8450253995242', ''),
    ('public.check_cron_sql_failures()', 'f6ef567f3d9a6ff9050bcf862d9a3344', '0c0f58e17036bc08b948ffeff2b0d4ec', ''),
    ('public.check_team_digest_overdue(timestamp with time zone)', 'b2fd3012af81b5e981e7c44473685eae', 'b8542a53f93f1baabd159e6a96cd6cd7', 'p_now'),
    ('public.create_rides_for_recurring()', '5ace384a2e19b75c2f340162d46e957a', 'c0f9af8b06829ce95aa6b1e64df2c353', ''),
    ('public.dispatch_team_digest(timestamp with time zone)', 'f0a895ebe2b6d4cf472882cc853c1078', 'b83bd397082eeae2679e5a7dde57a644', 'p_now'),
    ('public.get_admin_dashboard_metrics()', '8b5f98c002141541b6837511ccee100c', 'a8928a91483088931f8457e3f71b2f70', ''),
    ('public.get_destination_suggestions(uuid,double precision,double precision,integer,integer)', 'd4841a72cef0980810b10f4a3df37664', 'bc9044cfcf1bb70600e7c794f7745cdc', ''),
    ('public.get_peak_hours(integer)', '9cc7e8ba4a44a026e5c7a02c939ad466', '4e78381d356c0814062a0dfa49a3a7ce', ''),
    ('public.get_platform_earnings()', '1580da05501f4f2f0f683fec822d7bfd', 'b1acbc03666c0abc6fc106e399bd3a9a', ''),
    ('public.get_rides_by_day(integer)', '339b0f0dbf075ea8c470097be5495bb1', 'd3797fe1337d92a0d36baed6efc1746f', ''),
    ('public.get_rides_by_payment_method(integer)', 'beb36eb41b576ec41e81430e9f6e8308', 'b193b4680be7c6099f4f7f2a24ee48e5', ''),
    ('public.get_rides_by_service_type(integer)', '1cd2058668e150fb7ce5d228cb9ab389', '9da58ac98cc6d61f46cb541a24b61bc1', ''),
    ('public.refresh_corporate_month_spend()', '868268ee2d6988b4f6493e6ed4305779', 'cce8fc1987c4ec2c2485d4c7656516cc', ''),
    ('public.team_daily_metrics(date)', '36ab1a68217774f5264ef60db40bdbc4', '594b2605e4ffb37e6db562b09c730700', ''),
    ('public.tg_recurring_rides_client_guard()', 'a2b28d015540a64ac5b388b0228c1132', 'dc938f5d404fd7b80a501035f27c0296', ''),
    ('public.tg_rides_validate_corporate()', '17bd1b28f1cf42550da942a102f008ba', '1ce7e55f97ad92e5f6e3416e375e374a', '')
  ) AS t(sig, old_md5, new_md5, arg)
  LOOP
    SELECT md5(p.prosrc), pg_get_functiondef(p.oid) INTO v_md5, v_def
    FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_def IS NULL THEN
      RAISE EXCEPTION '00670: % does not exist', r.sig;
    END IF;
    IF v_md5 = r.new_md5 THEN
      CONTINUE;  -- already patched
    END IF;
    IF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION '00670: % has an unknown body (md5 %, expected %); re-derive the patch from the live body', r.sig, v_md5, r.old_md5;
    END IF;
    EXECUTE replace(v_def, '''America/Havana''', 'public.cuba_tz(' || r.arg || ')');
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION '00670: % patched to md5 %, expected %', r.sig, v_md5, r.new_md5;
    END IF;
  END LOOP;
END
$patch$;

-- ── 3. Checks ───────────────────────────────────────────────────────────────
DO $check$
DECLARE
  v_left text;
BEGIN
  -- No function in public still pins tzdata's Havana rule by name.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosrc LIKE '%''America/Havana''%'
    AND p.proname <> 'cuba_tz';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION '00670: still using ''America/Havana'': %', v_left;
  END IF;

  -- The zone the server uses on each side of the extension.
  IF public.cuba_tz(timestamptz '2026-11-01 04:59:59+00') <> 'America/Havana'
     OR public.cuba_tz(timestamptz '2026-11-01 05:00:00+00') <> 'America/Santo_Domingo'
     OR public.cuba_tz(timestamptz '2027-03-01 12:00:00+00') <> 'America/Santo_Domingo'
     OR public.cuba_tz(timestamptz '2027-11-07 05:00:00+00') <> 'America/Havana' THEN
    RAISE EXCEPTION '00670: cuba_tz boundaries are wrong';
  END IF;

  -- Cuba's wall clock on 2026-12-01 16:00 UTC is 12:00 (UTC-4), on
  -- 2026-01-15 16:00 UTC 11:00 (UTC-5), on 2027-12-01 16:00 UTC 11:00.
  IF (timestamptz '2026-12-01 16:00:00+00' AT TIME ZONE public.cuba_tz(timestamptz '2026-12-01 16:00:00+00'))::time <> '12:00'
     OR (timestamptz '2026-01-15 16:00:00+00' AT TIME ZONE public.cuba_tz(timestamptz '2026-01-15 16:00:00+00'))::time <> '11:00'
     OR (timestamptz '2027-12-01 16:00:00+00' AT TIME ZONE public.cuba_tz(timestamptz '2027-12-01 16:00:00+00'))::time <> '11:00' THEN
    RAISE EXCEPTION '00670: cuba_tz does not give Cuba''s wall clock';
  END IF;
END
$check$;
