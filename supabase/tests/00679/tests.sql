-- Tests of the 00679 rehearsal. Run by run.sh with psql -qAt, without ON_ERROR_STOP:
-- each case is one transaction, rolled back, that ends by printing "PASS  <name>" or
-- "FAIL  <name>  -- expected [...], got [...]" through tst.t(). A case whose setup fails
-- prints nothing; run.sh reports every tst.t() name of this file that did not print as FAIL.
-- Client calls run as PostgREST would: SET LOCAL ROLE anon/authenticated + JWT subject;
-- values cross the role switch in t.* settings (any role may set them).

\set SUPER   '5a000000-0000-4000-8000-000000000001'
\set RIDER   '5a000000-0000-4000-8000-000000000002'
\set RIDER2  '5a000000-0000-4000-8000-000000000003'
\set PILOTU  '5a000000-0000-4000-8000-000000000011'
\set MOTO2U  '5a000000-0000-4000-8000-000000000012'
\set TRIKEU  '5a000000-0000-4000-8000-000000000013'
\set PILOT   '5b000000-0000-4000-8000-000000000011'
\set MOTO2   '5b000000-0000-4000-8000-000000000012'
\set TRIKE   '5b000000-0000-4000-8000-000000000013'
\set PICK    'ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography'

-- Building blocks (raw SQL, interpolated with :NAME).
\set LIST_PILOT   'INSERT INTO public.moto_deportiva_pilots (driver_profile_id) VALUES (''5b000000-0000-4000-8000-000000000011'');'
\set PILOT_ON     'UPDATE public.driver_profiles SET is_online = true  WHERE id = ''5b000000-0000-4000-8000-000000000011'';'
\set PILOT_OFF    'UPDATE public.driver_profiles SET is_online = false WHERE id = ''5b000000-0000-4000-8000-000000000011'';'
\set MOTO2_ON     'UPDATE public.driver_profiles SET is_online = true  WHERE id = ''5b000000-0000-4000-8000-000000000012'';'
\set SWITCH_OFF   'UPDATE public.service_type_configs SET is_active = false WHERE slug = ''moto_deportiva'';'
\set AS_ANON      'SET LOCAL request.jwt.claim.sub = ''''; SET LOCAL ROLE anon;'
\set AS_ME        'RESET ROLE; SET LOCAL request.jwt.claim.sub = '''';'
-- the status as anon, into t.r
\set ANON_STATUS  'SET LOCAL request.jwt.claim.sub = ''''; SET LOCAL ROLE anon; SELECT 1 WHERE set_config(''t.r'', public.get_moto_deportiva_status() ->> ''status'', true) IS NULL; RESET ROLE;'
-- the two riders subscribe from their apps
\set SUBSCRIBE    'SET LOCAL request.jwt.claim.sub = ''5a000000-0000-4000-8000-000000000002''; SET LOCAL ROLE authenticated; SELECT 1 WHERE public.set_moto_deportiva_waitlist(true) IS NULL; SET LOCAL request.jwt.claim.sub = ''5a000000-0000-4000-8000-000000000003''; SELECT 1 WHERE public.set_moto_deportiva_waitlist(true) IS NULL; RESET ROLE; SET LOCAL request.jwt.claim.sub = '''';'
-- the pilot connects from his app
\set PILOT_APP_ON 'SET LOCAL request.jwt.claim.sub = ''5a000000-0000-4000-8000-000000000011''; SET LOCAL ROLE authenticated; UPDATE public.driver_profiles SET is_online = true WHERE id = ''5b000000-0000-4000-8000-000000000011''; RESET ROLE; SET LOCAL request.jwt.claim.sub = '''';'
\set MD_PUSHES '(SELECT count(*) FROM net.sent WHERE body -> ''data'' ->> ''content_type'' = ''moto_deportiva'')'

-- ── 1. Dispatch ───────────────────────────────────────────────
BEGIN;
:PILOT_ON :MOTO2_ON
SELECT tst.t('T1 not listed, a moto ride reaches both motos',
  (SELECT string_agg(f.id::text, ',' ORDER BY f.id) FROM public.find_best_drivers(23.1357, -82.3666, 'moto_standard', 50, 5000) f),
  :'PILOT' || ',' || :'MOTO2');
ROLLBACK;

BEGIN;
:LIST_PILOT :PILOT_ON :MOTO2_ON
SELECT tst.t('T2 listed, a Moto Deportiva ride reaches only the pilot',
  (SELECT string_agg(f.id::text, ',' ORDER BY f.id) FROM public.find_best_drivers(23.1357, -82.3666, 'moto_deportiva', 50, 5000) f),
  :'PILOT');
SELECT tst.t('T3 listed, a moto ride no longer reaches the pilot',
  (SELECT string_agg(f.id::text, ',' ORDER BY f.id) FROM public.find_best_drivers(23.1357, -82.3666, 'moto_standard', 50, 5000) f),
  :'MOTO2');
SELECT tst.t('T4a listed, a triciclo ride never reaches the pilot',
  (SELECT string_agg(f.id::text, ',' ORDER BY f.id) FROM public.find_best_drivers(23.1357, -82.3666, 'triciclo_basico', 50, 5000) f),
  :'TRIKE');
SELECT tst.t('T4b listed, a delivery reaches the other cargo moto but never the pilot',
  (SELECT string_agg(f.id::text, ',' ORDER BY f.id) FROM public.find_best_drivers(23.1357, -82.3666, 'mensajeria', 50, 5000, true) f),
  :'MOTO2');
ROLLBACK;

-- ── 2. Status ─────────────────────────────────────────────────
BEGIN;
:LIST_PILOT
:ANON_STATUS
SELECT tst.t('T5a no pilot online: offline', current_setting('t.r'), 'offline');
UPDATE public.platform_config SET value = 'false'::jsonb WHERE key = 'moto_deportiva_show_when_unavailable';
:ANON_STATUS
SELECT tst.t('T5b offline with show_when_unavailable = false: hidden', current_setting('t.r'), 'hidden');
ROLLBACK;

BEGIN;
:LIST_PILOT :PILOT_ON
:ANON_STATUS
SELECT tst.t('T6 the pilot online and free: available', current_setting('t.r'), 'available');
UPDATE public.platform_config SET value = 'false'::jsonb WHERE key = 'moto_deportiva_show_when_unavailable';
:ANON_STATUS
SELECT tst.t('T6b available is shown even when show_when_unavailable = false', current_setting('t.r'), 'available');
ROLLBACK;

BEGIN;
:LIST_PILOT :PILOT_ON
INSERT INTO public.rides (customer_id, driver_id, status, service_type) VALUES (:'RIDER2', :'PILOT', 'in_progress', 'moto_deportiva');
:ANON_STATUS
SELECT tst.t('T7 the pilot on a ride: busy', current_setting('t.r'), 'busy');
ROLLBACK;

BEGIN;
:LIST_PILOT :PILOT_ON
INSERT INTO public.rides (customer_id, status, service_type, created_at) VALUES (:'RIDER2', 'searching', 'moto_deportiva', now() - interval '10 seconds');
:ANON_STATUS
SELECT tst.t('T8 a Moto Deportiva request searching for 10 s: busy', current_setting('t.r'), 'busy');
ROLLBACK;

BEGIN;
:LIST_PILOT :PILOT_ON :SWITCH_OFF
:ANON_STATUS
SELECT tst.t('T9 deactivated in the panel, the pilot online: off', current_setting('t.r'), 'off');
ROLLBACK;

-- ── 3. Insert guard ───────────────────────────────────────────
BEGIN;
:LIST_PILOT :PILOT_ON
INSERT INTO public.rides (customer_id, driver_id, status, service_type) VALUES (:'RIDER2', :'PILOT', 'in_progress', 'moto_deportiva');
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000002'; SET LOCAL ROLE authenticated;
DO $$
DECLARE d text;
BEGIN
  BEGIN
    INSERT INTO public.rides (customer_id, service_type) VALUES ('5a000000-0000-4000-8000-000000000002', 'moto_deportiva');
    d := 'inserted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
  END;
  PERFORM set_config('t.r', d, true);
END $$;
:AS_ME
SELECT tst.t('T10 a rider asks for it while busy: refused', current_setting('t.r'), 'moto_deportiva_unavailable');
ROLLBACK;

BEGIN;
:LIST_PILOT :PILOT_ON
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000002'; SET LOCAL ROLE authenticated;
INSERT INTO public.rides (customer_id, service_type) VALUES ('5a000000-0000-4000-8000-000000000002', 'moto_deportiva');
:AS_ME
SELECT tst.t('T11 a rider asks for it while available: the ride is created',
  (SELECT count(*)::text FROM public.rides WHERE customer_id = :'RIDER' AND service_type = 'moto_deportiva'), '1');
ROLLBACK;

BEGIN;
:LIST_PILOT :PILOT_ON
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000002'; SET LOCAL ROLE authenticated;
DO $$
DECLARE d text;
BEGIN
  BEGIN
    INSERT INTO public.rides (customer_id, service_type, scheduled_at)
    VALUES ('5a000000-0000-4000-8000-000000000002', 'moto_deportiva', now() + interval '1 day');
    d := 'inserted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
  END;
  PERFORM set_config('t.r', d, true);
END $$;
:AS_ME
SELECT tst.t('T11b available, but a scheduled Moto Deportiva is refused', current_setting('t.r'), 'moto_deportiva_unavailable');
ROLLBACK;

BEGIN;
SET LOCAL ROLE tricigo_owner;
INSERT INTO public.rides (customer_id, service_type) VALUES ('5a000000-0000-4000-8000-000000000002', 'moto_deportiva');
RESET ROLE;
SELECT tst.t('T12 the server (no client role) creates one while offline',
  (SELECT count(*)::text FROM public.rides WHERE customer_id = :'RIDER' AND service_type = 'moto_deportiva'), '1');
ROLLBACK;

-- ── 4. Notice to subscribers ──────────────────────────────────
BEGIN;
:LIST_PILOT
:SUBSCRIBE
:PILOT_APP_ON
SELECT tst.t('T13a the pilot connects: one push to both subscribers',
  (SELECT count(*) || '|' || string_agg((SELECT string_agg(x, ',' ORDER BY x) FROM jsonb_array_elements_text(body -> 'user_ids') x), ';')
     FROM net.sent WHERE body -> 'data' ->> 'content_type' = 'moto_deportiva'),
  '1|' || :'RIDER' || ',' || :'RIDER2');
SELECT tst.t('T13b ...through cron_http_post, to send-push',
  (SELECT count(*)::text FROM public.cron_http_calls c JOIN net.sent s ON s.id = c.request_id
    WHERE c.jobname = 'moto-deportiva-waitlist' AND s.url LIKE '%/functions/v1/send-push'), '1');
SELECT tst.t('T13c one notice row (pilot_online, 2), both stamped notified',
  (SELECT string_agg(source || ':' || recipients, ',') FROM public.moto_deportiva_notices)
    || '|' || (SELECT count(*) FROM public.moto_deportiva_waitlist WHERE notified_at IS NOT NULL),
  'pilot_online:2|2');
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000002'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r', public.get_moto_deportiva_status() ->> 'waiting', true) IS NULL;
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000003';
SELECT 1 WHERE set_config('t.r', current_setting('t.r') || ',' || (public.get_moto_deportiva_status() ->> 'waiting'), true) IS NULL;
:AS_ME
SELECT tst.t('T13d both are still subscribed', current_setting('t.r'), 'true,true');
:PILOT_OFF
:PILOT_APP_ON
SELECT tst.t('T14 connecting again within 3 h: no new push', :MD_PUSHES::text, '1');
UPDATE public.moto_deportiva_notices SET sent_at = sent_at - interval '4 hours';
:PILOT_OFF
:PILOT_APP_ON
SELECT tst.t('T15 after the cooldown: a second push to both (permanent subscription)',
  (SELECT count(*) || '|' || (SELECT string_agg(x, ',' ORDER BY x) FROM jsonb_array_elements_text(
      (SELECT body -> 'user_ids' FROM net.sent WHERE body -> 'data' ->> 'content_type' = 'moto_deportiva' ORDER BY id DESC LIMIT 1)) x)
     FROM net.sent WHERE body -> 'data' ->> 'content_type' = 'moto_deportiva'),
  '2|' || :'RIDER' || ',' || :'RIDER2');
ROLLBACK;

BEGIN;
:LIST_PILOT
:SUBSCRIBE
:MOTO2_ON
SELECT tst.t('T16 a moto that is not a pilot connects: no push', :MD_PUSHES::text, '0');
ROLLBACK;

BEGIN;
:LIST_PILOT
:SUBSCRIBE
:SWITCH_OFF
:PILOT_APP_ON
SELECT tst.t('T17 deactivated, the pilot connects: no push, no notice',
  :MD_PUSHES || '|' || (SELECT count(*) FROM public.moto_deportiva_notices), '0|0');
ROLLBACK;

BEGIN;
:LIST_PILOT
:SUBSCRIBE
DELETE FROM vault.secret_store;
:PILOT_APP_ON
SELECT tst.t('T18 no service key: the pilot is online anyway, one push_failed row, no notice',
  (SELECT is_online::text FROM public.driver_profiles WHERE id = :'PILOT')
    || '|' || (SELECT count(*) FROM public.rpc_attempt_log WHERE rpc_name = 'moto_deportiva_waitlist_push' AND outcome = 'push_failed')
    || '|' || (SELECT count(*) FROM public.moto_deportiva_notices) || '|' || :MD_PUSHES,
  'true|1|0|0');
ROLLBACK;

-- ── 5. Super admin RPCs ───────────────────────────────────────
BEGIN;
:LIST_PILOT
:SUBSCRIBE
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000002'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r',
  (public.admin_set_moto_deportiva(false) ->> 'error') || ',' ||
  (public.admin_moto_deportiva_subscribers() ->> 'error') || ',' ||
  (public.admin_remove_moto_deportiva_subscriber('5a000000-0000-4000-8000-000000000003') ->> 'error') || ',' ||
  (public.admin_moto_deportiva_overview() ->> 'error') || ',' ||
  (public.admin_add_moto_deportiva_pilot('5355510012') ->> 'error') || ',' ||
  (public.admin_remove_moto_deportiva_pilot('5b000000-0000-4000-8000-000000000011') ->> 'error'), true) IS NULL;
:AS_ME
SELECT tst.t('T19a a rider gets forbidden from every admin RPC', current_setting('t.r'),
  'forbidden,forbidden,forbidden,forbidden,forbidden,forbidden');
SELECT tst.t('T19b ...and nothing changed',
  (SELECT is_active::text FROM public.service_type_configs WHERE slug = 'moto_deportiva')
    || '|' || (SELECT count(*) FROM public.moto_deportiva_waitlist) || '|' || (SELECT count(*) FROM public.moto_deportiva_pilots)
    || '|' || (SELECT count(*) FROM public.admin_actions),
  'true|2|1|0');
ROLLBACK;

BEGIN;
:SUBSCRIBE
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000001'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r', (SELECT string_agg(e ->> 'full_name' || ':' || (e ->> 'phone'), ',' ORDER BY e ->> 'full_name')
  FROM jsonb_array_elements(public.admin_moto_deportiva_subscribers() -> 'subscribers') e), true) IS NULL;
:AS_ME
SELECT tst.t('T20a a super admin lists the subscribers with name and phone', current_setting('t.r'),
  'Ramon Rider:+5355510003,Rita Rider:+5355510002');
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000001'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r', public.admin_remove_moto_deportiva_subscriber('5a000000-0000-4000-8000-000000000003')::text, true) IS NULL;
:AS_ME
SELECT tst.t('T20b ...removes one: gone, and one admin_actions row',
  current_setting('t.r') || '|' || (SELECT string_agg(user_id::text, ',') FROM public.moto_deportiva_waitlist)
    || '|' || (SELECT count(*) FROM public.admin_actions WHERE action = 'moto_deportiva_remove_subscriber' AND admin_id = :'SUPER' AND target_id = :'RIDER2'),
  '{"success": true}|' || :'RIDER' || '|1');
ROLLBACK;

BEGIN;
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000001'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r',
  coalesce(public.admin_add_moto_deportiva_pilot('+53 5551 0011') ->> 'success', 'no') || ',' ||
  coalesce(public.admin_add_moto_deportiva_pilot('+5355510013') ->> 'error', 'no') || ',' ||
  coalesce(public.admin_add_moto_deportiva_pilot('+5355519999') ->> 'error', 'no'), true) IS NULL;
:AS_ME
SELECT tst.t('T21 add the pilot by phone; the triciclo driver and an unknown number are refused',
  current_setting('t.r') || '|' || (SELECT string_agg(driver_profile_id::text, ',') FROM public.moto_deportiva_pilots)
    || '|' || (SELECT count(*) FROM public.admin_actions WHERE action = 'moto_deportiva_add_pilot'),
  'true,not_an_approved_moto_driver,phone_not_found|' || :'PILOT' || '|1');
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000001'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r', (public.admin_moto_deportiva_overview() -> 'pilots' -> 0 ->> 'full_name')
  || ',' || (public.admin_remove_moto_deportiva_pilot('5b000000-0000-4000-8000-000000000011') ->> 'success'), true) IS NULL;
:AS_ME
SELECT tst.t('T21b the overview lists the pilot; removing him empties the list',
  current_setting('t.r') || '|' || (SELECT count(*) FROM public.moto_deportiva_pilots), 'Pablo Piloto,true|0');
ROLLBACK;

-- ── 6. Reactivation push and support ──────────────────────────
BEGIN;
:LIST_PILOT
INSERT INTO public.rides (customer_id, status, service_type, created_at) VALUES (:'RIDER', 'searching', 'moto_deportiva', now() - interval '5 minutes');
SELECT tst.t('T22 a searching Moto Deportiva wakes nobody up',
  public.notify_offline_drivers_for_searching_rides() || '|' || (SELECT count(*) FROM net.sent WHERE body ->> 'category' = 'ride_matching'),
  '0|0');
ROLLBACK;

BEGIN;
:LIST_PILOT
INSERT INTO public.rides (customer_id, status, service_type, created_at) VALUES (:'RIDER', 'searching', 'moto_standard', now() - interval '5 minutes');
SELECT 1 WHERE public.notify_offline_drivers_for_searching_rides() IS NULL;
SELECT tst.t('T23 a searching moto wakes the other moto up, not the pilot',
  (SELECT string_agg(body ->> 'user_ids', ';') FROM net.sent WHERE body ->> 'category' = 'ride_matching'),
  '["' || :'MOTO2U' || '"]');
ROLLBACK;

BEGIN;
:LIST_PILOT
SELECT tst.t('T24 support: the pilot serves Moto Deportiva only; the other moto, the opposite',
  public._driver_can_serve_ride(:'PILOT', 'moto_standard', false) || ',' || public._driver_can_serve_ride(:'PILOT', 'moto_deportiva', false)
    || ',' || public._driver_can_serve_ride(:'MOTO2', 'moto_standard', false) || ',' || public._driver_can_serve_ride(:'MOTO2', 'moto_deportiva', false),
  'false,true,true,false');
ROLLBACK;

-- ── 7. Lock tables ────────────────────────────────────────────
BEGIN;
DO $$
DECLARE
  v_role text; v_tbl text; v_state text; v_out text := '';
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_tbl IN ARRAY ARRAY['moto_deportiva_pilots', 'moto_deportiva_waitlist', 'moto_deportiva_notices'] LOOP
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', v_role);
        EXECUTE format('SELECT count(*) FROM public.%I', v_tbl);
        v_state := 'readable';
      EXCEPTION WHEN OTHERS THEN
        v_state := SQLSTATE;
      END;
      RESET ROLE;
      v_out := v_out || v_state || ',';
    END LOOP;
  END LOOP;
  PERFORM set_config('t.r', v_out, true);
END $$;
SELECT tst.t('T25 anon and authenticated cannot read the three lock tables', current_setting('t.r'),
  '42501,42501,42501,42501,42501,42501,');
ROLLBACK;

-- ── 8. Prices ─────────────────────────────────────────────────
SELECT tst.t('T26a the service row: moto minimum - 200 (+-1), one seat, activated',
  (SELECT ((d.min_fare_cup - (m.min_fare_cup - 200)) BETWEEN -1 AND 1) || ',' || d.max_passengers || ',' || d.is_active
     FROM public.service_type_configs d, public.service_type_configs m WHERE d.slug = 'moto_deportiva' AND m.slug = 'moto_standard'),
  'true,1,true');
SELECT tst.t('T26b the 4 bands copied; each minimum 200 lower (+-1); the 06-12 one keeps base 0',
  (SELECT count(*) || ',' || bool_and(abs(d.min_fare_cup - (m.min_fare_cup - 200)) <= 1) || ','
          || bool_and(d.base_fare_cup = m.base_fare_cup AND d.per_km_rate_cup = m.per_km_rate_cup)
          || ',' || max(d.base_fare_cup) FILTER (WHERE d.time_window_start = '06:00')
     FROM public.pricing_rules d JOIN public.pricing_rules m
       ON m.service_type = 'moto_standard' AND m.time_window_start = d.time_window_start
    WHERE d.service_type = 'moto_deportiva'),
  '4,true,true,0');
SELECT tst.t('T26c the settings: offset -200, shown when unavailable, 3 h cooldown',
  (SELECT string_agg(key || '=' || value::text, ',' ORDER BY key) FROM public.platform_config WHERE key LIKE 'moto_deportiva%'),
  'moto_deportiva_price_offset_cup=-200,moto_deportiva_show_when_unavailable=true,moto_deportiva_waitlist_cooldown_h=3');

-- ── 9. Activate from the panel ────────────────────────────────
BEGIN;
:LIST_PILOT
:SUBSCRIBE
:SWITCH_OFF
:PILOT_ON
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000001'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r', public.admin_set_moto_deportiva(true)::text, true) IS NULL;
:AS_ME
SELECT tst.t('T27a activated with the pilot online: notified 2, one push, a notice admin_on, one switch row',
  current_setting('t.r') || '|' || :MD_PUSHES || '|' || (SELECT string_agg(source || ':' || recipients, ',') FROM public.moto_deportiva_notices)
    || '|' || (SELECT count(*) FROM public.admin_actions WHERE action = 'moto_deportiva_switch'),
  '{"active": true, "success": true, "notified": 2}|1|admin_on:2|1');
ROLLBACK;

BEGIN;
:LIST_PILOT
:SUBSCRIBE
:SWITCH_OFF
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000001'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r', public.admin_set_moto_deportiva(true)::text, true) IS NULL;
:AS_ME
SELECT tst.t('T27b activated with no pilot online: nothing sent',
  current_setting('t.r') || '|' || :MD_PUSHES || '|' || (SELECT count(*) FROM public.moto_deportiva_notices),
  '{"active": true, "success": true, "notified": 0}|0|0');
ROLLBACK;

-- ── 10. Metrics ───────────────────────────────────────────────
BEGIN;
:LIST_PILOT
:SUBSCRIBE
INSERT INTO public.moto_deportiva_notices (recipients, source) VALUES (2, 'pilot_online');
INSERT INTO public.moto_deportiva_notices (recipients, source, sent_at) VALUES (5, 'pilot_online', now() - interval '40 days');
-- RIDER2 rode a moto before; RIDER's first ride ever is a Moto Deportiva.
INSERT INTO public.rides (customer_id, driver_id, status, service_type, final_fare_cup, completed_at, created_at) VALUES
  (:'RIDER2', :'MOTO2', 'completed', 'moto_standard', 700, now() - interval '20 days', now() - interval '20 days'),
  (:'RIDER',  :'PILOT', 'completed', 'moto_deportiva', 600, now() - interval '2 days', now() - interval '2 days'),
  (:'RIDER2', :'PILOT', 'completed', 'moto_deportiva', 500, now() - interval '1 day', now() - interval '1 day'),
  (:'RIDER',  NULL,     'canceled',  'moto_deportiva', NULL, NULL, now() - interval '3 days'),
  (:'RIDER2', NULL,     'canceled',  'moto_deportiva', NULL, NULL, now() - interval '3 days'),
  (:'RIDER',  :'PILOT', 'completed', 'moto_deportiva', 900, now() - interval '50 days', now() - interval '50 days');
UPDATE public.rides SET cancellation_reason = 'moto_deportiva_fallback' WHERE customer_id = :'RIDER' AND status = 'canceled';
-- Pilot online: two 5-minute slots yesterday (one beat offline, MOTO2's beats not counted).
INSERT INTO public.driver_heartbeat_log (driver_profile_id, beat_at, is_online) VALUES
  (:'PILOT', date_trunc('hour', now() - interval '1 day'), true),
  (:'PILOT', date_trunc('hour', now() - interval '1 day') + interval '2 minutes', true),
  (:'PILOT', date_trunc('hour', now() - interval '1 day') + interval '7 minutes', true),
  (:'PILOT', date_trunc('hour', now() - interval '1 day') + interval '20 minutes', false),
  (:'MOTO2', date_trunc('hour', now() - interval '1 day'), true);
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000001'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r', (SELECT string_agg(k || '=' || (m ->> k), ',' ORDER BY k)
  FROM (SELECT public.admin_moto_deportiva_metrics(30) AS m) x,
       unnest(ARRAY['days','subscribers_now','subscribers_new','notices_sent','people_notified','requests','completed',
                    'canceled','switched_to_moto','revenue_cup','first_ride_people','pilot_hours_online']) k), true) IS NULL;
:AS_ME
-- first_ride_people counts RIDER only if the first completed ride is in the window: RIDER's first
-- completed ride is the 50-day-old Moto Deportiva, so it is 0 in 30 days.
SELECT tst.t('T28a the metrics over 30 days match the rows',
  current_setting('t.r'),
  'canceled=2,completed=2,days=30,first_ride_people=0,notices_sent=1,people_notified=2,pilot_hours_online=0.2,requests=4,revenue_cup=1100,subscribers_new=2,subscribers_now=2,switched_to_moto=1');
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000001'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r', (public.admin_moto_deportiva_metrics(90) ->> 'first_ride_people')
  || ',' || (public.admin_moto_deportiva_metrics(5000) ->> 'days'), true) IS NULL;
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000002';
SELECT 1 WHERE set_config('t.r', current_setting('t.r') || ',' || (public.admin_moto_deportiva_metrics(30) ->> 'error'), true) IS NULL;
:AS_ME
SELECT tst.t('T28b over 90 days RIDER is a first ride; the period is capped at 90; a rider gets forbidden',
  current_setting('t.r'), '1,90,forbidden');
ROLLBACK;

-- ── 11. After review: dispatchable pilots only, raw status, guard messages, push category ──
BEGIN;
:LIST_PILOT :PILOT_ON
UPDATE public.driver_profiles SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = :'PILOT';
:ANON_STATUS
SELECT tst.t('T29a the pilot online but silent for 10 min (dead app): offline', current_setting('t.r'), 'offline');
UPDATE public.driver_profiles SET last_heartbeat_at = now() - interval '30 seconds', is_financially_eligible = false WHERE id = :'PILOT';
:ANON_STATUS
SELECT tst.t('T29b fresh heartbeat but not financially eligible: busy, never available', current_setting('t.r'), 'busy');
UPDATE public.driver_profiles SET is_financially_eligible = true, match_score = 5 WHERE id = :'PILOT';
:ANON_STATUS
SELECT tst.t('T29c fresh heartbeat but match_score 5: busy, never available', current_setting('t.r'), 'busy');
UPDATE public.driver_profiles SET match_score = 50 WHERE id = :'PILOT';
:ANON_STATUS
SELECT tst.t('T29d fresh heartbeat, eligible, match_score 50: available', current_setting('t.r'), 'available');
ROLLBACK;

BEGIN;
:LIST_PILOT
UPDATE public.platform_config SET value = 'false'::jsonb WHERE key = 'moto_deportiva_show_when_unavailable';
:ANON_STATUS
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000001'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r', current_setting('t.r') || ',' || (public.admin_moto_deportiva_overview() ->> 'status'), true) IS NULL;
:AS_ME
SELECT tst.t('T30 hidden from the apps, the panel still sees offline', current_setting('t.r'), 'hidden,offline');
ROLLBACK;

BEGIN;
:LIST_PILOT :PILOT_ON
INSERT INTO public.corporate_accounts (id) VALUES ('5d000000-0000-4000-8000-000000000001');
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000002'; SET LOCAL ROLE authenticated;
DO $$
DECLARE d text; m text; v_out text := '';
BEGIN
  BEGIN
    INSERT INTO public.rides (customer_id, service_type, scheduled_at)
    VALUES ('5a000000-0000-4000-8000-000000000002', 'moto_deportiva', now() + interval '1 day');
    v_out := v_out || 'inserted;';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL, m = MESSAGE_TEXT;
    v_out := v_out || d || ':' || m || ';';
  END;
  BEGIN
    INSERT INTO public.rides (customer_id, service_type, corporate_account_id)
    VALUES ('5a000000-0000-4000-8000-000000000002', 'moto_deportiva', '5d000000-0000-4000-8000-000000000001');
    v_out := v_out || 'inserted;';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL, m = MESSAGE_TEXT;
    v_out := v_out || d || ':' || m || ';';
  END;
  BEGIN
    INSERT INTO public.rides (customer_id, service_type, ride_mode)
    VALUES ('5a000000-0000-4000-8000-000000000002', 'moto_deportiva', 'cargo');
    v_out := v_out || 'inserted;';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL, m = MESSAGE_TEXT;
    v_out := v_out || d || ':' || m || ';';
  END;
  PERFORM set_config('t.r', v_out, true);
END $$;
:AS_ME
SELECT tst.t('T31a while available: scheduled, company and cargo are refused with their own message',
  current_setting('t.r'),
  repeat('moto_deportiva_unavailable:La Moto Deportiva no se puede programar, usar para envíos ni pagar con una cuenta de empresa.;', 3));
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000002'; SET LOCAL ROLE authenticated;
INSERT INTO public.rides (customer_id, service_type) VALUES ('5a000000-0000-4000-8000-000000000002', 'moto_deportiva');
:AS_ME
SELECT tst.t('T31b ...and an immediate one still goes through',
  (SELECT count(*)::text FROM public.rides WHERE customer_id = :'RIDER' AND service_type = 'moto_deportiva'), '1');
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000003'; SET LOCAL ROLE authenticated;
DO $$
DECLARE d text; m text;
BEGIN
  BEGIN
    INSERT INTO public.rides (customer_id, service_type) VALUES ('5a000000-0000-4000-8000-000000000003', 'moto_deportiva');
    d := 'inserted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL, m = MESSAGE_TEXT;
    d := d || ':' || m;
  END;
  PERFORM set_config('t.r', d, true);
END $$;
:AS_ME
SELECT tst.t('T31c a second rider right after (the pilot is about to be busy): the unavailable message',
  current_setting('t.r'), 'moto_deportiva_unavailable:La Moto Deportiva no está disponible en este momento.');
ROLLBACK;

BEGIN;
:LIST_PILOT
:SUBSCRIBE
:PILOT_APP_ON
SELECT tst.t('T32 the notice goes out as category system (opt-in), never promo',
  (SELECT string_agg(body ->> 'category', ',') FROM net.sent WHERE url LIKE '%/send-push')
    || '|' || (SELECT count(*) FROM net.sent WHERE body ->> 'category' = 'promo'),
  'system|0');
ROLLBACK;

BEGIN;
:LIST_PILOT :PILOT_ON :MOTO2_ON
INSERT INTO public.rides (id, customer_id, status, service_type, pickup_location, estimated_fare_cup) VALUES
  ('5e000000-0000-4000-8000-000000000001', :'RIDER', 'searching', 'moto_deportiva', :PICK, 600),
  ('5e000000-0000-4000-8000-000000000002', :'RIDER2', 'searching', 'moto_standard', :PICK, 800);
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000001'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r',
  (SELECT coalesce(string_agg(driver_profile_id::text, ',' ORDER BY driver_profile_id), '-')
     FROM public.admin_ride_assist_candidates('5e000000-0000-4000-8000-000000000001', NULL)) || '|' ||
  (SELECT coalesce(string_agg(driver_profile_id::text, ',' ORDER BY driver_profile_id), '-')
     FROM public.admin_ride_assist_candidates('5e000000-0000-4000-8000-000000000002', NULL)) || '|' ||
  (SELECT coalesce(string_agg(driver_profile_id::text, ',' ORDER BY driver_profile_id), '-')
     FROM public.admin_ride_assist_candidates('5e000000-0000-4000-8000-000000000002', 'moto_deportiva')), true) IS NULL;
:AS_ME
SELECT tst.t('T33 support lists only the pilot for a Moto Deportiva ride, only the other moto for a moto ride',
  current_setting('t.r'), :'PILOT' || '|' || :'MOTO2' || '|' || :'PILOT');
ROLLBACK;

BEGIN;
-- The row exists with the migration; without it, add it so the check is about the patch.
INSERT INTO public.service_type_configs (slug, max_passengers, min_fare_cup, is_active)
VALUES ('moto_deportiva', 1, 553, true) ON CONFLICT (slug) DO NOTHING;
INSERT INTO public.rides (id, customer_id, status, service_type, pickup_location, estimated_fare_cup) VALUES
  ('5e000000-0000-4000-8000-000000000003', :'RIDER', 'searching', 'moto_standard', :PICK, 800),
  ('5e000000-0000-4000-8000-000000000004', :'RIDER2', 'searching', 'moto_deportiva', :PICK, 600);
SELECT tst.t('T34 support never changes a ride into Moto Deportiva; out of it into a moto is fine',
  (SELECT coalesce(public._ride_service_change_error(r, 'moto_deportiva', 900), 'NULL') FROM public.rides r WHERE r.id = '5e000000-0000-4000-8000-000000000003')
    || '|' || (SELECT coalesce(public._ride_service_change_error(r, 'moto_standard', 900), 'NULL') FROM public.rides r WHERE r.id = '5e000000-0000-4000-8000-000000000004')
    || '|' || (SELECT coalesce(public._ride_service_change_error(r, 'mensajeria', 900), 'NULL') FROM public.rides r WHERE r.id = '5e000000-0000-4000-8000-000000000003'),
  'service_type_unavailable|NULL|service_type_unavailable');
ROLLBACK;

BEGIN;
SET LOCAL request.jwt.claim.sub = '5a000000-0000-4000-8000-000000000001'; SET LOCAL ROLE authenticated;
SELECT 1 WHERE set_config('t.r',
  (public.admin_add_moto_deportiva_pilot('+5355510011') ->> 'success') || ',' ||
  (public.admin_add_moto_deportiva_pilot('+5355510011') ->> 'success'), true) IS NULL;
:AS_ME
SELECT tst.t('T35 adding the same pilot twice: both succeed, one pilot row, one admin_actions row',
  current_setting('t.r') || '|' || (SELECT count(*) FROM public.moto_deportiva_pilots)
    || '|' || (SELECT count(*) FROM public.admin_actions WHERE action = 'moto_deportiva_add_pilot'),
  'true,true|1|1');
ROLLBACK;
