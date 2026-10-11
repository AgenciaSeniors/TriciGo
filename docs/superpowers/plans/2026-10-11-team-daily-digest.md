# Team Daily Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every day at 7:00 Havana time, each panel account (super_admin, admin, marketing) gets an e-mail with the previous day's numbers; marketing never sees money or the admins' pending work.

**Architecture:** One migration (`00656`) holds every number in SQL (`team_daily_metrics(day)`), the recipient list, a run log that makes each day send once, an opt-out table, an hourly dispatcher and an overdue watchdog (both pg_cron). A new Edge Function `send-team-digest` renders each person's e-mail from a shared template and sends it through the existing `send-email` (raw-HTML path, so `send-email` needs no redeploy). A second Edge Function `team-digest-unsubscribe` records opt-outs from a signed link; the page with the button lives on tricigo.com, because Supabase rewrites HTML from Edge Functions to text/plain.

**Tech Stack:** Postgres 16 + PostGIS (plpgsql, pg_cron), Deno Edge Functions (TypeScript, supabase-js 2.108.2), vitest (run from `packages/api`), Next.js 14 App Router (web page), the admin settings page.

**Spec:** `docs/superpowers/specs/2026-10-11-team-daily-digest-design.md`. Two deliberate refinements over the spec, recorded in Task 12: the metrics JSON shape is `{day, current, previous, week_ago, breakdowns, pending, lists}`, and "canceled by the rider" counts only rides that had a driver (a rider who gives up while searching is a "no driver" ride), so the outcome lines never double-count.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/00656_team_daily_digest.sql` | Tables, settings, metrics, recipients, run log, dispatch, overdue check, cron jobs, self-checks |
| `supabase/tests/00656/scaffold.sql` | Local Postgres copy of the prod tables and live helper bodies the migration needs |
| `supabase/tests/00656/seed.sql` | Rows with known answers for 2026-10-07 (D), D−1 and D−7 |
| `supabase/tests/00656/run.sh` | Rehearsal: RED without the migration, GREEN with it, negative proofs of its own checks |
| `supabase/functions/_shared/team-digest.ts` | Pure helpers: unsubscribe token and URL, the Havana day, input checks |
| `supabase/functions/_shared/team-digest.test.ts` | Tests for those helpers |
| `supabase/functions/_shared/email-templates/team_daily_digest.ts` | The e-mail (subject + HTML) per role |
| `supabase/functions/_shared/email-templates/team_daily_digest.test.ts` | Template tests |
| `supabase/functions/send-team-digest/index.ts` + `index.test.ts` | The sender and its handler tests |
| `supabase/functions/team-digest-unsubscribe/index.ts` + `index.test.ts` | Opt-out / opt-in endpoint and its handler tests |
| `apps/web/src/app/resumen-diario/baja/page.tsx` + `layout.tsx` | The page behind the footer link |
| `apps/admin/src/app/settings/platform-config/page.tsx` | Two known keys with help text |
| `packages/i18n/src/locales/{es,en,pt}/admin.json` | Help text for those keys |
| `supabase/config.toml`, `packages/api/vitest.config.ts` | Function settings, test discovery |
| `CLAUDE.md` | Operating notes for the digest |

---

### Task 1: Rehearsal scaffold and seed

**Files:**
- Create: `supabase/tests/00656/scaffold.sql`
- Create: `supabase/tests/00656/seed.sql`

- [ ] **Step 1: Confirm the migration number is still free (done by the controller on 2026-10-11: 00655 is taken by #1143, so this plan uses 00656)**

Run:
```bash
cd /home/user/TriciGo && git fetch -q origin master
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3
```
Expected: the newest file is `00654_gate_panel_analytics_rpcs.sql` or older. Then list the migration files of every open PR (GitHub MCP `list_pull_requests` state=open, then `pull_request_read` method `get_files` for each) and confirm none adds `00656_*`. If 00656 is taken, use the next free number everywhere this plan says 00656 (file names, `pr656`, the `00656:` messages).

- [ ] **Step 2: Make sure the local cluster runs and has PostGIS**

Run:
```bash
su pgtest -c "/usr/lib/postgresql/16/bin/pg_ctl -D /home/pgtest/data status" || su pgtest -c "/usr/lib/postgresql/16/bin/pg_ctl -D /home/pgtest/data -o '-p 5433 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp' -l /home/pgtest/pg.log -w start"
ls /usr/lib/postgresql/16/lib/postgis-3.so
```
Expected: `server is running` (or `server started`) and the `.so` path. If PostGIS is missing: `apt-get install -y postgresql-16-postgis-3`.

- [ ] **Step 3: Write `supabase/tests/00656/scaffold.sql`**

```sql
-- Scaffold for the 00656 rehearsal (team daily digest).
-- Prod's tables as of 2026-10-11, reduced to the columns 00656 reads. Every object belongs to a
-- NON-superuser role named postgres, as in prod. PostGIS lives in the extensions schema, as in prod.
-- Live bodies, byte for byte from prod (pg_get_functiondef, 2026-10-11): _poi_admin_area,
-- mailable_user_emails, get_platform_config_text; run.sh S0 compares their md5 with prod.
-- Stubs: pg_cron, cron_http_post (records each call), get_service_role_key (empty when the
-- session setting test.no_key = '1').
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO pgtest;

CREATE SCHEMA extensions;
CREATE EXTENSION postgis SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

CREATE SCHEMA auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

-- pg_cron stub (same as supabase/tests/00649): schedule upserts by name and keeps the active flag.
CREATE SCHEMA cron AUTHORIZATION postgres;
SET ROLE postgres;
CREATE TABLE cron.job (
  jobid    bigserial PRIMARY KEY,
  schedule text NOT NULL,
  command  text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT 5432,
  database text NOT NULL DEFAULT current_database(),
  username text NOT NULL DEFAULT current_user,
  active   boolean NOT NULL DEFAULT true,
  jobname  text,
  CONSTRAINT jobname_username_uniq UNIQUE (jobname, username)
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname, username) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid
$$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE sql AS $$
  WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1) SELECT count(*) > 0 FROM d
$$;
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
  database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void
LANGUAGE sql AS $$
  UPDATE cron.job j
     SET schedule = COALESCE(alter_job.schedule, j.schedule),
         command  = COALESCE(alter_job.command, j.command),
         database = COALESCE(alter_job.database, j.database),
         username = COALESCE(alter_job.username, j.username),
         active   = COALESCE(alter_job.active, j.active)
   WHERE j.jobid = alter_job.job_id
$$;

-- Until 2026-10-30 Supabase grants every new function and table of public to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE auth.identities (
  user_id       uuid NOT NULL,
  provider      text NOT NULL,
  identity_data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');

CREATE TABLE public.users (
  id                uuid PRIMARY KEY,
  email             text,
  full_name         text,
  role              public.user_role NOT NULL DEFAULT 'customer',
  is_active         boolean NOT NULL DEFAULT true,
  is_test           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  signup_code       text,
  email_verified_at timestamptz
);
CREATE TABLE public.driver_profiles (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES public.users (id),
  status      text NOT NULL,
  approved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.rides (
  id              uuid PRIMARY KEY,
  customer_id     uuid NOT NULL,
  driver_id       uuid,
  status          public.ride_status NOT NULL,
  canceled_by     uuid,
  service_type    text NOT NULL,
  pickup_location extensions.geography(Point, 4326),
  final_fare_cup  integer,
  created_at      timestamptz NOT NULL,
  completed_at    timestamptz
);
CREATE TABLE public.ride_offers (id bigserial PRIMARY KEY, ride_id uuid NOT NULL, status text NOT NULL DEFAULT 'expired');
CREATE TABLE public.driver_heartbeat_log (driver_profile_id uuid NOT NULL, beat_at timestamptz NOT NULL, is_online boolean);
CREATE TABLE public.ride_pricing_snapshots (ride_id uuid NOT NULL, snapshot_type text NOT NULL, commission_amount integer NOT NULL DEFAULT 0);
CREATE TABLE public.payment_intents (id bigserial PRIMARY KEY, user_id uuid, amount_cup numeric, status text NOT NULL, paid_at timestamptz);
CREATE TABLE public.service_type_configs (slug text PRIMARY KEY, name_es text NOT NULL);
CREATE TABLE public.cuba_admin_areas (id bigserial PRIMARY KEY, admin_level integer NOT NULL, name_es text, geom extensions.geometry);
CREATE TABLE public.incident_reports (id bigserial PRIMARY KEY, type text NOT NULL, status text NOT NULL);
CREATE TABLE public.ride_disputes (id bigserial PRIMARY KEY, resolved_at timestamptz, sla_resolution_deadline timestamptz);
CREATE TABLE public.acquisition_codes (code text PRIMARY KEY, label text NOT NULL);
CREATE TABLE public.referrals (id bigserial PRIMARY KEY, created_at timestamptz NOT NULL);
CREATE TABLE public.campaigns (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  status     text NOT NULL,
  sent_at    timestamptz,
  push_sent  integer NOT NULL DEFAULT 0,
  email_sent integer NOT NULL DEFAULT 0
);
CREATE TABLE public.promotions (id uuid PRIMARY KEY, code text NOT NULL);
CREATE TABLE public.promotion_uses (id bigserial PRIMARY KEY, promotion_id uuid NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

-- LIVE bodies (prod, 2026-10-11).
CREATE OR REPLACE FUNCTION public._poi_admin_area(p_point geography, OUT municipality text, OUT province text)
 RETURNS record
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT
    (SELECT a.name_es FROM public.cuba_admin_areas a
      WHERE a.admin_level = 6 AND a.geom && (p_point::geometry) AND ST_Contains(a.geom, p_point::geometry) LIMIT 1),
    (SELECT a.name_es FROM public.cuba_admin_areas a
      WHERE a.admin_level = 4 AND a.geom && (p_point::geometry) AND ST_Contains(a.geom, p_point::geometry) LIMIT 1);
$function$;

CREATE OR REPLACE FUNCTION public.mailable_user_emails(p_user_ids uuid[])
 RETURNS TABLE(user_id uuid, email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT u.id, btrim(u.email)
  FROM public.users u
  WHERE u.id = ANY (p_user_ids)
    AND btrim(coalesce(u.email, '')) <> ''
    AND (
      u.email_verified_at IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM auth.identities i
        WHERE i.user_id = u.id
          AND i.provider IN ('google', 'apple')
          AND lower(i.identity_data->>'email_verified') = 'true'
          AND lower(btrim(i.identity_data->>'email')) = lower(btrim(u.email))
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.get_platform_config_text(p_key text, p_fallback text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_raw JSONB;
BEGIN
  SELECT value INTO v_raw FROM platform_config WHERE key = p_key;
  IF v_raw IS NULL THEN
    RETURN p_fallback;
  END IF;
  RETURN COALESCE(v_raw #>> '{}', p_fallback);
END;
$function$;

-- Stubs: the vault key and the cron HTTP helper. cron_http_post records each call.
CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT CASE current_setting('test.no_key', true) WHEN '1' THEN ''::text ELSE 'test-service-key'::text END
$$;
REVOKE ALL ON FUNCTION public.get_service_role_key() FROM PUBLIC, anon, authenticated;

CREATE TABLE public.cron_http_post_calls (
  id bigserial PRIMARY KEY,
  jobname text, url text, headers jsonb, body jsonb, timeout_ms integer
);
CREATE OR REPLACE FUNCTION public.cron_http_post(
  p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 30000
) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO public.cron_http_post_calls (jobname, url, headers, body, timeout_ms)
  VALUES (p_jobname, url, headers, body, timeout_milliseconds) RETURNING id
$$;
REVOKE ALL ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;

RESET ROLE;

-- Test helpers (not production shapes).
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO PUBLIC;
-- t.outcome(sql) -> 'ok: <first column of the first row>' or 'raised <sqlstate>: <message> [<detail>]'
CREATE FUNCTION t.outcome(p_sql text) RETURNS text LANGUAGE plpgsql AS $o$
DECLARE
  v text;
  v_detail text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN 'ok: ' || coalesce(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  RETURN 'raised ' || SQLSTATE || ': ' || SQLERRM || CASE WHEN coalesce(v_detail, '') <> '' THEN ' [' || v_detail || ']' ELSE '' END;
END $o$;
GRANT EXECUTE ON FUNCTION t.outcome(text) TO PUBLIC;
-- t.eq(actual, expected) -> 'ok' or the actual value
CREATE FUNCTION t.eq(a jsonb, b jsonb) RETURNS text LANGUAGE sql AS $e$
  SELECT CASE WHEN a = b THEN 'ok' ELSE coalesce(a::text, '<null>') END
$e$;
```

- [ ] **Step 4: Write `supabase/tests/00656/seed.sql`**

```sql
-- Seed for the 00656 rehearsal. D = 2026-10-07 (Havana, UTC-4 that day), D-1 = 2026-10-06,
-- D-7 = 2026-09-30. Every expected number in run.sh comes from these rows; the comments say which
-- rows count where.
SET ROLE postgres;
CREATE FUNCTION pg_temp.h(text) RETURNS timestamptz LANGUAGE sql AS $$ SELECT ($1::timestamp AT TIME ZONE 'America/Havana') $$;
CREATE FUNCTION pg_temp.pt(lng float8, lat float8) RETURNS extensions.geography LANGUAGE sql AS
  $$ SELECT extensions.ST_SetSRID(extensions.ST_MakePoint(lng, lat), 4326)::extensions.geography $$;

-- People. Staff: A1 admin (Google identity, mixed-case address), S1 super_admin (verified),
-- M1 marketing (Google identity), M2 marketing (no proof: never a recipient), A3 admin (blocked),
-- the platform account (never a recipient). Customers C1-C5, test customer T1, drivers DU1-DU3.
INSERT INTO public.users (id, email, full_name, role, is_active, is_test, created_at, signup_code, email_verified_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'platform@tricigo.system', 'TriciGo Platform', 'super_admin', true, false, '2026-01-01', NULL, '2026-01-01'),
  ('a1000000-0000-4000-8000-000000000001', 'ana@example.com',  'Ana Admin',     'admin',       true,  false, '2026-01-01', NULL, NULL),
  ('a1000000-0000-4000-8000-000000000002', 'sam@example.com',  'Sam Super',     'super_admin', true,  false, '2026-01-01', NULL, '2026-01-01'),
  ('a1000000-0000-4000-8000-000000000003', 'mia@example.com',  'Mia Marketing', 'marketing',   true,  false, '2026-01-01', NULL, NULL),
  ('a1000000-0000-4000-8000-000000000004', 'max@example.com',  'Max Marketing', 'marketing',   true,  false, '2026-01-01', NULL, NULL),
  ('a1000000-0000-4000-8000-000000000006', 'off@example.com',  'Off Admin',     'admin',       false, false, '2026-01-01', NULL, '2026-01-01'),
  ('c1000000-0000-4000-8000-000000000001', 'c1@example.com',   'Cliente Uno',   'customer',    true,  false, '2026-01-01', NULL, '2026-01-01'),
  ('c1000000-0000-4000-8000-000000000002', 'c2@example.com',   'Cliente Dos',   'customer',    true,  false, '2026-01-01', NULL, NULL),
  ('c1000000-0000-4000-8000-000000000003', 'c3@example.com',   'Cliente Tres',  'customer',    true,  false, pg_temp.h('2026-10-06 09:00'), NULL, NULL),
  ('c1000000-0000-4000-8000-000000000004', 'c4@example.com',   'Cliente Cuatro','customer',    true,  false, pg_temp.h('2026-10-07 10:00'), 'BACO1', NULL),
  ('c1000000-0000-4000-8000-000000000005', 'c5@example.com',   'Cliente Cinco', 'customer',    true,  false, pg_temp.h('2026-10-07 11:00'), 'RADIO', NULL),
  ('c1000000-0000-4000-8000-0000000000ff', 't1@example.com',   'Cuenta Prueba', 'customer',    true,  true,  pg_temp.h('2026-10-07 12:00'), 'BACO1', NULL),
  ('d1000000-0000-4000-8000-000000000001', 'du1@example.com',  'Chofer Uno',    'driver',      true,  false, '2026-01-01', NULL, NULL),
  ('d1000000-0000-4000-8000-000000000002', 'du2@example.com',  'Chofer Dos',    'driver',      true,  false, '2026-01-01', NULL, NULL),
  ('d1000000-0000-4000-8000-000000000003', 'du3@example.com',  'Chofer Tres',   'driver',      true,  false, pg_temp.h('2026-10-07 09:30'), NULL, NULL);
INSERT INTO auth.identities (user_id, provider, identity_data) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'google', '{"email": "Ana@Example.com ", "email_verified": true}'),
  ('a1000000-0000-4000-8000-000000000003', 'google', '{"email": "mia@example.com", "email_verified": true}');

-- DP1 approved long ago; DP2 approved on D; DP3 registered on D, under review.
INSERT INTO public.driver_profiles (id, user_id, status, approved_at, created_at) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'approved', '2026-01-02', '2026-01-01'),
  ('e1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'approved', pg_temp.h('2026-10-07 09:00'), '2026-09-01'),
  ('e1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000003', 'under_review', NULL, pg_temp.h('2026-10-07 09:30'));

INSERT INTO public.service_type_configs (slug, name_es) VALUES
  ('triciclo_basico', 'Triciclo'), ('auto_standard', 'Auto'), ('moto_standard', 'Moto'), ('auto_confort', 'Confort');

-- Two municipalities (level 6) with separate boxes. Plaza: (-82.39, 23.13); Centro Habana: (-82.37, 23.15).
INSERT INTO public.cuba_admin_areas (admin_level, name_es, geom) VALUES
  (6, 'Plaza', extensions.ST_Multi(extensions.ST_MakeEnvelope(-82.40, 23.12, -82.38, 23.14, 4326))),
  (6, 'Centro Habana', extensions.ST_Multi(extensions.ST_MakeEnvelope(-82.38, 23.14, -82.36, 23.16, 4326)));

-- Rides. D cohort (created on D, not test): R1 R2 R3 R4 R5 R6 R9. R7 is a test customer's.
-- R8 was requested on D-1 and completed on D. R10 is D-1's, R11 is D-7's, R0 is C1's first ride.
INSERT INTO public.rides (id, customer_id, driver_id, status, canceled_by, service_type, pickup_location, final_fare_cup, created_at, completed_at) VALUES
  ('f0000000-0000-4000-8000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'triciclo_basico', pg_temp.pt(-82.39, 23.13), 100, pg_temp.h('2026-09-20 10:00'), pg_temp.h('2026-09-20 10:30')),
  ('f0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'triciclo_basico', pg_temp.pt(-82.39, 23.13), 1000, pg_temp.h('2026-10-07 08:10'), pg_temp.h('2026-10-07 08:40')),
  ('f0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'auto_standard',   pg_temp.pt(-82.37, 23.15), 2000, pg_temp.h('2026-10-07 13:00'), pg_temp.h('2026-10-07 13:30')),
  ('f0000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000002', 'canceled', 'c1000000-0000-4000-8000-000000000003', 'auto_standard', pg_temp.pt(-82.39, 23.13), NULL, pg_temp.h('2026-10-07 19:00'), NULL),
  ('f0000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'canceled', 'd1000000-0000-4000-8000-000000000002', 'triciclo_basico', pg_temp.pt(-82.39, 23.13), NULL, pg_temp.h('2026-10-07 20:00'), NULL),
  ('f0000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000002', NULL, 'canceled', 'c1000000-0000-4000-8000-000000000002', 'moto_standard', NULL, NULL, pg_temp.h('2026-10-07 02:00'), NULL),
  ('f0000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000003', NULL, 'canceled', NULL, 'moto_standard', pg_temp.pt(-82.37, 23.15), NULL, pg_temp.h('2026-10-07 23:59'), NULL),
  ('f0000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-0000000000ff', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'auto_standard', pg_temp.pt(-82.39, 23.13), 9999, pg_temp.h('2026-10-07 10:00'), pg_temp.h('2026-10-07 10:30')),
  ('f0000000-0000-4000-8000-000000000008', 'c1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'triciclo_basico', pg_temp.pt(-82.39, 23.13), 500, pg_temp.h('2026-10-06 23:59'), pg_temp.h('2026-10-07 00:20')),
  ('f0000000-0000-4000-8000-000000000009', 'c1000000-0000-4000-8000-000000000004', NULL, 'searching', NULL, 'auto_confort', pg_temp.pt(-82.0, 22.0), NULL, pg_temp.h('2026-10-07 00:00'), NULL),
  ('f0000000-0000-4000-8000-000000000010', 'c1000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'auto_standard', pg_temp.pt(-82.37, 23.15), 800, pg_temp.h('2026-10-06 12:00'), pg_temp.h('2026-10-06 12:30')),
  ('f0000000-0000-4000-8000-000000000011', 'c1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'completed', NULL, 'triciclo_basico', pg_temp.pt(-82.39, 23.13), 1200, pg_temp.h('2026-09-30 10:00'), pg_temp.h('2026-09-30 10:40'));

-- R5 (no driver) got an offer that expired; R6 (no driver) got none.
INSERT INTO public.ride_offers (ride_id, status) VALUES ('f0000000-0000-4000-8000-000000000005', 'expired');

-- Final snapshots carry the commission; R1's estimate snapshot must be ignored.
INSERT INTO public.ride_pricing_snapshots (ride_id, snapshot_type, commission_amount) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'final', 150),
  ('f0000000-0000-4000-8000-000000000001', 'estimate', 999),
  ('f0000000-0000-4000-8000-000000000002', 'final', 300),
  ('f0000000-0000-4000-8000-000000000007', 'final', 999),
  ('f0000000-0000-4000-8000-000000000008', 'final', 75),
  ('f0000000-0000-4000-8000-000000000010', 'final', 120),
  ('f0000000-0000-4000-8000-000000000011', 'final', 180);

-- Recharges: 5000 on D counts; the failed one and the test account's do not; 3000 is D-1's.
INSERT INTO public.payment_intents (user_id, amount_cup, status, paid_at) VALUES
  ('c1000000-0000-4000-8000-000000000001', 5000, 'completed', pg_temp.h('2026-10-07 10:00')),
  ('c1000000-0000-4000-8000-000000000002', 4000, 'failed',    pg_temp.h('2026-10-07 11:00')),
  ('c1000000-0000-4000-8000-0000000000ff', 7000, 'completed', pg_temp.h('2026-10-07 12:00')),
  ('c1000000-0000-4000-8000-000000000001', 3000, 'completed', pg_temp.h('2026-10-06 15:00'));

-- Heartbeats on D: DP1 online at 8 h (twice) and 13 h, DP2 at 19 h, DP1 offline at 10 h.
INSERT INTO public.driver_heartbeat_log (driver_profile_id, beat_at, is_online) VALUES
  ('e1000000-0000-4000-8000-000000000001', pg_temp.h('2026-10-07 08:00'), true),
  ('e1000000-0000-4000-8000-000000000001', pg_temp.h('2026-10-07 08:30'), true),
  ('e1000000-0000-4000-8000-000000000001', pg_temp.h('2026-10-07 13:00'), true),
  ('e1000000-0000-4000-8000-000000000002', pg_temp.h('2026-10-07 19:00'), true),
  ('e1000000-0000-4000-8000-000000000001', pg_temp.h('2026-10-07 10:00'), false);

-- Pending now: one open SOS, one incident under investigation, one resolved; two open disputes
-- (one past its deadline) and one resolved.
INSERT INTO public.incident_reports (type, status) VALUES ('sos', 'open'), ('driver_behavior', 'investigating'), ('vehicle_issue', 'resolved');
INSERT INTO public.ride_disputes (resolved_at, sla_resolution_deadline) VALUES
  (NULL, now() - interval '1 day'), (NULL, now() + interval '1 day'), (now() - interval '2 days', now() - interval '3 days');

-- Marketing.
INSERT INTO public.acquisition_codes (code, label) VALUES ('BACO1', 'Baco Instagram'), ('RADIO', 'Radio Taino');
INSERT INTO public.referrals (created_at) VALUES (pg_temp.h('2026-10-07 14:00'));
INSERT INTO public.campaigns (id, name, status, sent_at, push_sent, email_sent) VALUES
  ('ca000000-0000-4000-8000-000000000001', 'Promo sabado', 'sent',   pg_temp.h('2026-10-07 09:00'), 10, 4),
  ('ca000000-0000-4000-8000-000000000003', 'Prueba',       'failed', pg_temp.h('2026-10-07 15:00'), 0, 0),
  ('ca000000-0000-4000-8000-000000000002', 'Aviso',        'sent',   pg_temp.h('2026-10-06 09:00'), 5, 0);
INSERT INTO public.promotions (id, code) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'BIENVENIDA'), ('b0000000-0000-4000-8000-000000000002', 'SUPERFLA');
INSERT INTO public.promotion_uses (promotion_id, created_at) VALUES
  ('b0000000-0000-4000-8000-000000000001', pg_temp.h('2026-10-07 10:00')),
  ('b0000000-0000-4000-8000-000000000001', pg_temp.h('2026-10-07 11:00')),
  ('b0000000-0000-4000-8000-000000000002', pg_temp.h('2026-10-07 12:00'));
RESET ROLE;
```

- [ ] **Step 5: Load both files into a fresh database and check the live bodies**

Run:
```bash
B=/usr/lib/postgresql/16/bin; C="-h 127.0.0.1 -p 5433 -U pgtest"
$B/psql $C -d postgres -qAt -c "DROP DATABASE IF EXISTS pr656" -c "CREATE DATABASE pr656"
$B/psql $C -d pr656 -qAt -v ON_ERROR_STOP=1 -f supabase/tests/00656/scaffold.sql >/dev/null && \
$B/psql $C -d pr656 -qAt -v ON_ERROR_STOP=1 -f supabase/tests/00656/seed.sql >/dev/null && \
$B/psql $C -d pr656 -qAt -c "SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('_poi_admin_area', 'mailable_user_emails', 'get_platform_config_text')"
```
Expected: `_poi_admin_area:f8f7725ad687b5fbea5429d1bcfd23aa,get_platform_config_text:407a7b835c527164a4aa8b3aa8525ba5,mailable_user_emails:58def9245ceb43b710a57ef01c450572`

- [ ] **Step 6: Commit**

```bash
git add supabase/tests/00656/scaffold.sql supabase/tests/00656/seed.sql
git commit -m "test(db): scaffold and seed for the team daily digest rehearsal (00656)"
```
(End every commit message in this plan with the two trailer lines the session requires: `Co-Authored-By: …` and `Claude-Session: …`.)

---

### Task 2: Rehearsal runner (RED)

**Files:**
- Create: `supabase/tests/00656/run.sh`

- [ ] **Step 1: Write `supabase/tests/00656/run.sh`**

```bash
#!/usr/bin/env bash
# Rehearsal runner for migration 00656 (team daily digest; local Postgres 16 + PostGIS).
#   supabase/tests/00656/run.sh none
#       -> scaffold + seed + tests without the migration (RED: none of the objects exist)
#   supabase/tests/00656/run.sh supabase/migrations/00656_team_daily_digest.sql
#       -> scaffold + seed + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00656/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr656
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the printed rows, joined with ';', must equal EXPECTED (\r dropped for Windows)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# txn SQL -> SQL inside a transaction that is always rolled back
txn(){ printf "BEGIN; SET LOCAL client_min_messages = error; %s ROLLBACK;" "$1"; }
# EQ EXPR JSON -> 'ok' when EXPR equals the JSON, else EXPR's value
EQ(){ printf "SELECT t.eq(%s, '%s'::jsonb);" "$1" "$2"; }
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 && \
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

D=2026-10-07
M="public.team_daily_metrics('$D')"
ON="UPDATE public.platform_config SET value = '\"true\"' WHERE key = 'team_digest_enabled';"
FNS="'_team_digest_totals', 'team_daily_metrics', 'team_digest_recipients', 'claim_team_digest', 'finish_team_digest', 'set_team_digest_optout', 'dispatch_team_digest', 'check_team_digest_overdue'"
BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($FNS)"
RECIPIENTS="SELECT coalesce(string_agg(role || ':' || email, ',' ORDER BY role, email), '<none>') FROM public.team_digest_recipients();"
A1=a1000000-0000-4000-8000-000000000001
S1=a1000000-0000-4000-8000-000000000002
ZERO_RIDES='"canceled_by_rider":0,"canceled_by_driver":0,"no_driver":0,"no_driver_with_offer":0,"no_driver_without_offer":0'

echo "== reset database =="
fresh $DB || { echo "scaffold or seed failed"; exit 1; }
val "S0 scaffold carries the live prod bodies" \
  "SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('_poi_admin_area', 'mailable_user_emails', 'get_platform_config_text')" \
  "_poi_admin_area:f8f7725ad687b5fbea5429d1bcfd23aa,get_platform_config_text:407a7b835c527164a4aa8b3aa8525ba5,mailable_user_emails:58def9245ceb43b710a57ef01c450572"
val "S1 like prod, postgres owns the public functions and is not a superuser" \
  "SELECT string_agg(DISTINCT pg_get_userbyid(proowner), ',') || '|' || (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres') FROM pg_proc WHERE pronamespace = 'public'::regnamespace" \
  "postgres|false"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== objects =="
val "O1 the tables have RLS and only service_role can read them" \
  "SELECT string_agg(c.relname || ':' || c.relrowsecurity || ':' || has_table_privilege('anon', c.oid, 'SELECT') || has_table_privilege('authenticated', c.oid, 'SELECT') || has_table_privilege('service_role', c.oid, 'SELECT'), ',' ORDER BY c.relname) FROM pg_class c WHERE c.oid IN (to_regclass('public.team_digest_optouts'), to_regclass('public.team_digest_runs'))" \
  "team_digest_optouts:true:falsefalsetrue,team_digest_runs:true:falsefalsetrue"
val "O2 the settings start off, with no preview" \
  "SELECT coalesce(string_agg(key || '=' || (value #>> '{}'), ',' ORDER BY key), '<none>') FROM public.platform_config WHERE key LIKE 'team_digest_%'" \
  "team_digest_enabled=false,team_digest_preview_to="
val "O3 only service_role executes the functions; all are SECURITY DEFINER" \
  "SELECT string_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE') || ':' || p.prosecdef, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($FNS)" \
  "_team_digest_totals:falsefalsetrue:true,check_team_digest_overdue:falsefalsetrue:true,claim_team_digest:falsefalsetrue:true,dispatch_team_digest:falsefalsetrue:true,finish_team_digest:falsefalsetrue:true,set_team_digest_optout:falsefalsetrue:true,team_daily_metrics:falsefalsetrue:true,team_digest_recipients:falsefalsetrue:true"
val "O4 a signed-in client cannot call the metrics" \
  "$(txn "SET LOCAL ROLE authenticated; SELECT t.outcome('SELECT public.team_daily_metrics(''$D'')::text');")" \
  "raised 42501: permission denied for function team_daily_metrics"
val "O5 the two cron jobs exist and are active" \
  "SELECT coalesce(string_agg(jobname || '|' || schedule || '|' || command || '|' || active, ',' ORDER BY jobname), '<none>') FROM cron.job WHERE jobname IN ('send-team-digest', 'check-team-digest-overdue')" \
  "check-team-digest-overdue|*/15 * * * *|SELECT public.check_team_digest_overdue();|true,send-team-digest|5 * * * *|SELECT public.dispatch_team_digest();|true"

echo "== the numbers =="
val "M1 rides requested on D (test accounts out; no double count)" "$(EQ "$M->'current'->'rides'" "{\"requested\":7,\"completed\":2,\"canceled_by_rider\":1,\"canceled_by_driver\":1,\"no_driver\":2,\"no_driver_with_offer\":1,\"no_driver_without_offer\":1,\"hours_without_coverage\":21}")" "ok"
val "M2 sign-ups and drivers on D" "$(EQ "$M->'current'->'signups'" '{"new_riders":2,"drivers_registered":1,"drivers_approved":1,"drivers_online":2,"drivers_with_ride":1}')" "ok"
val "M3 money on D (final snapshots only; failed and test recharges out)" "$(EQ "$M->'current'->'money'" '{"charged":3500,"commission":525,"recharged":5000}')" "ok"
val "M4 marketing totals on D" "$(EQ "$M->'current'->'marketing'" '{"signups_with_code":2,"referrals":1,"first_rides":1,"campaigns_sent":1,"promotion_uses":3}')" "ok"
val "M5 the day before" "$(EQ "$M->'previous'" "{\"rides\":{\"requested\":2,\"completed\":2,$ZERO_RIDES,\"hours_without_coverage\":24},\"signups\":{\"new_riders\":1,\"drivers_registered\":0,\"drivers_approved\":0,\"drivers_online\":0,\"drivers_with_ride\":1},\"money\":{\"charged\":800,\"commission\":120,\"recharged\":3000},\"marketing\":{\"signups_with_code\":0,\"referrals\":0,\"first_rides\":1,\"campaigns_sent\":1,\"promotion_uses\":0}}")" "ok"
val "M6 the same weekday a week before" "$(EQ "$M->'week_ago'" "{\"rides\":{\"requested\":1,\"completed\":1,$ZERO_RIDES,\"hours_without_coverage\":24},\"signups\":{\"new_riders\":0,\"drivers_registered\":0,\"drivers_approved\":0,\"drivers_online\":0,\"drivers_with_ride\":1},\"money\":{\"charged\":1200,\"commission\":180,\"recharged\":0},\"marketing\":{\"signups_with_code\":0,\"referrals\":0,\"first_rides\":0,\"campaigns_sent\":0,\"promotion_uses\":0}}")" "ok"
val "M7 by pickup municipality (no location or outside every polygon -> null)" "$(EQ "$M->'breakdowns'->'municipalities'" '[{"name":"Plaza","requested":3,"completed":1,"no_driver":0},{"name":"Centro Habana","requested":2,"completed":1,"no_driver":1},{"name":null,"requested":2,"completed":0,"no_driver":1}]')" "ok"
val "M8 by vehicle type" "$(EQ "$M->'breakdowns'->'vehicles'" '[{"slug":"auto_standard","name":"Auto","requested":2,"completed":1,"no_driver":0},{"slug":"moto_standard","name":"Moto","requested":2,"completed":0,"no_driver":2},{"slug":"triciclo_basico","name":"Triciclo","requested":2,"completed":1,"no_driver":0},{"slug":"auto_confort","name":"Confort","requested":1,"completed":0,"no_driver":0}]')" "ok"
val "M9 by time band (00:00 is dawn, 23:59 is night)" "$(EQ "$M->'breakdowns'->'bands'" '[{"band":"dawn","requested":2,"no_driver":1},{"band":"morning","requested":1,"no_driver":0},{"band":"afternoon","requested":1,"no_driver":0},{"band":"night","requested":3,"no_driver":1}]')" "ok"
val "M10 pending now" "$(EQ "$M->'pending'" '{"drivers_under_review":1,"incidents_open":2,"sos_open":1,"disputes_open":2,"disputes_overdue":1}')" "ok"
val "M11 lists (test account's code out; failed campaign listed)" "$(EQ "$M->'lists'" '{"signup_codes":[{"code":"BACO1","label":"Baco Instagram","signups":1},{"code":"RADIO","label":"Radio Taino","signups":1}],"campaigns":[{"name":"Promo sabado","status":"sent","push_sent":10,"email_sent":4},{"name":"Prueba","status":"failed","push_sent":0,"email_sent":0}],"promotions":[{"code":"BIENVENIDA","uses":2},{"code":"SUPERFLA","uses":1}]}')" "ok"
val "M12 the day field" "SELECT $M->>'day';" "$D"
val "M13 a day with nothing" "$(EQ "public.team_daily_metrics('2026-08-01')->'current'->'rides'" "{\"requested\":0,\"completed\":0,$ZERO_RIDES,\"hours_without_coverage\":24}") $(EQ "public.team_daily_metrics('2026-08-01')->'breakdowns'" '{"municipalities":[],"vehicles":[],"bands":[{"band":"dawn","requested":0,"no_driver":0},{"band":"morning","requested":0,"no_driver":0},{"band":"afternoon","requested":0,"no_driver":0},{"band":"night","requested":0,"no_driver":0}]}')" "ok;ok"
val "M14 daylight-saving days have 25 and 23 hours" \
  "SELECT public._team_digest_totals('2026-11-01')->'rides'->>'hours_without_coverage'; SELECT public._team_digest_totals('2027-03-14')->'rides'->>'hours_without_coverage';" "25;23"
val "M15 a missing day is refused" "SELECT t.outcome('SELECT public.team_daily_metrics(NULL)::text');" \
  "raised P0001: team_daily_metrics: p_day is required [team_digest_bad_day]"

echo "== recipients =="
val "R1 panel roles with a proven address; blocked, unproven and platform accounts out" "$RECIPIENTS" \
  "admin:ana@example.com,marketing:mia@example.com,super_admin:sam@example.com"
val "R2 an opt-out removes the person and an opt-in brings them back" \
  "$(txn "SELECT public.set_team_digest_optout('$A1', true); $RECIPIENTS SELECT public.set_team_digest_optout('$A1', false); $RECIPIENTS")" \
  "t;marketing:mia@example.com,super_admin:sam@example.com;t;admin:ana@example.com,marketing:mia@example.com,super_admin:sam@example.com"
val "R3 opting out an account that does not exist answers false" \
  "SELECT public.set_team_digest_optout('00000000-0000-4000-8000-00000000dead', true);" "f"
val "R4 preview mode sends only to that account" \
  "$(txn "UPDATE public.platform_config SET value = to_jsonb('$S1'::text) WHERE key = 'team_digest_preview_to'; $RECIPIENTS")" \
  "super_admin:sam@example.com"
val "R5 a preview value that is no account sends to nobody" \
  "$(txn "UPDATE public.platform_config SET value = '\"nadie\"' WHERE key = 'team_digest_preview_to'; $RECIPIENTS")" "<none>"
val "R6 the recipient's name comes along" \
  "SELECT full_name FROM public.team_digest_recipients() WHERE role = 'admin';" "Ana Admin"

echo "== run log =="
val "C1 a day is claimed once" \
  "$(txn "SELECT public.claim_team_digest('$D'); SELECT public.claim_team_digest('$D'); SELECT status FROM public.team_digest_runs WHERE day = '$D';")" \
  "t;f;sending"
val "C2 a send stuck for 30 minutes becomes failed and is not claimed again" \
  "$(txn "SELECT public.claim_team_digest('$D'); UPDATE public.team_digest_runs SET started_at = now() - interval '31 minutes'; SELECT public.claim_team_digest('2026-10-08'); SELECT day || ':' || status || ':' || coalesce(last_error, '') FROM public.team_digest_runs ORDER BY day; SELECT public.claim_team_digest('$D');")" \
  "t;t;2026-10-07:failed:interrupted;2026-10-08:sending:;f"
val "C3 a partial send is 'sent' with its failures; a second finish does nothing" \
  "$(txn "SELECT public.claim_team_digest('$D'); SELECT public.finish_team_digest('$D', 3, 2, 1, 'x: boom'); SELECT status || ':' || recipients || ':' || sent || ':' || failed || ':' || last_error FROM public.team_digest_runs; SELECT public.finish_team_digest('$D', 3, 3, 0, NULL);")" \
  "t;t;sent:3:2:1:x: boom;f"
val "C4 nothing sent to anyone is 'failed'" \
  "$(txn "SELECT public.claim_team_digest('$D'); SELECT public.finish_team_digest('$D', 2, 0, 2, 'all bad'); SELECT status FROM public.team_digest_runs;")" \
  "t;t;failed"
val "C5 an error before sending is 'failed'; no recipients and no error is 'sent'" \
  "$(txn "SELECT public.claim_team_digest('$D'); SELECT public.finish_team_digest('$D', 0, 0, 0, 'metrics: x'); SELECT public.claim_team_digest('2026-10-08'); SELECT public.finish_team_digest('2026-10-08', 0, 0, 0, NULL); SELECT string_agg(status, ',' ORDER BY day) FROM public.team_digest_runs;")" \
  "t;t;t;t;failed,sent"

echo "== dispatch (p_now: 11:05 UTC = 07:05 Havana in October) =="
CALLS="SELECT coalesce(string_agg(jobname || '|' || url || '|' || body::text || '|' || (headers->>'apikey'), ','), '<none>') FROM public.cron_http_post_calls;"
val "DS1 switched off: nothing" \
  "$(txn "SELECT public.dispatch_team_digest('2026-10-08 11:05+00'); $CALLS")" "disabled;<none>"
val "DS2 on, 06:30 Havana: not yet" \
  "$(txn "$ON SELECT public.dispatch_team_digest('2026-10-08 10:30+00'); $CALLS")" "not_now;<none>"
val "DS3 on, 07:05 Havana: calls send-team-digest for the day before" \
  "$(txn "$ON SELECT public.dispatch_team_digest('2026-10-08 11:05+00'); $CALLS")" \
  "dispatched;send-team-digest|https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-team-digest|{\"day\": \"2026-10-07\"}|test-service-key"
val "DS4 a day that already has a run is not dispatched again" \
  "$(txn "$ON SELECT public.claim_team_digest('$D'); SELECT public.dispatch_team_digest('2026-10-08 11:05+00'); $CALLS")" "t;already;<none>"
val "DS5 09:05 Havana is past the window" \
  "$(txn "$ON SELECT public.dispatch_team_digest('2026-10-08 13:05+00'); $CALLS")" "not_now;<none>"
val "DS6 winter time: 12:05 UTC is 07:05 Havana, 11:05 UTC is 06:05" \
  "$(txn "$ON SELECT public.dispatch_team_digest('2026-12-10 11:05+00'); SELECT public.dispatch_team_digest('2026-12-10 12:05+00'); SELECT body::text FROM public.cron_http_post_calls;")" \
  "not_now;dispatched;{\"day\": \"2026-12-09\"}"
val "DS7 without a service key the run fails, so the cron watchdog sees it" \
  "$(txn "$ON SET LOCAL test.no_key = '1'; SELECT t.outcome('SELECT public.dispatch_team_digest(''2026-10-08 11:05+00'')');")" \
  "raised P0001: dispatch_team_digest: no service role key in the vault, the digest for 2026-10-07 was not sent [team_digest_no_service_key]"
val "DS8 the dispatcher marks a stuck send failed even when switched off" \
  "$(txn "SELECT public.claim_team_digest('2026-10-01'); UPDATE public.team_digest_runs SET started_at = now() - interval '31 minutes'; SELECT public.dispatch_team_digest('2026-10-08 11:05+00'); SELECT status FROM public.team_digest_runs WHERE day = '2026-10-01';")" \
  "t;disabled;failed"

echo "== overdue check =="
val "OV1 switched off: quiet" "SELECT public.check_team_digest_overdue('2026-10-08 13:15+00');" "disabled"
val "OV2 on, 08:30 Havana: not yet" "$(txn "$ON SELECT public.check_team_digest_overdue('2026-10-08 12:30+00');")" "not_yet"
val "OV3 on, 09:15 Havana, nothing sent: fails" \
  "$(txn "$ON SELECT t.outcome('SELECT public.check_team_digest_overdue(''2026-10-08 13:15+00'')');")" \
  "raised P0001: check_team_digest_overdue: the digest for 2026-10-07 is not sent [team_digest_overdue]"
val "OV4 sent: ok" \
  "$(txn "$ON SELECT public.claim_team_digest('$D'); SELECT public.finish_team_digest('$D', 1, 1, 0, NULL); SELECT public.check_team_digest_overdue('2026-10-08 13:15+00');")" "t;t;ok"
val "OV5 failed: fails" \
  "$(txn "$ON SELECT public.claim_team_digest('$D'); SELECT public.finish_team_digest('$D', 1, 0, 1, 'x'); SELECT t.outcome('SELECT public.check_team_digest_overdue(''2026-10-08 13:15+00'')');")" \
  "t;t;raised P0001: check_team_digest_overdue: the digest for 2026-10-07 is failed [team_digest_overdue]"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration's own checks catch a broken result =="
  T=$(mktemp -d)
  sabotage(){ "$PY" - "$MIG" "$T/$1.sql" "$2" "$3" <<'PYEOF'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
assert s.count(old) == 1, f'{old!r} appears {s.count(old)} times'
s2 = s.replace(old, new); assert s2 != s
open(dst, 'w', encoding='utf-8', newline='\n').write(s2)
PYEOF
  }
  # G0: the same file with CRLF line endings (pasted from Windows) produces the same bodies.
  "$PY" - "$MIG" "$T/crlf.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read().replace('\r\n', '\n')
open(sys.argv[2], 'w', encoding='utf-8', newline='\r\n').write(s)
PYEOF
  want=$($P -c "$BODIES" 2>&1 | tr -d '\r')
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/crlf.sql"); b=$($BIN/psql $CONN -d ${DB}g -qAt -c "$BODIES" 2>&1 | tr -d '\r')
  [ "$r" = applied ] && [ "$b" = "$want" ] && ok "G0 with CRLF line endings the migration produces the same bodies" || ko "G0 with CRLF line endings the migration produces the same bodies" "$r / $b"

  sabotage g1 "REVOKE ALL ON FUNCTION public.team_daily_metrics(date) FROM PUBLIC, anon, authenticated;" "-- sabotaged"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g1.sql")
  echo "$r" | grep -q "team_daily_metrics(date) is executable by a client role" && ok "G1 a function a client can execute aborts the migration" || ko "G1 a function a client can execute aborts the migration" "$r"

  sabotage g2 "cron.schedule('send-team-digest', '5 * * * *'" "cron.schedule('send-team-digest', '7 * * * *'"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "a team digest cron job is missing or inactive" && ok "G2 a wrong cron schedule aborts the migration" || ko "G2 a wrong cron schedule aborts the migration" "$r"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -c "SET ROLE postgres; INSERT INTO cron.job (jobname, schedule, command, active) VALUES ('send-team-digest', '5 * * * *', 'SELECT 1;', false);" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG"); a=$($BIN/psql $CONN -d ${DB}g -qAt -c "SELECT command || '|' || active FROM cron.job WHERE jobname = 'send-team-digest'" 2>&1)
  [ "$r" = applied ] && [ "$a" = "SELECT public.dispatch_team_digest();|true" ] && ok "G3 a paused job is switched back on" || ko "G3 a paused job is switched back on" "$r / $a"

  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Make it executable and run it without the migration**

Run: `chmod +x supabase/tests/00656/run.sh && bash supabase/tests/00656/run.sh none`
Expected: `S0` and `S1` pass, every other test fails (the objects do not exist yet), last line `== 2 passed, 42 failed ==` or close (the exact count is printed; what matters is that only S0 and S1 pass). If S0 fails, fix the scaffold before going on.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/00656/run.sh
git commit -m "test(db): RED rehearsal for the team daily digest (00656)"
```

---

### Task 3: Migration — tables, settings, recipients, run log, opt-outs

**Files:**
- Create: `supabase/migrations/00656_team_daily_digest.sql`

- [ ] **Step 1: Create the file with the header, section 1 and section 3**

```sql
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
```

- [ ] **Step 2: Run the rehearsal with the migration**

Run: `bash supabase/tests/00656/run.sh supabase/migrations/00656_team_daily_digest.sql 2>&1 | grep -E "^(PASS|FAIL)  (O1|O2|R|C)"`
Expected: O1, O2, R1–R6 and C1–C5 all `PASS`. (The M, DS, OV, O3–O5 and G tests still fail: their functions come in Tasks 4 and 5.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00656_team_daily_digest.sql
git commit -m "feat(db): team digest run log, opt-outs and recipients (00656)"
```

---

### Task 4: Migration — the numbers

**Files:**
- Modify: `supabase/migrations/00656_team_daily_digest.sql` (insert before the line `-- 3. Recipients, run log and opt-outs ---…`)

- [ ] **Step 1: Insert section 2 immediately before the `-- 3. Recipients…` line**

```sql
-- 2. The numbers ---------------------------------------------------------------------------
-- One Havana calendar day. Test accounts and the platform account never count. Ride outcomes use
-- the rides REQUESTED that day, read now; "canceled by the rider" and "by the driver" only count
-- rides that had a driver, and a ride nobody accepted is "no driver" whoever canceled it, so no
-- ride is counted twice.
CREATE OR REPLACE FUNCTION public._team_digest_totals(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_platform CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_start timestamptz := (p_day::timestamp AT TIME ZONE 'America/Havana');
  v_end   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'America/Havana');
  v_hours integer;
  v_rides jsonb;
  v_signups jsonb;
  v_money jsonb;
  v_marketing jsonb;
  v_online integer;
  v_covered integer;
BEGIN
  -- 23, 24 or 25: the daylight-saving days are shorter or longer.
  v_hours := round(extract(epoch FROM (v_end - v_start)) / 3600)::integer;

  WITH r AS (
    SELECT r.id, r.status, r.driver_id, r.canceled_by, r.customer_id, dp.user_id AS driver_user_id
    FROM public.rides r
    JOIN public.users cu ON cu.id = r.customer_id AND NOT cu.is_test
    LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
    LEFT JOIN public.users du ON du.id = dp.user_id
    WHERE r.created_at >= v_start AND r.created_at < v_end
      AND r.customer_id <> c_platform
      AND NOT coalesce(du.is_test, false)
  )
  SELECT jsonb_build_object(
    'requested', count(*),
    'completed', count(*) FILTER (WHERE r.status = 'completed'),
    'canceled_by_rider', count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NOT NULL
                                            AND r.canceled_by = r.customer_id),
    'canceled_by_driver', count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NOT NULL
                                             AND r.canceled_by = r.driver_user_id),
    'no_driver', count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NULL),
    'no_driver_with_offer', count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NULL
                                               AND EXISTS (SELECT 1 FROM public.ride_offers o WHERE o.ride_id = r.id)),
    'no_driver_without_offer', count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NULL
                                                  AND NOT EXISTS (SELECT 1 FROM public.ride_offers o WHERE o.ride_id = r.id))
  ) INTO v_rides
  FROM r;

  -- Havana's offsets are whole hours, so an hour bucket is the same in UTC and in Havana.
  SELECT count(DISTINCT h.driver_profile_id), count(DISTINCT date_trunc('hour', h.beat_at))
    INTO v_online, v_covered
  FROM public.driver_heartbeat_log h
  JOIN public.driver_profiles dp ON dp.id = h.driver_profile_id
  JOIN public.users u ON u.id = dp.user_id AND NOT u.is_test
  WHERE h.is_online AND h.beat_at >= v_start AND h.beat_at < v_end;
  v_rides := v_rides || jsonb_build_object('hours_without_coverage', v_hours - v_covered);

  SELECT jsonb_build_object(
    'new_riders', (SELECT count(*) FROM public.users u
                   WHERE u.created_at >= v_start AND u.created_at < v_end AND NOT u.is_test AND u.id <> c_platform
                     AND NOT EXISTS (SELECT 1 FROM public.driver_profiles dp WHERE dp.user_id = u.id)),
    'drivers_registered', (SELECT count(*) FROM public.driver_profiles dp
                           JOIN public.users u ON u.id = dp.user_id AND NOT u.is_test
                           WHERE dp.created_at >= v_start AND dp.created_at < v_end),
    'drivers_approved', (SELECT count(*) FROM public.driver_profiles dp
                         JOIN public.users u ON u.id = dp.user_id AND NOT u.is_test
                         WHERE dp.approved_at >= v_start AND dp.approved_at < v_end),
    'drivers_online', v_online,
    'drivers_with_ride', (SELECT count(DISTINCT r.driver_id) FROM public.rides r
                          JOIN public.users cu ON cu.id = r.customer_id AND NOT cu.is_test
                          JOIN public.driver_profiles dp ON dp.id = r.driver_id
                          JOIN public.users du ON du.id = dp.user_id AND NOT du.is_test
                          WHERE r.status = 'completed' AND r.completed_at >= v_start AND r.completed_at < v_end)
  ) INTO v_signups;

  WITH done AS (
    SELECT r.id, r.final_fare_cup
    FROM public.rides r
    JOIN public.users cu ON cu.id = r.customer_id AND NOT cu.is_test
    LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
    LEFT JOIN public.users du ON du.id = dp.user_id
    WHERE r.status = 'completed' AND r.completed_at >= v_start AND r.completed_at < v_end
      AND r.customer_id <> c_platform AND NOT coalesce(du.is_test, false)
  )
  SELECT jsonb_build_object(
    'charged', coalesce((SELECT sum(d.final_fare_cup) FROM done d), 0)::bigint,
    'commission', coalesce((SELECT sum(s.commission_amount) FROM public.ride_pricing_snapshots s
                            JOIN done d ON d.id = s.ride_id WHERE s.snapshot_type = 'final'), 0)::bigint,
    'recharged', coalesce((SELECT sum(pi.amount_cup) FROM public.payment_intents pi
                           LEFT JOIN public.users u ON u.id = pi.user_id
                           WHERE pi.status = 'completed' AND pi.paid_at >= v_start AND pi.paid_at < v_end
                             AND NOT coalesce(u.is_test, false)), 0)::bigint
  ) INTO v_money;

  SELECT jsonb_build_object(
    'signups_with_code', (SELECT count(*) FROM public.users u
                          WHERE u.created_at >= v_start AND u.created_at < v_end AND NOT u.is_test
                            AND u.signup_code IS NOT NULL),
    'referrals', (SELECT count(*) FROM public.referrals rf WHERE rf.created_at >= v_start AND rf.created_at < v_end),
    'first_rides', (SELECT count(DISTINCT r.customer_id) FROM public.rides r
                    JOIN public.users cu ON cu.id = r.customer_id AND NOT cu.is_test
                    WHERE r.status = 'completed' AND r.completed_at >= v_start AND r.completed_at < v_end
                      AND NOT EXISTS (SELECT 1 FROM public.rides p
                                      WHERE p.customer_id = r.customer_id AND p.status = 'completed'
                                        AND p.completed_at < v_start)),
    'campaigns_sent', (SELECT count(*) FROM public.campaigns c
                       WHERE c.status = 'sent' AND c.sent_at >= v_start AND c.sent_at < v_end),
    'promotion_uses', (SELECT count(*) FROM public.promotion_uses pu
                       WHERE pu.created_at >= v_start AND pu.created_at < v_end)
  ) INTO v_marketing;

  RETURN jsonb_build_object('rides', v_rides, 'signups', v_signups, 'money', v_money, 'marketing', v_marketing);
END;
$$;

-- Everything the e-mail shows for day p_day: the totals of the day, the day before and a week
-- before; the breakdowns of the rides requested that day; what is pending now; and the lists.
-- A municipality of null is a ride with no pickup point or outside every polygon.
CREATE OR REPLACE FUNCTION public.team_daily_metrics(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_platform CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_start timestamptz := (p_day::timestamp AT TIME ZONE 'America/Havana');
  v_end   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'America/Havana');
  v_breakdowns jsonb;
  v_pending jsonb;
  v_lists jsonb;
BEGIN
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'team_daily_metrics: p_day is required' USING DETAIL = 'team_digest_bad_day';
  END IF;

  WITH r AS (
    SELECT r.id, r.status, r.driver_id, r.service_type, r.pickup_location,
           extract(hour FROM (r.created_at AT TIME ZONE 'America/Havana'))::integer AS hh
    FROM public.rides r
    JOIN public.users cu ON cu.id = r.customer_id AND NOT cu.is_test
    LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
    LEFT JOIN public.users du ON du.id = dp.user_id
    WHERE r.created_at >= v_start AND r.created_at < v_end
      AND r.customer_id <> c_platform AND NOT coalesce(du.is_test, false)
  ),
  places AS (
    SELECT a.municipality AS name, r.status, r.driver_id
    FROM r LEFT JOIN LATERAL public._poi_admin_area(r.pickup_location) a ON true
  ),
  muni AS (
    SELECT p.name, count(*) AS requested,
           count(*) FILTER (WHERE p.status = 'completed') AS completed,
           count(*) FILTER (WHERE p.status = 'canceled' AND p.driver_id IS NULL) AS no_driver
    FROM places p GROUP BY p.name ORDER BY count(*) DESC, p.name LIMIT 5
  ),
  veh AS (
    SELECT r.service_type AS slug, coalesce(s.name_es, r.service_type) AS name, count(*) AS requested,
           count(*) FILTER (WHERE r.status = 'completed') AS completed,
           count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NULL) AS no_driver
    FROM r LEFT JOIN public.service_type_configs s ON s.slug = r.service_type
    GROUP BY r.service_type, s.name_es
  ),
  bands AS (
    SELECT b.band, b.ord, count(r.id) AS requested,
           count(r.id) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NULL) AS no_driver
    FROM (VALUES ('dawn', 1, 0, 6), ('morning', 2, 6, 12), ('afternoon', 3, 12, 18), ('night', 4, 18, 24))
         AS b(band, ord, h_from, h_to)
    LEFT JOIN r ON r.hh >= b.h_from AND r.hh < b.h_to
    GROUP BY b.band, b.ord
  )
  SELECT jsonb_build_object(
    'municipalities', coalesce((SELECT jsonb_agg(jsonb_build_object('name', m.name, 'requested', m.requested,
                                  'completed', m.completed, 'no_driver', m.no_driver) ORDER BY m.requested DESC, m.name)
                                FROM muni m), '[]'::jsonb),
    'vehicles', coalesce((SELECT jsonb_agg(jsonb_build_object('slug', v.slug, 'name', v.name, 'requested', v.requested,
                            'completed', v.completed, 'no_driver', v.no_driver) ORDER BY v.requested DESC, v.name)
                          FROM veh v), '[]'::jsonb),
    'bands', (SELECT jsonb_agg(jsonb_build_object('band', b.band, 'requested', b.requested, 'no_driver', b.no_driver)
                               ORDER BY b.ord) FROM bands b)
  ) INTO v_breakdowns;

  SELECT jsonb_build_object(
    'drivers_under_review', (SELECT count(*) FROM public.driver_profiles dp
                             JOIN public.users u ON u.id = dp.user_id AND NOT u.is_test
                             WHERE dp.status = 'under_review'),
    'incidents_open', (SELECT count(*) FROM public.incident_reports i WHERE i.status IN ('open', 'investigating')),
    'sos_open', (SELECT count(*) FROM public.incident_reports i
                 WHERE i.status IN ('open', 'investigating') AND i.type = 'sos'),
    'disputes_open', (SELECT count(*) FROM public.ride_disputes d WHERE d.resolved_at IS NULL),
    'disputes_overdue', (SELECT count(*) FROM public.ride_disputes d
                         WHERE d.resolved_at IS NULL AND d.sla_resolution_deadline < now())
  ) INTO v_pending;

  SELECT jsonb_build_object(
    'signup_codes', coalesce((SELECT jsonb_agg(t.x ORDER BY (t.x->>'signups')::integer DESC, t.x->>'code') FROM (
        SELECT jsonb_build_object('code', u.signup_code, 'label', ac.label, 'signups', count(*)) AS x
        FROM public.users u LEFT JOIN public.acquisition_codes ac ON ac.code = u.signup_code
        WHERE u.created_at >= v_start AND u.created_at < v_end AND NOT u.is_test AND u.signup_code IS NOT NULL
        GROUP BY u.signup_code, ac.label
        ORDER BY count(*) DESC, u.signup_code LIMIT 5) t), '[]'::jsonb),
    'campaigns', coalesce((SELECT jsonb_agg(jsonb_build_object('name', c.name, 'status', c.status,
                             'push_sent', c.push_sent, 'email_sent', c.email_sent) ORDER BY c.sent_at, c.id)
                           FROM public.campaigns c
                           WHERE c.sent_at >= v_start AND c.sent_at < v_end AND c.status IN ('sent', 'failed')), '[]'::jsonb),
    'promotions', coalesce((SELECT jsonb_agg(t.x ORDER BY (t.x->>'uses')::integer DESC, t.x->>'code') FROM (
        SELECT jsonb_build_object('code', p.code, 'uses', count(*)) AS x
        FROM public.promotion_uses pu JOIN public.promotions p ON p.id = pu.promotion_id
        WHERE pu.created_at >= v_start AND pu.created_at < v_end
        GROUP BY p.code ORDER BY count(*) DESC, p.code LIMIT 10) t), '[]'::jsonb)
  ) INTO v_lists;

  RETURN jsonb_build_object(
    'day', to_char(p_day, 'YYYY-MM-DD'),
    'current', public._team_digest_totals(p_day),
    'previous', public._team_digest_totals(p_day - 1),
    'week_ago', public._team_digest_totals(p_day - 7),
    'breakdowns', v_breakdowns,
    'pending', v_pending,
    'lists', v_lists);
END;
$$;

REVOKE ALL ON FUNCTION public._team_digest_totals(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._team_digest_totals(date) TO service_role;
REVOKE ALL ON FUNCTION public.team_daily_metrics(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_daily_metrics(date) TO service_role;

```

- [ ] **Step 2: Run the rehearsal**

Run: `bash supabase/tests/00656/run.sh supabase/migrations/00656_team_daily_digest.sql 2>&1 | grep -E "^(PASS|FAIL)  (O1|O2|O4|M|R|C)"`
Expected: every line `PASS`. If an M test fails, the runner prints the actual JSON: compare it with the seed comments to find whether the SQL or the expectation is wrong; never change an expectation without tracing it back to the seed rows.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00656_team_daily_digest.sql
git commit -m "feat(db): team daily digest numbers (00656)"
```

---

### Task 5: Migration — dispatch, overdue check, cron jobs, self-checks (GREEN)

**Files:**
- Modify: `supabase/migrations/00656_team_daily_digest.sql` (insert before the final `RESET lock_timeout;`)

- [ ] **Step 1: Insert section 4 and the closing blocks immediately before the last line `RESET lock_timeout;`**

```sql
-- 4. Dispatch and overdue check ------------------------------------------------------------
-- Hourly at :05. Between 7:00 and 8:59 Havana time, with the switch on and no run for the day
-- before, calls send-team-digest with that day. No EXCEPTION handler: a failure must reach
-- check_cron_sql_failures (00596). p_now exists for the rehearsal; the cron passes nothing.
CREATE OR REPLACE FUNCTION public.dispatch_team_digest(p_now timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_day date := (p_now AT TIME ZONE 'America/Havana')::date - 1;
  v_hour integer := extract(hour FROM (p_now AT TIME ZONE 'America/Havana'))::integer;
  v_key text;
BEGIN
  UPDATE public.team_digest_runs
     SET status = 'failed', finished_at = now(), last_error = coalesce(last_error, 'interrupted')
   WHERE status = 'sending' AND started_at < now() - interval '30 minutes';

  IF coalesce(public.get_platform_config_text('team_digest_enabled', 'false'), 'false') <> 'true' THEN
    RETURN 'disabled';
  END IF;
  IF v_hour < 7 OR v_hour >= 9 THEN
    RETURN 'not_now';
  END IF;
  IF EXISTS (SELECT 1 FROM public.team_digest_runs r WHERE r.day = v_day) THEN
    RETURN 'already';
  END IF;

  v_key := public.get_service_role_key();
  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'dispatch_team_digest: no service role key in the vault, the digest for % was not sent', v_day
      USING DETAIL = 'team_digest_no_service_key';
  END IF;
  PERFORM public.cron_http_post('send-team-digest',
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-team-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key,
      'apikey', v_key),
    body := jsonb_build_object('day', to_char(v_day, 'YYYY-MM-DD')),
    timeout_milliseconds := 30000);
  RETURN 'dispatched';
END;
$$;

-- Every 15 minutes. From 9:00 Havana time, with the switch on, fails while the day before is not
-- 'sent', so check_cron_sql_failures (00596) e-mails the business address. Its own job: a RAISE
-- inside dispatch_team_digest would also roll back its HTTP call. Turning the switch on after
-- 9:00 makes this fail once for that day, since nothing was dispatched.
CREATE OR REPLACE FUNCTION public.check_team_digest_overdue(p_now timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_day date := (p_now AT TIME ZONE 'America/Havana')::date - 1;
  v_hour integer := extract(hour FROM (p_now AT TIME ZONE 'America/Havana'))::integer;
  v_status text;
BEGIN
  IF coalesce(public.get_platform_config_text('team_digest_enabled', 'false'), 'false') <> 'true' THEN
    RETURN 'disabled';
  END IF;
  IF v_hour < 9 THEN
    RETURN 'not_yet';
  END IF;
  SELECT r.status INTO v_status FROM public.team_digest_runs r WHERE r.day = v_day;
  IF v_status IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'check_team_digest_overdue: the digest for % is %', v_day, coalesce(v_status, 'not sent')
      USING DETAIL = 'team_digest_overdue';
  END IF;
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_team_digest(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_team_digest(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.check_team_digest_overdue(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_team_digest_overdue(timestamptz) TO service_role;

-- cron.schedule updates an existing job's schedule and command but keeps its active flag: a job
-- that someone paused is switched back on.
DO $cron$
DECLARE
  v_job bigint;
BEGIN
  v_job := cron.schedule('send-team-digest', '5 * * * *', 'SELECT public.dispatch_team_digest();');
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_job AND NOT active) THEN
    PERFORM cron.alter_job(v_job, active := true);
  END IF;
  v_job := cron.schedule('check-team-digest-overdue', '*/15 * * * *', 'SELECT public.check_team_digest_overdue();');
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_job AND NOT active) THEN
    PERFORM cron.alter_job(v_job, active := true);
  END IF;
END $cron$;

-- 5. Pasted from Windows (CRLF), the bodies would carry \r: recreate them from the catalog without it.
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._team_digest_totals(date)', 'public.team_daily_metrics(date)', 'public.team_digest_recipients()',
    'public.claim_team_digest(date)', 'public.finish_team_digest(date, integer, integer, integer, text)',
    'public.set_team_digest_optout(uuid, boolean)', 'public.dispatch_team_digest(timestamptz)',
    'public.check_team_digest_overdue(timestamptz)']::regprocedure[]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END $crlf$;

-- 6. Self-checks ---------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn regprocedure;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._team_digest_totals(date)', 'public.team_daily_metrics(date)', 'public.team_digest_recipients()',
    'public.claim_team_digest(date)', 'public.finish_team_digest(date, integer, integer, integer, text)',
    'public.set_team_digest_optout(uuid, boolean)', 'public.dispatch_team_digest(timestamptz)',
    'public.check_team_digest_overdue(timestamptz)']::regprocedure[]
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00656: % is executable by a client role', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00656: service_role cannot execute %', v_fn;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
      RAISE EXCEPTION '00656: % must be SECURITY DEFINER', v_fn;
    END IF;
    IF (SELECT position(chr(13) IN p.prosrc) FROM pg_proc p WHERE p.oid = v_fn) > 0 THEN
      RAISE EXCEPTION '00656: % kept a carriage return', v_fn;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.team_digest_runs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.team_digest_runs', 'SELECT')
     OR has_table_privilege('anon', 'public.team_digest_optouts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.team_digest_optouts', 'SELECT') THEN
    RAISE EXCEPTION '00656: a client role can read the digest tables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-team-digest' AND schedule = '5 * * * *'
                   AND command = 'SELECT public.dispatch_team_digest();' AND active)
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-team-digest-overdue' AND schedule = '*/15 * * * *'
                      AND command = 'SELECT public.check_team_digest_overdue();' AND active) THEN
    RAISE EXCEPTION '00656: a team digest cron job is missing or inactive';
  END IF;
  IF (SELECT count(*) FROM public.platform_config WHERE key IN ('team_digest_enabled', 'team_digest_preview_to')) <> 2 THEN
    RAISE EXCEPTION '00656: the team digest settings are missing';
  END IF;
END $check$;

```

- [ ] **Step 2: Run the full rehearsal (GREEN) and the RED baseline again**

Run:
```bash
bash supabase/tests/00656/run.sh none 2>&1 | tail -1
bash supabase/tests/00656/run.sh supabase/migrations/00656_team_daily_digest.sql
```
Expected: the first prints only S0/S1 passing (`== 2 passed, … failed ==`); the second ends `== N passed, 0 failed ==` with G0–G3 among the passes.

- [ ] **Step 3: Run the repo's migration checks**

Run: `pnpm -s check:migration-grants && (cd packages/utils && npx vitest run src/__tests__/copyTuteo.test.ts)`
Expected: `✓ Migrations >= 00587 grant every new public table/view explicitly …` and the tuteo tests passing.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00656_team_daily_digest.sql
git commit -m "feat(db): dispatch and overdue check for the team daily digest (00656)"
```

---

### Task 6: Shared helpers

**Files:**
- Create: `supabase/functions/_shared/team-digest.ts`
- Test: `supabase/functions/_shared/team-digest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  digestSecret,
  havanaYesterday,
  isValidDay,
  unsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from './team-digest.ts';

const USER = 'a1000000-0000-4000-8000-000000000001';

describe('team digest unsubscribe token', () => {
  it('is 64 hex characters and stable for the same secret and user', async () => {
    const a = await unsubscribeToken('secret-1', USER);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await unsubscribeToken('secret-1', USER)).toBe(a);
  });

  it('changes with the secret and with the user', async () => {
    const a = await unsubscribeToken('secret-1', USER);
    expect(await unsubscribeToken('secret-2', USER)).not.toBe(a);
    expect(await unsubscribeToken('secret-1', 'a1000000-0000-4000-8000-000000000002')).not.toBe(a);
  });

  it('verifies only the token made for that user with that secret', async () => {
    const t = await unsubscribeToken('secret-1', USER);
    expect(await verifyUnsubscribeToken('secret-1', USER, t)).toBe(true);
    expect(await verifyUnsubscribeToken('secret-2', USER, t)).toBe(false);
    expect(await verifyUnsubscribeToken('secret-1', 'a1000000-0000-4000-8000-000000000002', t)).toBe(false);
    expect(await verifyUnsubscribeToken('secret-1', USER, t.toUpperCase())).toBe(false);
    expect(await verifyUnsubscribeToken('secret-1', USER, 'abc')).toBe(false);
  });
});

describe('team digest helpers', () => {
  it('builds the link on the web origin, without a double slash', () => {
    expect(unsubscribeUrl('https://tricigo.com/', USER, 'f'.repeat(64)))
      .toBe(`https://tricigo.com/resumen-diario/baja?u=${USER}&t=${'f'.repeat(64)}`);
  });

  it('prefers TEAM_DIGEST_SECRET and falls back to the service key', () => {
    expect(digestSecret((k) => (k === 'TEAM_DIGEST_SECRET' ? 'own' : undefined), 'svc')).toBe('own');
    expect(digestSecret(() => undefined, 'svc')).toBe('svc');
    expect(digestSecret((k) => (k === 'TEAM_DIGEST_SECRET' ? '' : undefined), 'svc')).toBe('svc');
  });

  it('gives the Havana day before, in summer and winter time', () => {
    // 2026-10-08 03:30 UTC is still 2026-10-07 23:30 in Havana (UTC-4).
    expect(havanaYesterday(new Date('2026-10-08T03:30:00Z'))).toBe('2026-10-06');
    expect(havanaYesterday(new Date('2026-10-08T11:05:00Z'))).toBe('2026-10-07');
    // 2026-12-10 04:30 UTC is 2026-12-09 23:30 in Havana (UTC-5).
    expect(havanaYesterday(new Date('2026-12-10T04:30:00Z'))).toBe('2026-12-08');
    expect(havanaYesterday(new Date('2026-03-01T12:00:00Z'))).toBe('2026-02-28');
  });

  it('accepts only real YYYY-MM-DD days', () => {
    expect(isValidDay('2026-10-07')).toBe(true);
    expect(isValidDay('2026-02-30')).toBe(false);
    expect(isValidDay('2026-13-01')).toBe(false);
    expect(isValidDay('7/10/2026')).toBe(false);
    expect(isValidDay('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/api && npx vitest run ../../supabase/functions/_shared/team-digest.test.ts`
Expected: FAIL — `Failed to resolve import "./team-digest.ts"`.

- [ ] **Step 3: Write `supabase/functions/_shared/team-digest.ts`**

```ts
// ============================================================
// Team daily digest (00656) — pure helpers shared by send-team-digest and
// team-digest-unsubscribe: the signed unsubscribe link, the Havana day the digest covers,
// and input checks. No remote imports and no Deno, so packages/api's vitest runs them.
// ============================================================

/** The page on the web app behind "Dejar de recibir este resumen" (Edge Functions cannot serve HTML). */
export const UNSUBSCRIBE_PATH = '/resumen-diario/baja';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

/** HMAC-SHA256 of `team-digest:<user id>`, hex. Only whoever holds the secret can make one. */
export async function unsubscribeToken(secret: string, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`team-digest:${userId}`)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison against the token for that user. */
export async function verifyUnsubscribeToken(secret: string, userId: string, token: string): Promise<boolean> {
  if (!TOKEN_RE.test(token)) return false;
  const expected = await unsubscribeToken(secret, userId);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export function unsubscribeUrl(webOrigin: string, userId: string, token: string): string {
  return `${webOrigin.replace(/\/+$/, '')}${UNSUBSCRIBE_PATH}?u=${encodeURIComponent(userId)}&t=${token}`;
}

/**
 * TEAM_DIGEST_SECRET when set, else the service key. With the fallback, rotating the service key
 * invalidates the links in e-mails already sent; the next day's e-mail carries working ones.
 */
export function digestSecret(env: (name: string) => string | undefined, serviceKey: string): string {
  return env('TEAM_DIGEST_SECRET') || serviceKey;
}

/** The Havana calendar day before `now`, as YYYY-MM-DD. */
export function havanaYesterday(now: Date): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Havana',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
}

/** A real calendar day written as YYYY-MM-DD. */
export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npx vitest run ../../supabase/functions/_shared/team-digest.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/team-digest.ts supabase/functions/_shared/team-digest.test.ts
git commit -m "feat(ef): team digest unsubscribe token and day helpers"
```

---

### Task 7: The e-mail template

**Files:**
- Create: `supabase/functions/_shared/email-templates/team_daily_digest.ts`
- Test: `supabase/functions/_shared/email-templates/team_daily_digest.test.ts`

Note: `wrapHtml` passes the final HTML through `asciiSafeHtml`, which turns every non-ASCII character into a numeric entity (`ó` → `&#243;`). Assertions on the HTML therefore use ASCII-only fragments.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  changeLabel,
  digestDayLabel,
  formatCount,
  teamDailyDigestHtml,
  teamDailyDigestSubject,
  type TeamDigestMetrics,
  type DigestTotals,
} from './team_daily_digest.ts';

const totals = (requested: number, completed: number, charged: number): DigestTotals => ({
  rides: { requested, completed, canceled_by_rider: 1, canceled_by_driver: 1, no_driver: 2,
    no_driver_with_offer: 1, no_driver_without_offer: 1, hours_without_coverage: 21 },
  signups: { new_riders: 2, drivers_registered: 1, drivers_approved: 1, drivers_online: 2, drivers_with_ride: 1 },
  money: { charged, commission: 525, recharged: 5000 },
  marketing: { signups_with_code: 2, referrals: 1, first_rides: 1, campaigns_sent: 1, promotion_uses: 3 },
});

const METRICS: TeamDigestMetrics = {
  day: '2026-10-07',
  current: totals(7, 2, 3500),
  previous: totals(2, 2, 800),
  week_ago: totals(1, 1, 1200),
  breakdowns: {
    municipalities: [
      { name: 'Plaza', requested: 3, completed: 1, no_driver: 0 },
      { name: '<i>Centro</i>', requested: 2, completed: 1, no_driver: 1 },
      { name: null, requested: 2, completed: 0, no_driver: 1 },
    ],
    vehicles: [{ slug: 'auto_standard', name: 'Auto', requested: 2, completed: 1, no_driver: 0 }],
    bands: [
      { band: 'dawn', requested: 2, no_driver: 1 },
      { band: 'morning', requested: 1, no_driver: 0 },
      { band: 'afternoon', requested: 1, no_driver: 0 },
      { band: 'night', requested: 3, no_driver: 1 },
    ],
  },
  pending: { drivers_under_review: 1, incidents_open: 2, sos_open: 1, disputes_open: 2, disputes_overdue: 1 },
  lists: {
    signup_codes: [{ code: 'BACO1', label: 'Baco Instagram', signups: 1 }],
    campaigns: [{ name: 'Promo <b>x</b>', status: 'sent', push_sent: 10, email_sent: 4 }],
    promotions: [{ code: 'BIENVENIDA', uses: 2 }],
  },
};

const base = {
  name: 'Ana',
  metrics: METRICS,
  panel_url: 'https://admin.tricigo.com',
  unsubscribe_url: 'https://tricigo.com/resumen-diario/baja?u=a1&t=ff',
};

describe('team daily digest template', () => {
  it('admins see the money and the pending work', () => {
    const html = teamDailyDigestHtml({ ...base, role: 'admin' });
    expect(html).toContain('Cobrado en viajes');
    expect(html).toContain('3,500 CUP');
    expect(html).toContain('525 CUP');
    expect(html).toContain('Pendiente ahora');
  });

  it('super admins see the money too', () => {
    expect(teamDailyDigestHtml({ ...base, role: 'super_admin' })).toContain('Cobrado en viajes');
  });

  it('marketing sees every ride number and breakdown but no money and no pending work', () => {
    const html = teamDailyDigestHtml({ ...base, role: 'marketing' });
    expect(html).toContain('Pedidos');
    expect(html).toContain('Sin conductor');
    expect(html).toContain('Horas sin conductores en l');
    expect(html).toContain('Municipio de recogida');
    expect(html).toContain('Tipo de veh');
    expect(html).toContain('Franja horaria');
    expect(html).not.toContain('Cobrado en viajes');
    expect(html).not.toContain('CUP');
    expect(html).not.toContain('Pendiente ahora');
  });

  it('an unknown role gets the marketing version', () => {
    const html = teamDailyDigestHtml({ ...base, role: 'customer' });
    expect(html).not.toContain('CUP');
    expect(html).not.toContain('Pendiente ahora');
  });

  it('escapes text people write (campaign names, municipality names, codes)', () => {
    const html = teamDailyDigestHtml({ ...base, role: 'admin' });
    expect(html).toContain('Promo &lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('Promo <b>x</b>');
    expect(html).toContain('&lt;i&gt;Centro&lt;/i&gt;');
  });

  it('a ride with no known municipality shows as "Sin ubicacion"', () => {
    expect(teamDailyDigestHtml({ ...base, role: 'marketing' })).toContain('Sin ubicaci');
  });

  it('carries the unsubscribe link, escaped', () => {
    expect(teamDailyDigestHtml({ ...base, role: 'marketing' }))
      .toContain('href="https://tricigo.com/resumen-diario/baja?u=a1&amp;t=ff"');
  });

  it('greets by name, or without one', () => {
    expect(teamDailyDigestHtml({ ...base, role: 'admin' })).toContain('Hola, Ana:');
    expect(teamDailyDigestHtml({ ...base, name: '', role: 'admin' })).toContain('Hola:');
  });

  it('says so when there were no ride requests', () => {
    const empty = { ...METRICS, current: totals(0, 0, 0) };
    expect(teamDailyDigestHtml({ ...base, metrics: empty, role: 'marketing' })).toContain('No hubo pedidos.');
  });

  it('subject and day label in Spanish', () => {
    expect(teamDailyDigestSubject('2026-10-10')).toBe('TriciGo · resumen del sábado 10 de octubre');
    expect(digestDayLabel('2026-10-07')).toBe('miércoles 7 de octubre');
  });

  it('formats counts and changes', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(0)).toBe('0');
    expect(changeLabel(7, 5)).toBe('▲ 40 %');
    expect(changeLabel(2, 4)).toBe('▼ 50 %');
    expect(changeLabel(5, 5)).toBe('= 0 %');
    expect(changeLabel(3, 0)).toBe('—');
    expect(changeLabel(0, 0)).toBe('—');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/api && npx vitest run ../../supabase/functions/_shared/email-templates/team_daily_digest.test.ts`
Expected: FAIL — `Failed to resolve import "./team_daily_digest.ts"`.

- [ ] **Step 3: Write `supabase/functions/_shared/email-templates/team_daily_digest.ts`**

```ts
// ============================================================
// TriciGo — Team daily digest e-mail (00656)
//
// The 7:00 Havana e-mail to every panel account with the previous day's numbers
// (docs/superpowers/specs/2026-10-11-team-daily-digest-design.md). metrics is what
// team_daily_metrics(day) returns. Marketing never gets the Money and Pending blocks; any role
// other than super_admin and admin gets the marketing version.
//
// Not in the template registry on purpose: send-team-digest renders it and hands send-email the
// HTML (its raw-HTML path, which the database alerts also use), so adding this e-mail needed no
// redeploy of send-email.
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml } from './_layout.ts';

export interface DigestRides {
  requested: number;
  completed: number;
  canceled_by_rider: number;
  canceled_by_driver: number;
  no_driver: number;
  no_driver_with_offer: number;
  no_driver_without_offer: number;
  hours_without_coverage: number;
}
export interface DigestSignups {
  new_riders: number;
  drivers_registered: number;
  drivers_approved: number;
  drivers_online: number;
  drivers_with_ride: number;
}
export interface DigestMoney {
  charged: number;
  commission: number;
  recharged: number;
}
export interface DigestMarketing {
  signups_with_code: number;
  referrals: number;
  first_rides: number;
  campaigns_sent: number;
  promotion_uses: number;
}
export interface DigestTotals {
  rides: DigestRides;
  signups: DigestSignups;
  money: DigestMoney;
  marketing: DigestMarketing;
}
export interface DigestBreakdowns {
  municipalities: Array<{ name: string | null; requested: number; completed: number; no_driver: number }>;
  vehicles: Array<{ slug: string; name: string; requested: number; completed: number; no_driver: number }>;
  bands: Array<{ band: string; requested: number; no_driver: number }>;
}
export interface DigestPending {
  drivers_under_review: number;
  incidents_open: number;
  sos_open: number;
  disputes_open: number;
  disputes_overdue: number;
}
export interface DigestLists {
  signup_codes: Array<{ code: string; label: string | null; signups: number }>;
  campaigns: Array<{ name: string; status: string; push_sent: number; email_sent: number }>;
  promotions: Array<{ code: string; uses: number }>;
}
export interface TeamDigestMetrics {
  day: string;
  current: DigestTotals;
  previous: DigestTotals;
  week_ago: DigestTotals;
  breakdowns: DigestBreakdowns;
  pending: DigestPending;
  lists: DigestLists;
}
export interface TeamDailyDigestData {
  role: string;
  name: string;
  metrics: TeamDigestMetrics;
  panel_url: string;
  unsubscribe_url: string;
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre',
  'octubre', 'noviembre', 'diciembre'];
const BAND_LABELS: Record<string, string> = {
  dawn: 'Madrugada (0 a 6 h)',
  morning: 'Mañana (6 a 12 h)',
  afternoon: 'Tarde (12 a 18 h)',
  night: 'Noche (18 a 24 h)',
};
const CAMPAIGN_STATUS: Record<string, string> = { sent: 'Enviada', failed: 'Falló' };

/** '2026-10-07' -> 'miércoles 7 de octubre'. The day is a calendar date: no time zone involved. */
export function digestDayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${d} de ${MONTHS[m - 1]}`;
}

export function teamDailyDigestSubject(day: string): string {
  return `TriciGo · resumen del ${digestDayLabel(day)}`;
}

/** Whole number with thousands separated by commas (as formatCUP shows them). */
export function formatCount(n: number): string {
  return Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatCup(n: number): string {
  return `${formatCount(n)} CUP`;
}

export function percentOf(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)} %` : '—';
}

/** Change against a base day: '▲ 40 %', '▼ 50 %', '= 0 %', or '—' when the base is 0. */
export function changeLabel(current: number, base: number): string {
  if (!base) return '—';
  const diff = Math.round(((current - base) / base) * 100);
  if (diff === 0) return '= 0 %';
  return `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)} %`;
}

export function seesMoney(role: string): boolean {
  return role === 'super_admin' || role === 'admin';
}

const TH = `padding: 6px 8px; font-family: ${FONT_STACK}; font-size: 12px; font-weight: 600; color: ${COLORS.muted}; border-bottom: 1px solid ${COLORS.border};`;
const TD = `padding: 6px 8px; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; border-bottom: 1px solid ${COLORS.border};`;
const SPACER = '<div style="height: 12px; line-height: 12px;">&nbsp;</div>';

function heading(title: string): string {
  return `<h2 style="margin: 28px 0 8px; font-family: ${FONT_STACK}; font-size: 17px; color: ${COLORS.ink};">${escapeHtml(title)}</h2>`;
}

function note(text: string): string {
  return `<p style="margin: 8px 0 0; font-family: ${FONT_STACK}; font-size: 13px; color: ${COLORS.muted};">${escapeHtml(text)}</p>`;
}

/** Every cell is escaped. Columns from numericFrom on are right-aligned. */
function table(headers: string[], rows: string[][], numericFrom = 1): string {
  const align = (i: number) => (i >= numericFrom ? ' text-align: right; white-space: nowrap;' : ' text-align: left;');
  const head = headers.map((h, i) => `<th style="${TH}${align(i)}">${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c, i) => `<td style="${TD}${align(i)}">${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse: collapse;"><tr>${head}</tr>${body}</table>`;
}

type Pick = (t: DigestTotals) => number;

function totalsTable(m: TeamDigestMetrics, rows: Array<[string, Pick, ((n: number) => string)?]>): string {
  return table(
    ['', 'Día', 'vs. día anterior', 'vs. hace 7 días'],
    rows.map(([label, pick, fmt = formatCount]) => [
      label,
      fmt(pick(m.current)),
      changeLabel(pick(m.current), pick(m.previous)),
      changeLabel(pick(m.current), pick(m.week_ago)),
    ]),
  );
}

export function teamDailyDigestHtml(d: TeamDailyDigestData): string {
  const m = d.metrics;
  const c = m.current;
  const day = digestDayLabel(m.day);
  const parts: string[] = [];

  parts.push(`<p style="margin: 0 0 12px;">${d.name ? `Hola, ${escapeHtml(d.name)}:` : 'Hola:'}</p>`);
  parts.push(
    `<p style="margin: 0 0 4px;">Estos son los números del ${escapeHtml(day)}, en hora de Cuba. ` +
      'Cada total se compara con el día anterior y con el mismo día de la semana pasada.</p>',
  );

  parts.push(heading('Viajes'));
  parts.push(totalsTable(m, [
    ['Pedidos', (t) => t.rides.requested],
    ['Completados', (t) => t.rides.completed],
    ['Cancelados por el pasajero', (t) => t.rides.canceled_by_rider],
    ['Cancelados por el conductor', (t) => t.rides.canceled_by_driver],
    ['Sin conductor', (t) => t.rides.no_driver],
    ['Sin conductor, con alguna oferta', (t) => t.rides.no_driver_with_offer],
    ['Sin conductor, sin ninguna oferta', (t) => t.rides.no_driver_without_offer],
    ['Horas sin conductores en línea', (t) => t.rides.hours_without_coverage],
  ]));
  if (c.rides.requested === 0) {
    parts.push(note('No hubo pedidos.'));
  } else {
    parts.push(note(
      `Se completó el ${percentOf(c.rides.completed, c.rides.requested)} de los pedidos ` +
        `(día anterior: ${percentOf(m.previous.rides.completed, m.previous.rides.requested)}; ` +
        `hace 7 días: ${percentOf(m.week_ago.rides.completed, m.week_ago.rides.requested)}).`,
    ));
  }

  parts.push(heading('Altas y conductores'));
  parts.push(totalsTable(m, [
    ['Pasajeros nuevos', (t) => t.signups.new_riders],
    ['Conductores registrados', (t) => t.signups.drivers_registered],
    ['Conductores aprobados', (t) => t.signups.drivers_approved],
    ['Conductores en línea', (t) => t.signups.drivers_online],
    ['Conductores con al menos un viaje', (t) => t.signups.drivers_with_ride],
  ]));

  parts.push(heading('Dónde y cuándo se pidió'));
  if (c.rides.requested === 0) {
    parts.push(note('No hubo pedidos.'));
  } else {
    parts.push(table(
      ['Municipio de recogida', 'Pedidos', 'Completados', 'Sin conductor'],
      m.breakdowns.municipalities.map((r) => [
        r.name ?? 'Sin ubicación', formatCount(r.requested), formatCount(r.completed), formatCount(r.no_driver),
      ]),
    ));
    parts.push(SPACER);
    parts.push(table(
      ['Tipo de vehículo', 'Pedidos', 'Completados', 'Sin conductor'],
      m.breakdowns.vehicles.map((r) => [r.name, formatCount(r.requested), formatCount(r.completed), formatCount(r.no_driver)]),
    ));
    parts.push(SPACER);
    parts.push(table(
      ['Franja horaria', 'Pedidos', 'Sin conductor'],
      m.breakdowns.bands.map((b) => [BAND_LABELS[b.band] ?? b.band, formatCount(b.requested), formatCount(b.no_driver)]),
    ));
  }

  parts.push(heading('Marketing'));
  parts.push(totalsTable(m, [
    ['Altas con código', (t) => t.marketing.signups_with_code],
    ['Referidos', (t) => t.marketing.referrals],
    ['Primeros viajes', (t) => t.marketing.first_rides],
    ['Campañas enviadas', (t) => t.marketing.campaigns_sent],
    ['Usos de promociones', (t) => t.marketing.promotion_uses],
  ]));
  if (m.lists.signup_codes.length > 0) {
    parts.push(SPACER);
    parts.push(table(
      ['Código', 'Nombre', 'Altas'],
      m.lists.signup_codes.map((s) => [s.code, s.label ?? '—', formatCount(s.signups)]),
      2,
    ));
  }
  if (m.lists.campaigns.length > 0) {
    parts.push(SPACER);
    parts.push(table(
      ['Campaña', 'Estado', 'Push', 'Correo'],
      m.lists.campaigns.map((x) => [x.name, CAMPAIGN_STATUS[x.status] ?? x.status, formatCount(x.push_sent), formatCount(x.email_sent)]),
      2,
    ));
  }
  if (m.lists.promotions.length > 0) {
    parts.push(SPACER);
    parts.push(table(['Promoción', 'Usos'], m.lists.promotions.map((p) => [p.code, formatCount(p.uses)])));
  }

  if (seesMoney(d.role)) {
    parts.push(heading('Dinero'));
    parts.push(totalsTable(m, [
      ['Cobrado en viajes', (t) => t.money.charged, formatCup],
      ['Comisión de la plataforma', (t) => t.money.commission, formatCup],
      ['Saldo recargado', (t) => t.money.recharged, formatCup],
    ]));

    const p = m.pending;
    parts.push(heading('Pendiente ahora'));
    parts.push(table(['', 'Cantidad'], [
      ['Conductores esperando aprobación', formatCount(p.drivers_under_review)],
      ['Incidentes abiertos', `${formatCount(p.incidents_open)} (SOS: ${formatCount(p.sos_open)})`],
      ['Disputas abiertas', `${formatCount(p.disputes_open)} (fuera de plazo: ${formatCount(p.disputes_overdue)})`],
    ]));
  }

  parts.push(
    `<p style="margin: 28px 0 0; font-family: ${FONT_STACK}; font-size: 12px; color: ${COLORS.muted};">` +
      'Recibes este resumen porque tienes un rol en el panel de TriciGo. ' +
      `<a href="${escapeHtml(d.unsubscribe_url)}" style="color: ${COLORS.muted};">Dejar de recibir este resumen</a></p>`,
  );

  return wrapHtml({
    preheader: `${formatCount(c.rides.requested)} pedidos y ${formatCount(c.rides.completed)} completados el ${day}.`,
    hero: { title: 'Resumen del día', subtitle: day.charAt(0).toUpperCase() + day.slice(1) },
    body: parts.join('\n'),
    cta: { label: 'Abrir el panel', href: d.panel_url },
    footerNote: 'Sale todos los días a las 7:00, hora de Cuba.',
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npx vitest run ../../supabase/functions/_shared/email-templates/team_daily_digest.test.ts`
Expected: PASS, 11 tests. If the `3,500 CUP` assertion fails, check `formatCount`; if a text assertion fails, the fragment probably contains a non-ASCII character that `asciiSafeHtml` turned into an entity — shorten the fragment, do not change the copy.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/email-templates/team_daily_digest.ts supabase/functions/_shared/email-templates/team_daily_digest.test.ts
git commit -m "feat(ef): team daily digest e-mail template"
```

---

### Task 8: The `send-team-digest` Edge Function

**Files:**
- Create: `supabase/functions/send-team-digest/index.ts`
- Test: `supabase/functions/send-team-digest/index.test.ts`
- Modify: `packages/api/vitest.config.ts` (include list)
- Modify: `supabase/config.toml` (function settings)

- [ ] **Step 1: Add the test folder to vitest and the function to config.toml**

In `packages/api/vitest.config.ts`, after the line `'../../supabase/functions/send-campaign/*.test.ts',` add:
```ts
      // send-team-digest and team-digest-unsubscribe (00656): supabase-js, fetch and the rate
      // limiter are mocked, Deno is stubbed.
      '../../supabase/functions/send-team-digest/*.test.ts',
      '../../supabase/functions/team-digest-unsubscribe/*.test.ts',
```
In `supabase/config.toml`, right after the two lines
```toml
[functions.send-campaign]
verify_jwt = true
```
add:
```toml
[functions.send-team-digest]
verify_jwt = true
[functions.team-digest-unsubscribe]
verify_jwt = false
```

- [ ] **Step 2: Write the failing test `supabase/functions/send-team-digest/index.test.ts`**

```ts
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { havanaYesterday, verifyUnsubscribeToken } from '../_shared/team-digest.ts';

// Runs the real send-team-digest handler. supabase-js (esm.sh) is replaced with a fake client
// whose rpc answers come from `db`; fetch (the calls to send-email) is stubbed.

const db = vi.hoisted(() => ({
  claim: true as unknown,
  claimError: null as null | { message: string },
  metrics: null as unknown,
  metricsError: null as null | { message: string },
  recipients: [] as Array<{ user_id: string; role: string; email: string; full_name: string }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> | undefined }>,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    rpc: (fn: string, args?: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      if (fn === 'claim_team_digest') {
        return Promise.resolve(db.claimError ? { data: null, error: db.claimError } : { data: db.claim, error: null });
      }
      if (fn === 'team_daily_metrics') {
        return Promise.resolve(db.metricsError ? { data: null, error: db.metricsError } : { data: db.metrics, error: null });
      }
      if (fn === 'team_digest_recipients') return Promise.resolve({ data: db.recipients, error: null });
      if (fn === 'finish_team_digest') return Promise.resolve({ data: true, error: null });
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    },
  }),
}));

const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
};

let handler: (req: Request) => Promise<Response>;
let emailStatus: (to: string) => number = () => 200;
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(init?.body as string) as { recipient_email: string };
  const status = emailStatus(body.recipient_email);
  return new Response(JSON.stringify(status === 200 ? { success: true } : { error: 'send_failed' }), { status });
});

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => env[k] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', fetchMock);
  await import('./index.ts');
});

const ADMIN = 'a1000000-0000-4000-8000-000000000001';
const MKT = 'a1000000-0000-4000-8000-000000000003';

const zeroTotals = {
  rides: { requested: 7, completed: 2, canceled_by_rider: 1, canceled_by_driver: 1, no_driver: 2,
    no_driver_with_offer: 1, no_driver_without_offer: 1, hours_without_coverage: 21 },
  signups: { new_riders: 2, drivers_registered: 1, drivers_approved: 1, drivers_online: 2, drivers_with_ride: 1 },
  money: { charged: 3500, commission: 525, recharged: 5000 },
  marketing: { signups_with_code: 2, referrals: 1, first_rides: 1, campaigns_sent: 1, promotion_uses: 3 },
};
const METRICS = {
  day: '2026-10-07', current: zeroTotals, previous: zeroTotals, week_ago: zeroTotals,
  breakdowns: { municipalities: [], vehicles: [], bands: [] },
  pending: { drivers_under_review: 1, incidents_open: 2, sos_open: 1, disputes_open: 2, disputes_overdue: 1 },
  lists: { signup_codes: [], campaigns: [], promotions: [] },
};

beforeEach(() => {
  fetchMock.mockClear();
  emailStatus = () => 200;
  db.claim = true;
  db.claimError = null;
  db.metrics = METRICS;
  db.metricsError = null;
  db.recipients = [
    { user_id: ADMIN, role: 'admin', email: 'ana@example.com', full_name: 'Ana Admin' },
    { user_id: MKT, role: 'marketing', email: 'mia@example.com', full_name: 'Mia' },
  ];
  db.rpcCalls = [];
});

const call = (body: unknown, internal = true) =>
  handler(new Request('https://example.supabase.co/functions/v1/send-team-digest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(internal ? { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  }));

const sentBodies = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string) as {
    template: string; subject: string; recipient_email: string; data: Record<string, unknown>;
  });
const finishArgs = () => db.rpcCalls.find((c) => c.fn === 'finish_team_digest')?.args;

describe('send-team-digest', () => {
  it('401 without the service key', async () => {
    const res = await call({ day: '2026-10-07' }, false);
    expect(res.status).toBe(401);
    expect(db.rpcCalls).toEqual([]);
  });

  it('400 for a day that is not YYYY-MM-DD', async () => {
    expect((await call({ day: '2026-02-30' })).status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it('claims the day, sends each person their version through send-email, and records the outcome', async () => {
    const res = await call({ day: '2026-10-07' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, day: '2026-10-07' });

    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['claim_team_digest', 'team_daily_metrics', 'team_digest_recipients', 'finish_team_digest']);
    expect(db.rpcCalls[0].args).toEqual({ p_day: '2026-10-07' });
    expect(fetchMock.mock.calls.every(([u]) => u === 'https://example.supabase.co/functions/v1/send-email')).toBe(true);

    const [admin, mkt] = sentBodies();
    expect(admin.recipient_email).toBe('ana@example.com');
    expect(admin.subject).toBe('TriciGo · resumen del miércoles 7 de octubre');
    expect(admin.data).toEqual({});
    expect(admin.template).toContain('Cobrado en viajes');
    expect(mkt.recipient_email).toBe('mia@example.com');
    expect(mkt.template).not.toContain('CUP');
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 2, p_sent: 2, p_failed: 0, p_error: null });
  });

  it('puts a signed unsubscribe link for that person in each e-mail', async () => {
    await call({ day: '2026-10-07' });
    const html = sentBodies()[0].template;
    const m = html.match(/https:\/\/tricigo\.com\/resumen-diario\/baja\?u=([0-9a-f-]+)&amp;t=([0-9a-f]{64})/);
    expect(m?.[1]).toBe(ADMIN);
    expect(await verifyUnsubscribeToken(SERVICE_KEY, ADMIN, m![2])).toBe(true);
  });

  it('a lost claim sends nothing and records nothing', async () => {
    db.claim = false;
    expect((await call({ day: '2026-10-07' })).status).toBe(202);
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['claim_team_digest']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a claim error sends nothing', async () => {
    db.claimError = { message: 'connection reset' };
    await call({ day: '2026-10-07' });
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['claim_team_digest']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('one failed address does not stop the others', async () => {
    emailStatus = (to) => (to === 'ana@example.com' ? 500 : 200);
    await call({ day: '2026-10-07' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 2, p_sent: 1, p_failed: 1, p_error: `${ADMIN}: send_failed` });
  });

  it('a metrics error sends nothing and records the error', async () => {
    db.metricsError = { message: 'boom' };
    await call({ day: '2026-10-07' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 0, p_sent: 0, p_failed: 0, p_error: 'metrics: boom' });
  });

  it('without a day, sends the Havana day before', async () => {
    await call({});
    expect(db.rpcCalls[0].args).toEqual({ p_day: havanaYesterday(new Date()) });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/api && npx vitest run ../../supabase/functions/send-team-digest/index.test.ts`
Expected: FAIL — `Failed to resolve import "./index.ts"`.

- [ ] **Step 4: Write `supabase/functions/send-team-digest/index.ts`**

```ts
// ============================================================
// supabase/functions/send-team-digest/index.ts
//
// The team daily digest sender (00656). The cron job send-team-digest runs dispatch_team_digest()
// every hour; at 7–8 Havana time, with team_digest_enabled on and the day not sent yet, it calls
// this function with the service key and { day: 'YYYY-MM-DD' }. This function answers 202 at once
// and, in the background (EdgeRuntime.waitUntil):
//   1. claims the day (claim_team_digest: one winner; a lost claim sends nothing),
//   2. reads the numbers (team_daily_metrics) and the recipients (team_digest_recipients),
//   3. renders each person's version (marketing without money) and sends it through send-email,
//      one at a time, as raw HTML; one failed address does not stop the rest,
//   4. records the outcome (finish_team_digest). A run that dies before this stays 'sending' and
//      becomes 'failed' 30 minutes later; check_team_digest_overdue alerts after 9:00.
// ============================================================
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { getServiceKey, isServiceKeyToken } from '../_shared/service-key.ts';
import { WEB_ORIGIN } from '../_shared/brand.ts';
import { digestSecret, havanaYesterday, isValidDay, unsubscribeToken, unsubscribeUrl } from '../_shared/team-digest.ts';
import {
  teamDailyDigestHtml,
  teamDailyDigestSubject,
  type TeamDigestMetrics,
} from '../_shared/email-templates/team_daily_digest.ts';

const PANEL_URL = 'https://admin.tricigo.com';

// Supabase's background-task API; absent in tests.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

interface Recipient {
  user_id: string;
  role: string;
  email: string;
  full_name: string;
}

/** null when send-email accepted it, else the reason. Never throws. */
async function sendOne(url: string, serviceKey: string, to: string, subject: string, html: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/functions/v1/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ template: html, data: {}, recipient_email: to, subject }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function runDigest(client: SupabaseClient, url: string, serviceKey: string, day: string): Promise<void> {
  const claim = await client.rpc('claim_team_digest', { p_day: day });
  if (claim.error) {
    console.error(`[send-team-digest] ${day}: claim failed`, claim.error.message);
    return;
  }
  if (claim.data !== true) {
    console.info(`[send-team-digest] ${day}: already claimed, nothing to do`);
    return;
  }

  let recipients: Recipient[] = [];
  let sent = 0;
  let failed = 0;
  let error: string | null = null;
  try {
    const metrics = await client.rpc('team_daily_metrics', { p_day: day });
    if (metrics.error) throw new Error(`metrics: ${metrics.error.message}`);
    const data = metrics.data as TeamDigestMetrics | null;
    if (!data?.current) throw new Error('metrics: unexpected shape');
    const list = await client.rpc('team_digest_recipients');
    if (list.error) throw new Error(`recipients: ${list.error.message}`);
    recipients = (list.data ?? []) as Recipient[];

    const secret = digestSecret((name) => Deno.env.get(name), serviceKey);
    const subject = teamDailyDigestSubject(day);
    for (const r of recipients) {
      const token = await unsubscribeToken(secret, r.user_id);
      const html = teamDailyDigestHtml({
        role: r.role,
        name: r.full_name,
        metrics: data,
        panel_url: PANEL_URL,
        unsubscribe_url: unsubscribeUrl(WEB_ORIGIN, r.user_id, token),
      });
      const failure = await sendOne(url, serviceKey, r.email, subject, html);
      if (failure) {
        failed += 1;
        error = `${r.user_id}: ${failure}`.slice(0, 500);
      } else {
        sent += 1;
      }
    }
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }

  const finish = await client.rpc('finish_team_digest', {
    p_day: day,
    p_recipients: recipients.length,
    p_sent: sent,
    p_failed: failed,
    p_error: error,
  });
  if (finish.error) console.error(`[send-team-digest] ${day}: could not record the result`, finish.error.message);
  console.info(
    `[send-team-digest] ${day}: recipients=${recipients.length} sent=${sent} failed=${failed}` + (error ? ` error=${error}` : ''),
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!isServiceKeyToken(req.headers.get('apikey') ?? '') && !isServiceKeyToken(bearer)) {
    return json(401, { error: 'Forbidden: service key required' });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { day?: unknown };
    const day = typeof body.day === 'string' ? body.day : havanaYesterday(new Date());
    if (!isValidDay(day)) return json(400, { error: 'day must be a real YYYY-MM-DD date' });

    const serviceKey = getServiceKey();
    const url = Deno.env.get('SUPABASE_URL')!;
    const client = createClient(url, serviceKey);
    const work = runDigest(client, url, serviceKey, day).catch((err) => {
      console.error(`[send-team-digest] ${day}: unexpected error`, err);
    });
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(work);
    else await work;
    return json(202, { accepted: true, day });
  } catch (err) {
    console.error('[send-team-digest]', err);
    return json(500, { error: 'internal' });
  }
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/api && npx vitest run ../../supabase/functions/send-team-digest/index.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/send-team-digest packages/api/vitest.config.ts supabase/config.toml
git commit -m "feat(ef): send-team-digest sends the daily digest per role"
```

---

### Task 9: The `team-digest-unsubscribe` Edge Function

**Files:**
- Create: `supabase/functions/team-digest-unsubscribe/index.ts`
- Test: `supabase/functions/team-digest-unsubscribe/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { unsubscribeToken } from '../_shared/team-digest.ts';

// Runs the real handler. supabase-js and the DB-backed rate limiter are replaced; Deno is stubbed.
const db = vi.hoisted(() => ({
  result: true as unknown,
  error: null as null | { message: string },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> | undefined }>,
}));
vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    rpc: (fn: string, args?: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      return Promise.resolve(db.error ? { data: null, error: db.error } : { data: db.result, error: null });
    },
  }),
}));
const limiter = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  rateLimitResponse: vi.fn((ms: number) => new Response(JSON.stringify({ error: 'Too many requests.' }), {
    status: 429, headers: { 'Retry-After': String(Math.ceil(ms / 1000)) },
  })),
}));
vi.mock('../_shared/rate-limiter.ts', () => limiter);

const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
  ALLOWED_ORIGINS: 'https://tricigo.com',
};
let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => env[k] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  });
  await import('./index.ts');
});

const USER = 'a1000000-0000-4000-8000-000000000001';
let TOKEN = '';

beforeEach(async () => {
  TOKEN = await unsubscribeToken(SERVICE_KEY, USER);
  db.result = true;
  db.error = null;
  db.rpcCalls = [];
  limiter.rateLimit.mockReset();
  limiter.rateLimit.mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
});

const post = (body: unknown) =>
  handler(new Request('https://example.supabase.co/functions/v1/team-digest-unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tricigo.com' },
    body: JSON.stringify(body),
  }));

describe('team-digest-unsubscribe', () => {
  it('answers the browser preflight for tricigo.com', async () => {
    const res = await handler(new Request('https://example.supabase.co/functions/v1/team-digest-unsubscribe', {
      method: 'OPTIONS', headers: { Origin: 'https://tricigo.com' },
    }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://tricigo.com');
  });

  it('refuses GET: a link scanner must never opt anyone out', async () => {
    const res = await handler(new Request(`https://example.supabase.co/functions/v1/team-digest-unsubscribe?u=${USER}&t=${TOKEN}`));
    expect(res.status).toBe(405);
    expect(db.rpcCalls).toEqual([]);
  });

  it('opts the person out with a valid link', async () => {
    const res = await post({ u: USER, t: TOKEN, action: 'out' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, subscribed: false });
    expect(db.rpcCalls).toEqual([{ fn: 'set_team_digest_optout', args: { p_user: USER, p_out: true } }]);
  });

  it('brings the person back', async () => {
    const res = await post({ u: USER, t: TOKEN, action: 'in' });
    expect(await res.json()).toEqual({ ok: true, subscribed: true });
    expect(db.rpcCalls[0].args).toEqual({ p_user: USER, p_out: false });
  });

  it('403 for a token made for someone else', async () => {
    const other = await unsubscribeToken(SERVICE_KEY, 'a1000000-0000-4000-8000-000000000002');
    expect((await post({ u: USER, t: other, action: 'out' })).status).toBe(403);
    expect(db.rpcCalls).toEqual([]);
  });

  it('400 for malformed input', async () => {
    expect((await post({ u: 'x', t: TOKEN, action: 'out' })).status).toBe(400);
    expect((await post({ u: USER, t: 'abc', action: 'out' })).status).toBe(400);
    expect((await post({ u: USER, t: TOKEN, action: 'delete' })).status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it('404 when the account no longer exists', async () => {
    db.result = false;
    expect((await post({ u: USER, t: TOKEN, action: 'out' })).status).toBe(404);
  });

  it('429 once the address bucket is full', async () => {
    limiter.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 60_000 });
    expect((await post({ u: USER, t: TOKEN, action: 'out' })).status).toBe(429);
    expect(db.rpcCalls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/api && npx vitest run ../../supabase/functions/team-digest-unsubscribe/index.test.ts`
Expected: FAIL — `Failed to resolve import "./index.ts"`.

- [ ] **Step 3: Write `supabase/functions/team-digest-unsubscribe/index.ts`**

```ts
// ============================================================
// supabase/functions/team-digest-unsubscribe/index.ts
//
// Opt-out and opt-in for the team daily digest (00656). The e-mail's footer links to
// tricigo.com/resumen-diario/baja?u=<account>&t=<token>; that page POSTs here
// { u, t, action: 'out' | 'in' } when the person taps the button. Only POST changes anything:
// mail scanners and link previews follow links with GET. The token is
// HMAC-SHA256(TEAM_DIGEST_SECRET or the service key, 'team-digest:' + account id), so a link only
// works for its own account. verify_jwt is off: the person may not be signed in.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { getServiceKey } from '../_shared/service-key.ts';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { digestSecret, UUID_RE, verifyUnsubscribeToken } from '../_shared/team-digest.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`team-digest-unsub:${ip}`, 20, 60 * 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs, cors);

    const body = (await req.json().catch(() => ({}))) as { u?: unknown; t?: unknown; action?: unknown };
    const u = typeof body.u === 'string' ? body.u : '';
    const t = typeof body.t === 'string' ? body.t : '';
    const action = body.action;
    if (!UUID_RE.test(u) || !/^[0-9a-f]{64}$/.test(t) || (action !== 'out' && action !== 'in')) {
      return json(400, { error: 'bad_request' });
    }

    const serviceKey = getServiceKey();
    const secret = digestSecret((name) => Deno.env.get(name), serviceKey);
    if (!(await verifyUnsubscribeToken(secret, u, t))) return json(403, { error: 'bad_link' });

    const client = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);
    const { data, error } = await client.rpc('set_team_digest_optout', { p_user: u, p_out: action === 'out' });
    if (error) {
      console.error('[team-digest-unsubscribe]', error.message);
      return json(500, { error: 'internal' });
    }
    if (data !== true) return json(404, { error: 'not_found' });
    return json(200, { ok: true, subscribed: action === 'in' });
  } catch (err) {
    console.error('[team-digest-unsubscribe]', err);
    return json(500, { error: 'internal' });
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npx vitest run ../../supabase/functions/team-digest-unsubscribe/index.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/team-digest-unsubscribe
git commit -m "feat(ef): team-digest-unsubscribe records opt-outs from a signed link"
```

---

### Task 10: The unsubscribe page on tricigo.com

**Files:**
- Create: `apps/web/src/app/resumen-diario/baja/layout.tsx`
- Create: `apps/web/src/app/resumen-diario/baja/page.tsx`

- [ ] **Step 1: Write `layout.tsx` (metadata; the page is a client component)**

```tsx
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Resumen diario · TriciGo',
  robots: { index: false, follow: false },
};

export default function TeamDigestUnsubscribeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
```

- [ ] **Step 2: Write `page.tsx`**

```tsx
'use client';

// Page behind "Dejar de recibir este resumen" in the team daily digest (00656). The link
// carries u (account id) and t (its signed token). Nothing happens on load: mail scanners and
// link previews open links by themselves, so the opt-out waits for the button. The
// team-digest-unsubscribe Edge Function checks the token and records the choice.

import { useEffect, useState } from 'react';
import { getSupabaseClient } from '@tricigo/api';

type Status = 'loading' | 'ready' | 'working' | 'out' | 'in' | 'error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/;

const buttonStyle: React.CSSProperties = {
  marginTop: 20,
  padding: '12px 24px',
  border: 'none',
  borderRadius: 8,
  background: 'var(--primary, #f97316)',
  color: '#fff',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};

export default function TeamDigestUnsubscribePage() {
  const [status, setStatus] = useState<Status>('loading');
  const [link, setLink] = useState<{ u: string; t: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const u = params.get('u') ?? '';
    const t = params.get('t') ?? '';
    if (UUID_RE.test(u) && TOKEN_RE.test(t)) {
      setLink({ u, t });
      setStatus('ready');
    } else {
      setStatus('error');
    }
  }, []);

  async function submit(action: 'out' | 'in') {
    if (!link) return;
    setStatus('working');
    try {
      const { data, error } = await getSupabaseClient().functions.invoke('team-digest-unsubscribe', {
        body: { ...link, action },
      });
      setStatus(error || data?.ok !== true ? 'error' : action);
    } catch {
      setStatus('error');
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--bg, #0a0a0a)',
        color: 'var(--text, #f5f5f5)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        {(status === 'loading' || status === 'working') && (
          <h1 style={{ fontSize: 22, marginBottom: 8 }}>Un momento…</h1>
        )}
        {status === 'ready' && (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Resumen diario de TriciGo</h1>
            <p style={{ opacity: 0.8, lineHeight: 1.5 }}>
              ¿Quieres dejar de recibir por correo el resumen de cada mañana?
            </p>
            <button type="button" style={buttonStyle} onClick={() => submit('out')}>
              Dejar de recibir este resumen
            </button>
          </>
        )}
        {status === 'out' && (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Listo</h1>
            <p style={{ opacity: 0.8, lineHeight: 1.5 }}>Ya no vas a recibir el resumen diario.</p>
            <button type="button" style={buttonStyle} onClick={() => submit('in')}>
              Volver a recibirlo
            </button>
          </>
        )}
        {status === 'in' && (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Listo</h1>
            <p style={{ opacity: 0.8, lineHeight: 1.5 }}>
              Vas a volver a recibir el resumen todos los días a las 7:00, hora de Cuba.
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>No pudimos procesar el enlace</h1>
            <p style={{ opacity: 0.8, lineHeight: 1.5 }}>
              El enlace está incompleto o no es válido. Ábrelo de nuevo desde el último correo del resumen, o
              escríbenos a soporte@tricigo.com.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck the web app and run the tuteo guard**

Run: `pnpm check-types && (cd packages/utils && npx vitest run src/__tests__/copyTuteo.test.ts)`
Expected: all tasks successful; tuteo tests pass (the page's copy uses tuteo: "Quieres", "vas a", "Ábrelo", "escríbenos").

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/resumen-diario
git commit -m "feat(web): page to stop or resume the team daily digest"
```

---

### Task 11: Settings in the admin panel

**Files:**
- Modify: `apps/admin/src/app/settings/platform-config/page.tsx` (the `KNOWN_KEYS` object)
- Modify: `packages/i18n/src/locales/es/admin.json`, `en/admin.json`, `pt/admin.json` (`platform_config` object)

- [ ] **Step 1: Add the two keys to `KNOWN_KEYS`**

Right after the line that defines `support_alert_email` in `KNOWN_KEYS`, add:
```ts
  // ── Resumen diario del equipo (00656) ──
  team_digest_enabled: { type: 'select', helpKey: 'platform_config.team_digest_enabled_help', options: [{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }] },
  team_digest_preview_to: { type: 'text', helpKey: 'platform_config.team_digest_preview_to_help' },
```

- [ ] **Step 2: Add the help texts**

In each `admin.json`, inside the `platform_config` object, right after the `"support_alert_email_help"` line (add a comma to the previous line as JSON requires):

es:
```json
    "team_digest_enabled_help": "Prende o apaga el resumen diario por correo que reciben a las 7:00 (hora de Cuba) las cuentas con rol en el panel. Conviene prenderlo antes de las 7:00: si se prende más tarde, ese día llega un aviso de resumen atrasado.",
    "team_digest_preview_to_help": "Id de una cuenta del panel. Mientras tenga un valor, el resumen le llega solo a esa cuenta (sirve para probarlo). Vacío = a todo el equipo."
```
en:
```json
    "team_digest_enabled_help": "Turns on or off the daily e-mail summary that panel accounts receive at 7:00 (Havana time). Turn it on before 7:00: turned on later, that day brings one overdue-summary alert.",
    "team_digest_preview_to_help": "The id of one panel account. While it has a value, only that account gets the summary (useful for testing). Empty = the whole team."
```
pt:
```json
    "team_digest_enabled_help": "Liga ou desliga o resumo diário por e-mail que as contas com papel no painel recebem às 7:00 (horário de Cuba). Ligue antes das 7:00: ligado mais tarde, nesse dia chega um alerta de resumo atrasado.",
    "team_digest_preview_to_help": "Id de uma conta do painel. Enquanto tiver um valor, o resumo chega só a essa conta (serve para testar). Vazio = toda a equipe."
```

- [ ] **Step 3: Validate JSON, types and lint**

Run:
```bash
for l in es en pt; do node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/$l/admin.json','utf8'))" && echo "$l ok"; done
pnpm check-types && pnpm --filter @tricigo/admin lint 2>&1 | tail -3
(cd packages/utils && npx vitest run src/__tests__/copyTuteo.test.ts)
```
Expected: `es ok`, `en ok`, `pt ok`; check-types successful; lint shows 0 errors and the same warning count as `master`; tuteo tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/app/settings/platform-config/page.tsx packages/i18n/src/locales/*/admin.json
git commit -m "feat(admin): settings for the team daily digest"
```

---

### Task 12: Docs, full verification, push

**Files:**
- Modify: `docs/superpowers/specs/2026-10-11-team-daily-digest-design.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Record the two refinements in the spec**

In the spec's Rides table, replace the two rows
`| Canceled by the rider | ... |` and `| Canceled by the driver | ... |` with:
```markdown
| Canceled by the rider | `status = 'canceled'`, a driver was assigned, `canceled_by = customer_id` |
| Canceled by the driver | `status = 'canceled'`, a driver was assigned, `canceled_by` = that driver's user |
```
and under "No driver" add the sentence: `A ride nobody accepted is "no driver" whoever canceled it, so no ride is counted twice.`
In the Database section, replace the `team_daily_metrics` return shape with
`{day, current, previous, week_ago, breakdowns, pending, lists}` (`current`/`previous`/`week_ago` each `{rides, signups, money, marketing}`).
In the Email template section, replace "registered in `index.ts`" with: `not in the registry: send-team-digest renders it and sends the HTML through send-email's raw-HTML path, so send-email needs no redeploy.`
In the Edge Functions section, replace the unsubscribe paragraph's GET/POST description with: `The footer link opens tricigo.com/resumen-diario/baja (Supabase serves Edge Function HTML as text/plain); that page shows the button and POSTs { u, t, action } to team-digest-unsubscribe. Only POST changes anything.`
Change `team_digest_optouts` to mention the `opted_out` flag (coming back is an update, not a delete).

- [ ] **Step 2: Add the operating notes to `CLAUDE.md`**

Insert right after the "### Campañas: las manda el servidor, a la hora elegida (00649, PR #1129)" section (before the next `###`):
```markdown
### Resumen diario del equipo (00656)

A las 7:00 de Cuba, cada cuenta con rol de panel (super_admin, admin, marketing) recibe un correo con los números del día anterior: viajes, altas, desgloses por municipio, vehículo y franja, marketing, y, solo para super_admin y admin, dinero y pendientes. Diseño: `docs/superpowers/specs/2026-10-11-team-daily-digest-design.md`. Ensayo: `supabase/tests/00656/run.sh`.

- **Cómo sale:** el job `send-team-digest` corre `dispatch_team_digest()` a los :05 de cada hora. Entre las 7:00 y las 8:59 de Cuba, con `team_digest_enabled` = `true` y sin fila del día en `team_digest_runs`, llama a la función de borde `send-team-digest`, que toma el día (`claim_team_digest`, una sola vez), calcula los números (`team_daily_metrics`), arma la versión de cada persona y la manda por `send-email` como HTML. El resultado queda en `team_digest_runs` (`sent`, `failed`, `last_error`).
- **Nunca se reenvía solo:** un envío que se cae a mitad queda `sending` y a los 30 minutos pasa a `failed`. Desde las 9:00, `check_team_digest_overdue` (cada 15 min) falla mientras el día no esté `sent`, y lo reporta `check_cron_sql_failures`. Para reenviar a mano: borrar la fila del día en `team_digest_runs` y llamar a `send-team-digest` con la clave de servicio y `{"day":"YYYY-MM-DD"}`.
- **Prenderlo antes de las 7:00:** si se prende después de las 9:00, ese día no se despachó y el vigilante avisa una vez.
- **Quién lo recibe:** `team_digest_recipients()`: rol de panel, cuenta activa, dirección probada (regla 00635) y sin baja. `team_digest_preview_to` = id de una cuenta → solo esa cuenta.
- **La baja** es un enlace firmado a `tricigo.com/resumen-diario/baja` (las funciones de borde no pueden servir HTML). La página pide un toque y llama a `team-digest-unsubscribe`, que solo acepta POST: los antivirus del correo abren los enlaces solos. Volver es otro botón en la misma página. La firma usa `TEAM_DIGEST_SECRET` si existe y, si no, la clave de servicio; rotar la clave de servicio invalida los enlaces de correos ya enviados.
- **Diagnóstico:**
  ```sql
  SELECT * FROM team_digest_runs ORDER BY day DESC LIMIT 7;
  SELECT c.called_at, r.status_code FROM cron_http_calls c LEFT JOIN net._http_response r ON r.id = c.request_id
  WHERE c.jobname = 'send-team-digest' ORDER BY c.called_at DESC LIMIT 5;
  ```
```

- [ ] **Step 3: Full verification**

Run:
```bash
bash supabase/tests/00656/run.sh none 2>&1 | tail -1
bash supabase/tests/00656/run.sh supabase/migrations/00656_team_daily_digest.sql 2>&1 | tail -1
(cd packages/api && npx vitest run 2>&1 | tail -4)
pnpm check-types 2>&1 | tail -3
pnpm --filter @tricigo/admin lint 2>&1 | tail -2
pnpm --filter @tricigo/web lint 2>&1 | tail -2
pnpm -s check:migration-grants
(cd packages/utils && npx vitest run 2>&1 | tail -3)
```
Expected: RED shows only S0/S1 passing; GREEN `0 failed`; api vitest all passing (the count grows by the 36 new tests); check-types successful; lint 0 errors (same warnings as master); grants check ✓; utils tests passing.

- [ ] **Step 4: Re-read the diff adversarially**

Run: `git diff origin/master...HEAD --stat` and read every file. Check: no model identifier anywhere; no credentials; migration number still free (repeat Task 1 Step 1); the copy is tuteo; the marketing version can never include money (template test + `seesMoney`); every new SQL function has its REVOKE/GRANT pair.

- [ ] **Step 5: Commit and push**

```bash
git add docs/superpowers/specs/2026-10-11-team-daily-digest-design.md CLAUDE.md
git commit -m "docs: team daily digest operating notes"
git push -u origin claude/hopeful-shannon-g3theu
```
Then update the body of PR #1142 (GitHub MCP `update_pull_request`) with what was built, the rehearsal and test counts, and the rollout plan of Task 13, ending with the session's PR footer lines.

---

### Task 13: Rollout (each step needs the owner's explicit OK)

No step here runs without an AskUserQuestion answer for that step.

- [ ] **Step 1: Merge PR #1142** once CI is green (squash). The merge deploys the web page, which the unsubscribe links point to.

- [ ] **Step 2: Deploy the two Edge Functions** with the Supabase MCP `deploy_edge_function`:
  - `send-team-digest`, `verify_jwt: true`, files: `index.ts`, `../_shared/service-key.ts`, `../_shared/brand.ts`, `../_shared/team-digest.ts`, `../_shared/email-templates/team_daily_digest.ts`, `../_shared/email-templates/_layout.ts`.
  - `team-digest-unsubscribe`, `verify_jwt: false`, files: `index.ts`, `../_shared/service-key.ts`, `../_shared/rate-limiter.ts`, `../_shared/team-digest.ts`.
  Verify with `get_edge_function` that the deployed files match the repo.

- [ ] **Step 3: Rehearse 00656 in prod inside a rolled-back block.** One `execute_sql` with `DO $probe$ … v_mig := $mig655$<file>$mig655$; IF md5(v_mig) <> '<md5 of the file>' THEN RAISE …; EXECUTE v_mig; <checks>; RAISE EXCEPTION 'PROBE %', v_r; END $probe$;` Checks: the 8 function md5s equal the local GREEN run's; `team_daily_metrics(<yesterday>)` returns the seven keys; `team_digest_recipients()` lists the expected staff; with the switch on, `dispatch_team_digest('<today> 11:05+00')` (or 12:05 in winter) returns `dispatched` (the HTTP call is rolled back with the block).

- [ ] **Step 4: Apply 00656** with `apply_migration` (name `00656_team_daily_digest`). Verify by object: the 8 md5s, both cron jobs active, both settings present, the tables locked.

- [ ] **Step 5: Preview to the owner.** Ask which account; set `team_digest_preview_to` to its id and `team_digest_enabled` to `true` before 7:00 Havana. Next morning: `team_digest_runs` shows the day `sent` with 1 recipient, and the owner confirms the e-mail and that the unsubscribe page works (opt out and back in).

- [ ] **Step 6: Open it to the team** (with OK): set `team_digest_preview_to` to empty. Watch the first run's row.
