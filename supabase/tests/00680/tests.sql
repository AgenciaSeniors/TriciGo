-- Tests of the 00680 rehearsal (the card switch). Same conventions as supabase/tests/00679/tests.sql.

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


\set HIDE   'UPDATE public.platform_config SET value = ''false''::jsonb WHERE key = ''moto_deportiva_card_visible'';'
\set AS_SUPERADMIN 'SET LOCAL request.jwt.claim.sub = ''5a000000-0000-4000-8000-000000000001''; SET LOCAL ROLE authenticated;'
\set AS_RIDER      'SET LOCAL request.jwt.claim.sub = ''5a000000-0000-4000-8000-000000000002''; SET LOCAL ROLE authenticated;'

-- ── Visible (default): nothing changes ────────────────────────
BEGIN;
:LIST_PILOT :PILOT_ON
:ANON_STATUS
SELECT tst.t('V1 visible by default: with the pilot online the card is available', current_setting('t.r'), 'available');
ROLLBACK;

-- ── Hidden ────────────────────────────────────────────────────
BEGIN;
:LIST_PILOT :PILOT_ON :HIDE
:ANON_STATUS
SELECT tst.t('V2 hidden: the card is hidden even with the pilot online', current_setting('t.r'), 'hidden');
ROLLBACK;

BEGIN;
:HIDE
:ANON_STATUS
SELECT tst.t('V3 hidden: hidden with no pilot either', current_setting('t.r'), 'hidden');
ROLLBACK;

BEGIN;
:SUBSCRIBE
:HIDE
:AS_RIDER
SELECT 1 WHERE set_config('t.r', public.get_moto_deportiva_status()::text, true) IS NULL;
:AS_ME
SELECT tst.t('V4 hidden: a subscriber stays subscribed', current_setting('t.r'), '{"status": "hidden", "waiting": true}');
ROLLBACK;

BEGIN;
:LIST_PILOT :PILOT_ON :HIDE
:AS_RIDER
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
SELECT tst.t('V5 hidden: an order is refused even with the pilot available', current_setting('t.r'), 'moto_deportiva_unavailable');
ROLLBACK;

BEGIN;
:LIST_PILOT :SUBSCRIBE :HIDE
:PILOT_APP_ON
SELECT tst.t('V6 hidden: the pilot connects, no push and no notice',
  :MD_PUSHES || '|' || (SELECT count(*) FROM public.moto_deportiva_notices), '0|0');
ROLLBACK;

BEGIN;
:LIST_PILOT :PILOT_ON :HIDE
:AS_SUPERADMIN
SELECT 1 WHERE set_config('t.r', public.admin_moto_deportiva_overview()::text, true) IS NULL;
:AS_ME
SELECT tst.t('V7 the panel sees the real status and that the card is hidden',
  (current_setting('t.r')::jsonb ->> 'status') || '|' || (current_setting('t.r')::jsonb ->> 'visible'), 'available|false');
ROLLBACK;

-- ── The switch ────────────────────────────────────────────────
BEGIN;
:AS_RIDER
SELECT 1 WHERE set_config('t.r', public.admin_set_moto_deportiva_visible(false)::text, true) IS NULL;
:AS_ME
SELECT tst.t('V8 a rider cannot hide the card',
  current_setting('t.r') || '|' || (SELECT value::text FROM public.platform_config WHERE key = 'moto_deportiva_card_visible'),
  '{"error": "forbidden"}|true');
ROLLBACK;

BEGIN;
:AS_SUPERADMIN
SELECT 1 WHERE set_config('t.a', public.admin_set_moto_deportiva_visible(false)::text, true) IS NULL;
:AS_ME
:ANON_STATUS
SELECT tst.t('V9 a super admin hides it: the setting changes and the apps see hidden',
  current_setting('t.a') || '|' || (SELECT value::text FROM public.platform_config WHERE key = 'moto_deportiva_card_visible')
    || '|' || current_setting('t.r'),
  '{"success": true, "visible": false, "notified": 0}|false|hidden');
ROLLBACK;

BEGIN;
:LIST_PILOT :SUBSCRIBE :HIDE :PILOT_ON
:AS_SUPERADMIN
SELECT 1 WHERE set_config('t.r', public.admin_set_moto_deportiva_visible(true)::text, true) IS NULL;
:AS_ME
SELECT tst.t('V10 shown again with the pilot available: the subscribers are told once',
  current_setting('t.r') || '|' || :MD_PUSHES || '|' || (SELECT string_agg(source || ':' || recipients, ',') FROM public.moto_deportiva_notices),
  '{"success": true, "visible": true, "notified": 2}|1|admin_on:2');
ROLLBACK;

BEGIN;
:SUBSCRIBE :HIDE
:AS_SUPERADMIN
SELECT 1 WHERE set_config('t.r', public.admin_set_moto_deportiva_visible(true)::text, true) IS NULL;
:AS_ME
SELECT tst.t('V11 shown again with no pilot: no push',
  current_setting('t.r') || '|' || :MD_PUSHES, '{"success": true, "visible": true, "notified": 0}|0');
ROLLBACK;

BEGIN;
:AS_SUPERADMIN
SELECT 1 WHERE set_config('t.r', public.admin_set_moto_deportiva_visible(true)::text, true) IS NULL;
:AS_ME
SELECT tst.t('V12 showing an already visible card changes nothing',
  current_setting('t.r'), '{"success": true, "visible": true, "notified": 0}');
ROLLBACK;

