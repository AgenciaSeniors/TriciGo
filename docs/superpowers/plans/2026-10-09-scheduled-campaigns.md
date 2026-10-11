# Scheduled Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Campaigns saved in the admin panel are sent by the server, either now or at the chosen Havana time, exactly once, and a scheduled one can be cancelled before it starts.

**Architecture:** Migration 00649 adds the campaign lifecycle (status CHECK, counters, insert guard), three service-role SQL functions (recipients, claim, dispatcher) and one client RPC (cancel), plus a pg_cron job that calls the dispatcher every minute. A new Edge Function `send-campaign` claims a campaign, resolves its recipients in SQL, calls the existing `send-push` and `send-bulk-email` with the service key and writes the counts. The panel only inserts the campaign and, for "Enviar ahora", calls `send-campaign`.

**Tech Stack:** Postgres 16/17 (plpgsql, pg_cron, pg_net through `cron_http_post`), Supabase Edge Functions (Deno, tested with vitest), Next.js 15 admin (React 18), `@tricigo/api`, `@tricigo/utils`, `@tricigo/i18n`.

**Spec:** `docs/superpowers/specs/2026-10-09-scheduled-campaigns-design.md`.

**Conventions for every task:**
- Work on branch `claude/hopeful-shannon-g3theu` in `/home/user/TriciGo`. Commit messages in English, conventional format, ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01EbnC6H75XT6LqrciPs9Gzi
  ```
- Never put a model name in code, comments, commits or docs.
- Do not touch prod (no MCP `apply_migration`, no Edge Function deploy). Those steps are the controller's, with the founder's OK.
- UI copy is Spanish with tú forms and written accents; `pnpm check:i18n` and the utils copy tests (`copyAccents`, `copyTuteo`) must pass.
- Local Postgres for rehearsals: binaries in `/usr/lib/postgresql/16/bin`, cluster on port 5433, user `pgtest` (CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod"). If the cluster is not running: `su pgtest -c "/usr/lib/postgresql/16/bin/pg_ctl -D ~pgtest/pgdata -o '-p 5433' -l ~pgtest/pg.log start"`; if it does not exist, create it with `useradd -m pgtest` and `initdb` under that home first.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/tests/00649/scaffold.sql` (new) | Prod's shape of `campaigns`, `users`, `rides`, `driver_profiles`, `cities`, the live role helpers, and stubs for pg_cron, `cron_http_post`, `get_service_role_key` |
| `supabase/tests/00649/seed.sql` (new) | Users, rides and campaigns the suite reads |
| `supabase/tests/00649/run.sh` (new) | The rehearsal: RED without the migration, GREEN with it applied twice |
| `supabase/migrations/00649_scheduled_campaigns.sql` (new) | Columns, CHECK, grants, insert guard, recipients, claim, cancel, dispatcher, cron job, self-checks |
| `packages/utils/src/date.ts` (modify) | `havanaLocalToUtcIso`, `utcIsoToHavanaLocal` |
| `packages/utils/src/__tests__/date.test.ts` (modify) | Tests for the two helpers |
| `supabase/functions/_shared/campaign-send.ts` (new) | Pure: channel results → campaign outcome; e-mail body HTML |
| `supabase/functions/_shared/campaign-send.test.ts` (new) | Tests for the pure module |
| `supabase/functions/send-campaign/index.ts` (new) | The sender Edge Function |
| `supabase/functions/send-campaign/index.test.ts` (new) | Handler tests with mocked supabase-js and fetch |
| `packages/api/vitest.config.ts` (modify) | Include `send-campaign/*.test.ts` |
| `supabase/config.toml` (modify) | `[functions.send-campaign] verify_jwt = true` |
| `packages/api/src/services/campaign.service.ts` (new) | `create`, `sendNow`, `cancel` |
| `packages/api/src/services/__tests__/campaign.test.ts` (new) | Service tests |
| `packages/api/src/index.ts` (modify) | Export `campaignService` and its types |
| `apps/admin/src/lib/status-registry.ts` (modify) | `sending`, `failed` campaign statuses |
| `packages/i18n/src/locales/{es,en,pt}/admin.json` (modify) | New campaign and status keys |
| `apps/admin/src/app/campaigns/page.tsx` (modify) | Server-side send, Havana schedule, cancel, refresh |
| `CLAUDE.md` (modify) | Short section on how campaigns are sent and diagnosed |

---

### Task 1: Rehearsal scaffold and seed

**Files:**
- Create: `supabase/tests/00649/scaffold.sql`
- Create: `supabase/tests/00649/seed.sql`

- [ ] **Step 1: Write `supabase/tests/00649/scaffold.sql`**

```sql
-- Scaffold for the 00649 rehearsal (scheduled campaigns).
-- Prod's tables as of 2026-10-09, reduced to the columns 00649 reads, and prod's policies on
-- public.campaigns. The role helpers are the live bodies (current_user_role, is_admin from
-- supabase/tests/00642/live-bodies.sql; is_marketing from migration 00642).
-- Every object belongs to a NON-superuser role named postgres, as in prod, so RLS applies to
-- anon, authenticated and service_role and not to the owner.
-- Simplified on purpose: public.users has no RLS (prod lets each user read its own row, which is
-- all the campaigns admin policy needs); pg_cron, cron_http_post and get_service_role_key are stubs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO pgtest;

CREATE SCHEMA auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

-- pg_cron stub: cron.job column for column, schedule/unschedule upsert by name (as 00636).
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

-- Until 2026-10-30 Supabase grants every new function and table of public to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$f$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');

CREATE TABLE public.cities (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  full_name text NOT NULL DEFAULT '',
  role public.user_role NOT NULL DEFAULT 'customer',
  is_active boolean NOT NULL DEFAULT true,
  city_id uuid REFERENCES public.cities(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  total_rides integer NOT NULL DEFAULT 0,
  total_rides_completed integer NOT NULL DEFAULT 0
);
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status text NOT NULL DEFAULT 'completed',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.promotions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL);

-- LIVE public.campaigns (00073 + 00478 + 00491), constraints as in prod.
CREATE TABLE public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  segment_type text NOT NULL,
  segment_city_id uuid REFERENCES public.cities(id),
  message_title text NOT NULL,
  message_body text NOT NULL,
  promo_code_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'push',
  status text NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  sent_at timestamptz,
  sent_count integer DEFAULT 0,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  audience_role text NOT NULL DEFAULT 'customer',
  CONSTRAINT campaigns_audience_role_chk CHECK (audience_role = ANY (ARRAY['customer'::text, 'driver'::text]))
);

-- LIVE role helpers.
CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$
;
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_marketing()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is marketing, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'marketing';
END;
$$;

-- Stubs: the vault key and the cron HTTP helper. cron_http_post records each call.
CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text
LANGUAGE sql SECURITY DEFINER AS $$ SELECT 'test-service-key'::text $$;
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

-- LIVE policies on public.campaigns.
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin full access on campaigns" ON public.campaigns
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid()
                 AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))
  WITH CHECK (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid()
                      AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])));
CREATE POLICY campaigns_insert_marketing ON public.campaigns FOR INSERT TO authenticated
  WITH CHECK ((SELECT is_marketing()) AND (created_by = (SELECT auth.uid())));
CREATE POLICY campaigns_select_marketing ON public.campaigns FOR SELECT TO authenticated
  USING ((SELECT is_marketing()));

RESET ROLE;
```

- [ ] **Step 2: Write `supabase/tests/00649/seed.sql`**

```sql
-- Seed for the 00649 rehearsal. Runs as the owner (postgres): no trigger guard applies to it.
SET ROLE postgres;
INSERT INTO public.cities (id, name) VALUES
  ('c1000000-0000-4000-8000-000000000001', 'La Habana'),
  ('c1000000-0000-4000-8000-000000000002', 'Santiago de Cuba');

INSERT INTO auth.users (id) VALUES
  ('a0000000-0000-4000-8000-0000000000a1'), ('a0000000-0000-4000-8000-0000000000b1'),
  ('a0000000-0000-4000-8000-0000000000b2'), ('a0000000-0000-4000-8000-0000000000e1'),
  ('a0000000-0000-4000-8000-000000000c01'), ('a0000000-0000-4000-8000-000000000c02'),
  ('a0000000-0000-4000-8000-000000000c03'), ('a0000000-0000-4000-8000-000000000c04'),
  ('a0000000-0000-4000-8000-000000000d01'), ('a0000000-0000-4000-8000-000000000d02');

-- a1 admin, b1/b2 marketing, e1 a customer with no rides used only as a caller,
-- c01..c04 customers, d01/d02 drivers. full_name is the label the suite prints.
INSERT INTO public.users (id, full_name, role, is_active, city_id, created_at) VALUES
  ('a0000000-0000-4000-8000-0000000000a1', 'admin',     'admin',     true,  NULL, now() - interval '200 days'),
  ('a0000000-0000-4000-8000-0000000000b1', 'mkt1',      'marketing', true,  NULL, now() - interval '200 days'),
  ('a0000000-0000-4000-8000-0000000000b2', 'mkt2',      'marketing', true,  NULL, now() - interval '200 days'),
  ('a0000000-0000-4000-8000-0000000000e1', 'caller',    'customer',  true,  'c1000000-0000-4000-8000-000000000002', now() - interval '200 days'),
  ('a0000000-0000-4000-8000-000000000c01', 'c_new',     'customer',  true,  'c1000000-0000-4000-8000-000000000001', now() - interval '2 days'),
  ('a0000000-0000-4000-8000-000000000c02', 'c_power',   'customer',  true,  NULL, now() - interval '100 days'),
  ('a0000000-0000-4000-8000-000000000c03', 'c_active',  'customer',  true,  'c1000000-0000-4000-8000-000000000002', now() - interval '100 days'),
  ('a0000000-0000-4000-8000-000000000c04', 'c_blocked', 'customer',  false, 'c1000000-0000-4000-8000-000000000001', now() - interval '1 day'),
  ('a0000000-0000-4000-8000-000000000d01', 'd_power',   'driver',    true,  NULL, now() - interval '100 days'),
  ('a0000000-0000-4000-8000-000000000d02', 'd_idle',    'driver',    true,  NULL, now() - interval '2 days');

INSERT INTO public.driver_profiles (id, user_id, total_rides, total_rides_completed) VALUES
  ('dd000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000d01', 0, 11),
  ('dd000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000d02', 0, 0);

-- c_power: 11 rides, all 40 days ago. c_blocked: 11 old rides too (must still be excluded).
INSERT INTO public.rides (customer_id, created_at)
SELECT 'a0000000-0000-4000-8000-000000000c02', now() - interval '40 days' FROM generate_series(1, 11);
INSERT INTO public.rides (customer_id, created_at)
SELECT 'a0000000-0000-4000-8000-000000000c04', now() - interval '40 days' FROM generate_series(1, 11);
-- c_active rode 3 days ago, driven by d_power. 'caller' rode 1 day ago.
INSERT INTO public.rides (customer_id, driver_id, created_at) VALUES
  ('a0000000-0000-4000-8000-000000000c03', 'dd000000-0000-4000-8000-000000000001', now() - interval '3 days'),
  ('a0000000-0000-4000-8000-0000000000e1', NULL, now() - interval '1 day');

-- One campaign per segment, as drafts so the dispatcher never sees them.
INSERT INTO public.campaigns (id, name, segment_type, segment_city_id, audience_role, message_title, message_body, status) VALUES
  ('ca000000-0000-4000-8000-000000000001', 'all_c',      'all',         NULL, 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000002', 'new_c',      'new_users',   NULL, 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000003', 'power_c',    'power_users', NULL, 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000004', 'inactive_c', 'inactive',    NULL, 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000005', 'city_hav',   'by_city', 'c1000000-0000-4000-8000-000000000001', 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000006', 'city_null',  'by_city',     NULL, 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000007', 'all_d',      'all',         NULL, 'driver',   't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000008', 'new_d',      'new_users',   NULL, 'driver',   't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000009', 'power_d',    'power_users', NULL, 'driver',   't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000010', 'inactive_d', 'inactive',    NULL, 'driver',   't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000011', 'unknown',    'whatever',    NULL, 'customer', 't', 'b', 'draft');
RESET ROLE;
```

- [ ] **Step 3: Check that both files load into a fresh database**

Run:
```bash
B=/usr/lib/postgresql/16/bin; C="-h 127.0.0.1 -p 5433 -U pgtest"
$B/psql $C -d postgres -qAt -c "DROP DATABASE IF EXISTS pr649s" -c "CREATE DATABASE pr649s"
$B/psql $C -d pr649s -qAt -v ON_ERROR_STOP=1 -f supabase/tests/00649/scaffold.sql && \
$B/psql $C -d pr649s -qAt -v ON_ERROR_STOP=1 -f supabase/tests/00649/seed.sql && \
$B/psql $C -d pr649s -qAt -c "SELECT count(*) FROM public.users; SELECT count(*) FROM public.campaigns"
$B/psql $C -d postgres -qAt -c "DROP DATABASE pr649s"
```
Expected: `10` then `11`, no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/tests/00649/scaffold.sql supabase/tests/00649/seed.sql
git commit -m "test(campaigns): rehearsal scaffold and seed for 00649"
```

---

### Task 2: Rehearsal suite (RED)

**Files:**
- Create: `supabase/tests/00649/run.sh`

- [ ] **Step 1: Write `supabase/tests/00649/run.sh`**

```bash
#!/usr/bin/env bash
# Rehearsal runner for migration 00649 (scheduled campaigns). Local Postgres 16, no Supabase stack.
#   supabase/tests/00649/run.sh none
#       -> scaffold + seed + tests (RED: none of the 00649 objects exist)
#   supabase/tests/00649/run.sh supabase/migrations/00649_scheduled_campaigns.sql
#       -> scaffold + seed + migration x2 (idempotency) + tests (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster: CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
DB=pr649
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
has(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r'); if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "no /$3/ in: $(echo "$r" | paste -sd' ' -)"; fi; }
# as UID -> become an authenticated user with that JWT subject, for the rest of the transaction
# (SET LOCAL prints nothing; a SELECT set_config would add a row to every output)
as(){ printf "SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated;" "$1"; }
SVC="SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE service_role;"
A=a0000000-0000-4000-8000-0000000000a1; M1=a0000000-0000-4000-8000-0000000000b1
M2=a0000000-0000-4000-8000-0000000000b2; CU=a0000000-0000-4000-8000-0000000000e1
# rcp CAMPAIGN_ID -> the labels of its recipients, sorted
rcp(){ echo "SELECT coalesce(string_agg(u.full_name, ',' ORDER BY u.full_name COLLATE \"C\"), '-')
              FROM unnest(public.campaign_recipient_ids('$1')) r JOIN public.users u ON u.id = r;"; }
# mk ID NAME STATUS SCHEDULED_AT STARTED_AT CREATED_BY -> a campaign written as the owner (no guard)
mk(){ echo "INSERT INTO public.campaigns (id, name, segment_type, audience_role, message_title, message_body, status, scheduled_at, started_at, created_by)
            VALUES ('$1', '$2', 'all', 'customer', 't', 'b', '$3', $4, $5, $6);"; }

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1
$P -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
$P -f "$DIR/seed.sql" >/dev/null 2>&1 || { echo "seed failed"; exit 1; }

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as postgres) =="
  $P -1 -c "SET ROLE postgres" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency) =="
  $P -1 -c "SET ROLE postgres" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== recipients (campaign_recipient_ids, as service_role) =="
R(){ val "$1" "BEGIN; $SVC $(rcp "$2") ROLLBACK;" "$3"; }
R "R1 all customers, blocked excluded"            ca000000-0000-4000-8000-000000000001 "c_active,c_new,c_power,caller"
R "R2 new customers (7 days)"                      ca000000-0000-4000-8000-000000000002 "c_new"
R "R3 power customers (>10 rides, any status)"     ca000000-0000-4000-8000-000000000003 "c_power"
R "R4 inactive customers (no ride in 30 days)"     ca000000-0000-4000-8000-000000000004 "c_new,c_power"
R "R5 customers in La Habana, blocked excluded"    ca000000-0000-4000-8000-000000000005 "c_new"
R "R6 by_city without a city reaches nobody"       ca000000-0000-4000-8000-000000000006 "-"
R "R7 all drivers"                                 ca000000-0000-4000-8000-000000000007 "d_idle,d_power"
R "R8 new drivers"                                 ca000000-0000-4000-8000-000000000008 "d_idle"
R "R9 power drivers (>10 completed)"               ca000000-0000-4000-8000-000000000009 "d_power"
R "R10 inactive drivers (drove no ride in 30 days)" ca000000-0000-4000-8000-000000000010 "d_idle"
R "R11 an unknown segment reaches nobody"          ca000000-0000-4000-8000-000000000011 "-"
val "R12 a missing campaign reaches nobody" \
  "BEGIN; $SVC $(rcp 00000000-0000-4000-8000-000000000000) ROLLBACK;" "-"

echo "== privileges =="
val "P1 clients cannot run the server-only functions; authenticated can cancel" \
  "SELECT has_function_privilege('authenticated', 'public.campaign_recipient_ids(uuid)', 'EXECUTE') || ',' ||
          has_function_privilege('authenticated', 'public.claim_campaigns(uuid, integer)', 'EXECUTE') || ',' ||
          has_function_privilege('authenticated', 'public.dispatch_due_campaigns()', 'EXECUTE') || ',' ||
          has_function_privilege('anon', 'public.cancel_campaign(uuid)', 'EXECUTE') || ',' ||
          has_function_privilege('authenticated', 'public.cancel_campaign(uuid)', 'EXECUTE') || ',' ||
          has_function_privilege('service_role', 'public.claim_campaigns(uuid, integer)', 'EXECUTE')" \
  "false,false,false,false,true,true"
val "P2 clients cannot UPDATE or TRUNCATE campaigns, anon cannot INSERT; service_role keeps UPDATE" \
  "SELECT has_table_privilege('authenticated', 'public.campaigns', 'UPDATE') || ',' ||
          has_table_privilege('authenticated', 'public.campaigns', 'TRUNCATE') || ',' ||
          has_table_privilege('anon', 'public.campaigns', 'INSERT') || ',' ||
          has_table_privilege('service_role', 'public.campaigns', 'UPDATE')" \
  "false,false,false,true"

echo "== client inserts (insert guard) =="
NEW_ROW="INSERT INTO public.campaigns (name, segment_type, message_title, message_body, status, sent_count, scheduled_at, created_by)"
val "I1 marketing insert becomes scheduled, counters reset, created_by forced, past time clamped to now" \
  "BEGIN; $(as $M1) $NEW_ROW VALUES ('i1', 'all', 't', 'b', 'draft', 99, '2000-01-01', '$M2');
   SELECT status || ',' || sent_count || ',' || (created_by = '$M1') || ',' || (scheduled_at >= now() - interval '1 second')
   FROM public.campaigns WHERE name = 'i1'; ROLLBACK;" \
  "scheduled,0,true,true"
val "I2 a future scheduled_at is kept" \
  "BEGIN; $(as $M1) $NEW_ROW VALUES ('i2', 'all', 't', 'b', 'scheduled', 0, now() + interval '2 hours', NULL);
   SELECT status || ',' || (scheduled_at > now() + interval '1 hour') FROM public.campaigns WHERE name = 'i2'; ROLLBACK;" \
  "scheduled,true"
val "I3 legacy: an insert that says sent is kept as sent (old panel already delivered it)" \
  "BEGIN; $(as $A) $NEW_ROW VALUES ('i3', 'all', 't', 'b', 'sent', 5, NULL, NULL);
   SELECT status || ',' || sent_count || ',' || (created_by = '$A') FROM public.campaigns WHERE name = 'i3'; ROLLBACK;" \
  "sent,5,true"
val "I4 an admin insert that says sending becomes scheduled" \
  "BEGIN; $(as $A) $NEW_ROW VALUES ('i4', 'all', 't', 'b', 'sending', 0, NULL, NULL);
   SELECT status FROM public.campaigns WHERE name = 'i4'; ROLLBACK;" \
  "scheduled"
val "I5 service_role keeps what it writes" \
  "BEGIN; $SVC $NEW_ROW VALUES ('i5', 'all', 't', 'b', 'draft', 3, NULL, NULL);
   SELECT status || ',' || sent_count FROM public.campaigns WHERE name = 'i5'; ROLLBACK;" \
  "draft,3"
has "I6 a customer cannot insert" \
  "BEGIN; $(as $CU) $NEW_ROW VALUES ('i6', 'all', 't', 'b', 'draft', 0, NULL, NULL); ROLLBACK;" \
  "row-level security"
has "I7 marketing cannot UPDATE a campaign directly" \
  "BEGIN; $(as $M1) UPDATE public.campaigns SET status = 'sent'; ROLLBACK;" \
  "permission denied for table campaigns"
has "I8 the status CHECK rejects an unknown status" \
  "BEGIN; SET LOCAL ROLE postgres; $NEW_ROW VALUES ('i8', 'all', 't', 'b', 'bogus', 0, NULL, NULL); ROLLBACK;" \
  "campaigns_status_chk"

echo "== claim =="
K1=cb000000-0000-4000-8000-000000000001; K2=cb000000-0000-4000-8000-000000000002
K3=cb000000-0000-4000-8000-000000000003; K4=cb000000-0000-4000-8000-000000000004
SETUP_K="SET LOCAL ROLE postgres;
  $(mk $K1 k1 scheduled "now() - interval '10 minutes'" NULL "'$M1'")
  $(mk $K2 k2 scheduled "now() - interval '5 minutes'" NULL "'$M1'")
  $(mk $K3 k3 scheduled "now() + interval '1 hour'" NULL "'$M1'")
  $(mk $K4 k4 cancelled "now() - interval '20 minutes'" NULL "'$M1'")
  RESET ROLE;"
val "C1 claim takes only due scheduled campaigns, oldest first, and marks them sending" \
  "BEGIN; $SETUP_K $SVC SELECT string_agg(name || ':' || status || ':' || (started_at IS NOT NULL), ',' ORDER BY scheduled_at)
   FROM public.claim_campaigns(NULL, 5); ROLLBACK;" \
  "k1:sending:true,k2:sending:true"
val "C2 a campaign scheduled for later cannot be claimed by id" \
  "BEGIN; $SETUP_K $SVC SELECT count(*) FROM public.claim_campaigns('$K3', 1); ROLLBACK;" "0"
val "C3 p_limit is respected" \
  "BEGIN; $SETUP_K $SVC SELECT string_agg(name, ',') FROM public.claim_campaigns(NULL, 1); ROLLBACK;" "k1"
val "C4 a claimed campaign cannot be claimed again" \
  "BEGIN; $SETUP_K $SVC SELECT count(*) FROM public.claim_campaigns('$K1', 1);
   SELECT count(*) FROM public.claim_campaigns('$K1', 1); ROLLBACK;" "1;0"
# C5: two sessions at once. A holds the claim open for 3 s; B, meanwhile, skips the locked row.
$P -c "SET ROLE postgres; $(mk $K1 k1 scheduled "now() - interval '10 minutes'" NULL "'$M1'")" >/dev/null
( $P -c "BEGIN; $SVC SELECT count(*) FROM public.claim_campaigns('$K1', 1); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 ) &
sleep 1
val "C5 while another session holds the claim, a second claim gets nothing (no double send)" \
  "BEGIN; $SVC SELECT count(*) FROM public.claim_campaigns('$K1', 1); ROLLBACK;" "0"
wait
val "C6 after both sessions, the campaign is sending exactly once" \
  "SELECT status FROM public.campaigns WHERE id = '$K1'" "sending"
$P -c "SET ROLE postgres; DELETE FROM public.campaigns WHERE id = '$K1'" >/dev/null

echo "== cancel =="
SETUP_X="SET LOCAL ROLE postgres;
  $(mk $K1 x1 scheduled "now() + interval '1 hour'" NULL "'$M1'")
  $(mk $K2 x2 sending "now() - interval '1 minute'" "now()" "'$M1'")
  RESET ROLE;"
val "X1 marketing cancels its own scheduled campaign" \
  "BEGIN; $SETUP_X $(as $M1) SELECT public.cancel_campaign('$K1'); RESET ROLE;
   SELECT status || ',' || (canceled_by = '$M1') || ',' || (canceled_at IS NOT NULL) FROM public.campaigns WHERE id = '$K1'; ROLLBACK;" \
  "cancelled;cancelled,true,true"
has "X2 marketing cannot cancel another account's campaign" \
  "BEGIN; $SETUP_X $(as $M2) SELECT public.cancel_campaign('$K1'); ROLLBACK;" \
  "Solo puedes cancelar las campañas que creaste"
val "X3 an admin cancels any scheduled campaign" \
  "BEGIN; $SETUP_X $(as $A) SELECT public.cancel_campaign('$K1'); ROLLBACK;" "cancelled"
val "X4 a campaign already sending is not cancelled; its status comes back" \
  "BEGIN; $SETUP_X $(as $A) SELECT public.cancel_campaign('$K2'); RESET ROLE;
   SELECT status FROM public.campaigns WHERE id = '$K2'; ROLLBACK;" "sending;sending"
has "X5 a customer cannot cancel" \
  "BEGIN; $SETUP_X $(as $CU) SELECT public.cancel_campaign('$K1'); ROLLBACK;" "campaign_cancel_forbidden|Solo puedes cancelar"
has "X6 anon cannot call cancel" \
  "BEGIN; SET LOCAL ROLE anon; SELECT public.cancel_campaign('$K1'); ROLLBACK;" "permission denied for function cancel_campaign"
val "X7 cancelling a missing campaign returns not_found" \
  "BEGIN; $(as $A) SELECT public.cancel_campaign('00000000-0000-4000-8000-000000000000'); ROLLBACK;" "not_found"

echo "== dispatcher and cron job =="
val "D1 nothing due: returns 0 and calls nothing" \
  "BEGIN; $SVC SELECT public.dispatch_due_campaigns(); RESET ROLE; SELECT count(*) FROM public.cron_http_post_calls; ROLLBACK;" "0;0"
val "D2 one due campaign: one call to send-campaign with the service key and {due:true}" \
  "BEGIN; SET LOCAL ROLE postgres; $(mk $K1 d2 scheduled "now() - interval '1 minute'" NULL "'$M1'") RESET ROLE;
   $SVC SELECT public.dispatch_due_campaigns(); RESET ROLE;
   SELECT jobname || '|' || (url LIKE '%/functions/v1/send-campaign') || '|' || body::text || '|' || timeout_ms || '|' ||
          (headers->>'Authorization') || '|' || (headers->>'apikey') FROM public.cron_http_post_calls; ROLLBACK;" \
  "1;send-due-campaigns|true|{\"due\": true}|30000|Bearer test-service-key|test-service-key"
val "D3 a campaign stuck in sending for 20 minutes fails as interrupted; one 5 minutes old is left" \
  "BEGIN; SET LOCAL ROLE postgres;
   $(mk $K1 d3a sending "now() - interval '30 minutes'" "now() - interval '20 minutes'" "'$M1'")
   $(mk $K2 d3b sending "now() - interval '10 minutes'" "now() - interval '5 minutes'" "'$M1'") RESET ROLE;
   $SVC SELECT public.dispatch_due_campaigns(); RESET ROLE;
   SELECT string_agg(name || ':' || status || ':' || coalesce(last_error, '-'), ',' ORDER BY name)
   FROM public.campaigns WHERE name IN ('d3a', 'd3b'); ROLLBACK;" \
  "0;d3a:failed:interrupted,d3b:sending:-"
val "D4 the cron job runs the dispatcher every minute" \
  "SELECT string_agg(jobname || '|' || schedule || '|' || command, ',') FROM cron.job WHERE jobname = 'send-due-campaigns'" \
  "send-due-campaigns|* * * * *|SELECT public.dispatch_due_campaigns();"
val "D5 the dispatcher swallows no error (its failures reach check_cron_sql_failures)" \
  "SELECT prosrc !~* 'exception' FROM pg_proc WHERE proname = 'dispatch_due_campaigns'" "true"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Make it executable and run it without the migration (RED)**

```bash
chmod +x supabase/tests/00649/run.sh
supabase/tests/00649/run.sh none; echo "exit=$?"
```
Expected: most tests FAIL (the 00649 functions do not exist, the guard and CHECK are missing), the summary line shows `FAIL` > 20 and `exit=1`. Save the summary line for the PR.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/00649/run.sh
git commit -m "test(campaigns): rehearsal suite for 00649 (RED)"
```

---

### Task 3: Migration 00649 (GREEN)

**Files:**
- Create: `supabase/migrations/00649_scheduled_campaigns.sql`

- [ ] **Step 1: Re-check the number**

```bash
git fetch -q origin master
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5
```
Expected: nothing at or above 00649 except files of this PR. Open PRs reserve 00647 (#1127) and 00648 (#1128). If 00649 is taken, use the next free number in every file name and reference of this plan.

- [ ] **Step 2: Write `supabase/migrations/00649_scheduled_campaigns.sql`**

```sql
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
-- campaign twice.
CREATE OR REPLACE FUNCTION public.claim_campaigns(p_campaign_id uuid DEFAULT NULL, p_limit integer DEFAULT 5)
RETURNS SETOF public.campaigns
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.campaigns c
     SET status = 'sending', started_at = now()
   WHERE c.status = 'scheduled'
     AND c.id IN (
       SELECT d.id FROM public.campaigns d
        WHERE d.status = 'scheduled'
          AND d.scheduled_at <= now()
          AND (p_campaign_id IS NULL OR d.id = p_campaign_id)
        ORDER BY d.scheduled_at, d.id
        LIMIT GREATEST(p_limit, 0)
        FOR UPDATE SKIP LOCKED
     )
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
```

- [ ] **Step 3: Run the rehearsal with the migration (GREEN)**

```bash
supabase/tests/00649/run.sh supabase/migrations/00649_scheduled_campaigns.sql; echo "exit=$?"
```
Expected: every line `PASS`, `FAIL=0`, `exit=0`. If a test fails, fix the migration, not the test, unless the test contradicts the spec.

- [ ] **Step 4: Repo checks for migrations**

```bash
pnpm check:migration-grants
pnpm --filter @tricigo/utils exec vitest run src/__tests__/copyTuteo.test.ts src/__tests__/copyAccents.test.ts
```
Expected: both pass (no new table; the only SQL copy is "Solo puedes cancelar las campañas que creaste.").

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00649_scheduled_campaigns.sql
git commit -m "feat(campaigns): server-side lifecycle, recipients, claim, cancel and dispatcher (00649)"
```

---

### Task 4: Havana datetime-local helpers

**Files:**
- Modify: `packages/utils/src/date.ts` (append after `havanaDayRangeUtc`)
- Test: `packages/utils/src/__tests__/date.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to `packages/utils/src/__tests__/date.test.ts`; add `havanaLocalToUtcIso, utcIsoToHavanaLocal` to its existing import from `'../date'`)

```ts
describe('havanaLocalToUtcIso', () => {
  it('reads a datetime-local value as Havana time in winter (UTC-5)', () => {
    expect(havanaLocalToUtcIso('2026-01-15T10:00')).toBe('2026-01-15T15:00:00.000Z');
  });

  it('reads it as Havana time in summer (UTC-4)', () => {
    expect(havanaLocalToUtcIso('2026-07-15T10:00')).toBe('2026-07-15T14:00:00.000Z');
  });

  it('crosses into the next UTC day', () => {
    expect(havanaLocalToUtcIso('2026-01-15T22:30')).toBe('2026-01-16T03:30:00.000Z');
  });

  it('uses the offset in force on each side of the November change', () => {
    expect(havanaLocalToUtcIso('2026-10-31T10:00')).toBe('2026-10-31T14:00:00.000Z');
    expect(havanaLocalToUtcIso('2026-11-02T10:00')).toBe('2026-11-02T15:00:00.000Z');
  });

  it('rejects anything that is not YYYY-MM-DDTHH:mm', () => {
    expect(() => havanaLocalToUtcIso('2026-01-15')).toThrow('YYYY-MM-DDTHH:mm');
    expect(() => havanaLocalToUtcIso('')).toThrow('YYYY-MM-DDTHH:mm');
  });
});

describe('utcIsoToHavanaLocal', () => {
  it('gives the Havana wall clock as a datetime-local value', () => {
    expect(utcIsoToHavanaLocal('2026-01-15T15:00:00.000Z')).toBe('2026-01-15T10:00');
    expect(utcIsoToHavanaLocal('2026-07-15T14:00:00.000Z')).toBe('2026-07-15T10:00');
    expect(utcIsoToHavanaLocal('2026-01-16T03:30:00.000Z')).toBe('2026-01-15T22:30');
  });

  it('round-trips with havanaLocalToUtcIso', () => {
    for (const v of ['2026-03-20T08:15', '2026-12-24T23:59', '2026-06-01T00:00']) {
      expect(utcIsoToHavanaLocal(havanaLocalToUtcIso(v))).toBe(v);
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/date.test.ts`
Expected: FAIL, `havanaLocalToUtcIso is not a function` (or an import error).

- [ ] **Step 3: Implement** (append to `packages/utils/src/date.ts`; `HAVANA_TIMEZONE` already exists in that file)

```ts
/** Havana wall-clock parts of an instant. */
function havanaParts(instant: Date): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: HAVANA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}

/**
 * Minutes that UTC is ahead of Havana at an instant (300 in winter, 240 in summer).
 * Seconds are dropped: datetime-local values have minute precision.
 */
function havanaOffsetMinutes(instant: Date): number {
  const p = havanaParts(instant);
  const wallAsUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  const instantToMinute = Math.floor(instant.getTime() / 60000) * 60000;
  return Math.round((instantToMinute - wallAsUtc) / 60000);
}

/**
 * A `datetime-local` value ('YYYY-MM-DDTHH:mm') read as Havana wall-clock time, as a UTC ISO
 * string. Sent raw, Postgres reads that value as UTC: 4–5 hours off Cuba's clock.
 */
export function havanaLocalToUtcIso(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`havanaLocalToUtcIso: expected YYYY-MM-DDTHH:mm, got "${value}"`);
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  // Correct by the offset at the guessed instant, then once more in case the guess fell on the
  // other side of a DST change.
  let utc = wallAsUtc + havanaOffsetMinutes(new Date(wallAsUtc)) * 60000;
  const second = havanaOffsetMinutes(new Date(utc));
  utc = wallAsUtc + second * 60000;
  return new Date(utc).toISOString();
}

/** The Havana wall clock of a UTC instant, as a `datetime-local` value ('YYYY-MM-DDTHH:mm'). */
export function utcIsoToHavanaLocal(iso: string): string {
  const p = havanaParts(new Date(iso));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/date.test.ts`
Expected: PASS, including the existing tests in that file.

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/date.ts packages/utils/src/__tests__/date.test.ts
git commit -m "feat(utils): read datetime-local values as Havana time"
```

---

### Task 5: Pure campaign-send module

**Files:**
- Create: `supabase/functions/_shared/campaign-send.ts`
- Test: `supabase/functions/_shared/campaign-send.test.ts` (already covered by the `_shared/**/*.test.ts` include of `packages/api/vitest.config.ts`)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { campaignEmailHtml, campaignOutcome } from './campaign-send.ts';

describe('campaignOutcome', () => {
  it('push and e-mail both worked', () => {
    expect(campaignOutcome([
      { channel: 'push', ok: true, sent: 7 },
      { channel: 'email', ok: true, sent: 3 },
    ])).toEqual({ status: 'sent', pushSent: 7, emailSent: 3, sentCount: 7, lastError: null });
  });

  it('one channel failed and the other worked: sent, with the failure noted', () => {
    expect(campaignOutcome([
      { channel: 'push', ok: false, sent: 0, error: 'HTTP 500' },
      { channel: 'email', ok: true, sent: 2 },
    ])).toEqual({ status: 'sent', pushSent: 0, emailSent: 2, sentCount: 2, lastError: 'push: HTTP 500' });
  });

  it('every chosen channel failed: failed', () => {
    expect(campaignOutcome([{ channel: 'email', ok: false, sent: 0, error: 'resend_not_configured' }]))
      .toEqual({ status: 'failed', pushSent: 0, emailSent: 0, sentCount: 0, lastError: 'email: resend_not_configured' });
  });

  it('no recipients and no channel call: sent with zero', () => {
    expect(campaignOutcome([])).toEqual({ status: 'sent', pushSent: 0, emailSent: 0, sentCount: 0, lastError: null });
  });

  it('the recipients could not be read: failed', () => {
    expect(campaignOutcome([], 'recipients: boom'))
      .toEqual({ status: 'failed', pushSent: 0, emailSent: 0, sentCount: 0, lastError: 'recipients: boom' });
  });

  it('keeps last_error short', () => {
    const long = 'x'.repeat(2000);
    expect(campaignOutcome([{ channel: 'push', ok: false, sent: 0, error: long }]).lastError!.length).toBe(500);
  });
});

describe('campaignEmailHtml', () => {
  it('escapes the text and keeps line breaks', () => {
    expect(campaignEmailHtml('Hola <b>Ana</b> & co\nViaja hoy')).toBe(
      '<p>Hola &lt;b&gt;Ana&lt;/b&gt; &amp; co<br/>Viaja hoy</p>',
    );
  });

  it('handles Windows line breaks', () => {
    expect(campaignEmailHtml('a\r\nb')).toBe('<p>a<br/>b</p>');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/_shared/campaign-send.test.ts`
Expected: FAIL, cannot resolve `./campaign-send.ts`.

- [ ] **Step 3: Implement `supabase/functions/_shared/campaign-send.ts`**

```ts
// ============================================================
// What a campaign send produced, from the results of its channels (00649).
// Pure module: no remote imports, so packages/api's vitest runs it unmodified.
// ============================================================

import { escapeHtml } from './email-templates/_layout.ts';

export interface ChannelResult {
  channel: 'push' | 'email';
  /** The channel's Edge Function answered 2xx. */
  ok: boolean;
  /** How many it delivered (push tickets ok, e-mails accepted). */
  sent: number;
  error?: string;
}

export interface CampaignOutcome {
  status: 'sent' | 'failed';
  pushSent: number;
  emailSent: number;
  /** What the list shows as "Enviados": the larger of the two. */
  sentCount: number;
  lastError: string | null;
}

const MAX_ERROR = 500;

/**
 * 'failed' when the recipients could not be read, or when every channel that was called failed.
 * A channel that failed while another worked leaves 'sent' with its error in lastError.
 * No channel called (nobody in the segment) is 'sent' with zero.
 */
export function campaignOutcome(results: ChannelResult[], recipientError?: string): CampaignOutcome {
  const pushSent = results.find((r) => r.channel === 'push' && r.ok)?.sent ?? 0;
  const emailSent = results.find((r) => r.channel === 'email' && r.ok)?.sent ?? 0;
  const errors = [
    ...(recipientError ? [recipientError] : []),
    ...results.filter((r) => !r.ok).map((r) => `${r.channel}: ${r.error ?? 'error'}`),
  ];
  const failed = recipientError !== undefined || (results.length > 0 && results.every((r) => !r.ok));
  return {
    status: failed ? 'failed' : 'sent',
    pushSent,
    emailSent,
    sentCount: Math.max(pushSent, emailSent),
    lastError: errors.length > 0 ? errors.join(' · ').slice(0, MAX_ERROR) : null,
  };
}

/** The campaign body as e-mail HTML: escaped, with its line breaks kept. */
export function campaignEmailHtml(body: string): string {
  return `<p>${escapeHtml(body).replace(/\r?\n/g, '<br/>')}</p>`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/_shared/campaign-send.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/campaign-send.ts supabase/functions/_shared/campaign-send.test.ts
git commit -m "feat(campaigns): campaign send outcome and e-mail body helpers"
```

---

### Task 6: Edge Function `send-campaign`

**Files:**
- Create: `supabase/functions/send-campaign/index.ts`
- Create: `supabase/functions/send-campaign/index.test.ts`
- Modify: `packages/api/vitest.config.ts` (add the include line next to the `send-push` one)
- Modify: `supabase/config.toml` (add the function block next to `[functions.send-bulk-email]`)

- [ ] **Step 1: Add the test include and the function config**

In `packages/api/vitest.config.ts`, after the line `'../../supabase/functions/send-push/*.test.ts',` add:
```ts
      // send-campaign's handler (00649): supabase-js and fetch are mocked, Deno is stubbed.
      '../../supabase/functions/send-campaign/*.test.ts',
```

In `supabase/config.toml`, after the `[functions.send-bulk-email]` block add:
```toml
[functions.send-campaign]
verify_jwt = true
```

- [ ] **Step 2: Write the failing tests `supabase/functions/send-campaign/index.test.ts`**

```ts
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real send-campaign handler. supabase-js (esm.sh) is replaced with a fake client:
// sessions for auth.getUser, a role per user, campaigns by id, the ids claim_campaigns hands out,
// and the recipients campaign_recipient_ids returns. fetch is stubbed per Edge Function URL.

interface FakeCampaign {
  id: string; name: string; channel: string; message_title: string; message_body: string;
  promo_code_id: string | null; created_by: string | null; status: string;
}

const db = vi.hoisted(() => ({
  sessions: {} as Record<string, string>,
  roles: {} as Record<string, string>,
  campaigns: {} as Record<string, FakeCampaign>,
  claimable: [] as string[],
  recipients: [] as string[],
  recipientsError: null as null | { message: string },
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  updates: [] as Array<{ id: string; row: Record<string, unknown> }>,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => {
  function query(table: string) {
    const filters: Record<string, string> = {};
    let pendingUpdate: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, val: string) => {
      filters[col] = val;
      return q;
    };
    q.update = (row: Record<string, unknown>) => {
      pendingUpdate = row;
      return q;
    };
    q.single = () => {
      if (table === 'users') {
        const role = db.roles[filters.id];
        return Promise.resolve(role ? { data: { role }, error: null } : { data: null, error: { message: 'no rows' } });
      }
      const c = db.campaigns[filters.id];
      return Promise.resolve(c ? { data: c, error: null } : { data: null, error: { message: 'no rows' } });
    };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => {
      if (pendingUpdate && table === 'campaigns') {
        db.updates.push({ id: filters.id, row: pendingUpdate });
        const c = db.campaigns[filters.id];
        if (c && (!filters.status || c.status === filters.status)) Object.assign(c, pendingUpdate);
      }
      return Promise.resolve({ data: null, error: null }).then(ok, ko);
    };
    return q;
  }
  return {
    createClient: () => ({
      auth: {
        getUser: (token: string) =>
          Promise.resolve(
            db.sessions[token]
              ? { data: { user: { id: db.sessions[token] } }, error: null }
              : { data: { user: null }, error: { message: 'invalid JWT' } },
          ),
      },
      from: (table: string) => query(table),
      rpc: (fn: string, args: Record<string, unknown>) => {
        db.rpcCalls.push({ fn, args });
        if (fn === 'claim_campaigns') {
          const want = args.p_campaign_id as string | null;
          const ids = db.claimable.filter((id) => !want || id === want).slice(0, args.p_limit as number);
          db.claimable = db.claimable.filter((id) => !ids.includes(id));
          for (const id of ids) db.campaigns[id].status = 'sending';
          return Promise.resolve({ data: ids.map((id) => ({ ...db.campaigns[id] })), error: null });
        }
        if (fn === 'campaign_recipient_ids') {
          return Promise.resolve(db.recipientsError ? { data: null, error: db.recipientsError } : { data: db.recipients, error: null });
        }
        return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
      },
    }),
  };
});

const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
};

let handler: (req: Request) => Promise<Response>;
let pushResponse: Response | (() => Response);
let emailResponse: Response | (() => Response);
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  const pick = url.endsWith('/send-push') ? pushResponse : emailResponse;
  return typeof pick === 'function' ? pick() : pick.clone();
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

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const MKT1 = '00000000-0000-4000-8000-0000000000b1';
const MKT2 = '00000000-0000-4000-8000-0000000000b2';
const CUSTOMER = '00000000-0000-4000-8000-0000000000c1';
const CAMP = 'ca000000-0000-4000-8000-000000000001';
const CAMP2 = 'ca000000-0000-4000-8000-000000000002';

const campaign = (id: string, channel: string, created_by: string): FakeCampaign => ({
  id, name: id, channel, message_title: 'Viaja hoy', message_body: 'Hola <b>Ana</b>\nVen', promo_code_id: null,
  created_by, status: 'scheduled',
});

beforeEach(() => {
  fetchMock.mockClear();
  db.sessions = { 'jwt-admin': ADMIN, 'jwt-mkt1': MKT1, 'jwt-mkt2': MKT2, 'jwt-customer': CUSTOMER };
  db.roles = { [ADMIN]: 'admin', [MKT1]: 'marketing', [MKT2]: 'marketing', [CUSTOMER]: 'customer' };
  db.campaigns = { [CAMP]: campaign(CAMP, 'both', MKT1), [CAMP2]: campaign(CAMP2, 'push', MKT2) };
  db.claimable = [CAMP, CAMP2];
  db.recipients = ['u1', 'u2', 'u3'];
  db.recipientsError = null;
  db.rpcCalls = [];
  db.updates = [];
  pushResponse = new Response(JSON.stringify({ sent: 3, failed: 0 }), { status: 200 });
  emailResponse = new Response(JSON.stringify({ ok: true, sent: 2, failed: 0 }), { status: 200 });
});

const call = (body: unknown, opts: { token?: string; internal?: boolean } = {}) =>
  handler(
    new Request('https://example.supabase.co/functions/v1/send-campaign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.internal ? { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const lastUpdate = (id: string) => [...db.updates].reverse().find((u) => u.id === id)?.row;

describe('send-campaign: who may send', () => {
  it('401 without a session', async () => {
    expect((await call({ campaign_id: CAMP })).status).toBe(401);
    expect(db.rpcCalls).toEqual([]);
  });

  it('403 for a customer', async () => {
    expect((await call({ campaign_id: CAMP }, { token: 'jwt-customer' })).status).toBe(403);
    expect(db.rpcCalls).toEqual([]);
  });

  it("403 for marketing on another account's campaign, before any claim", async () => {
    expect((await call({ campaign_id: CAMP }, { token: 'jwt-mkt2' })).status).toBe(403);
    expect(db.rpcCalls).toEqual([]);
    expect(db.campaigns[CAMP].status).toBe('scheduled');
  });

  it('a due run needs the service key', async () => {
    expect((await call({ due: true }, { token: 'jwt-admin' })).status).toBe(403);
    expect(db.rpcCalls).toEqual([]);
  });

  it('400 without a campaign id', async () => {
    expect((await call({}, { token: 'jwt-admin' })).status).toBe(400);
  });
});

describe('send-campaign: sending', () => {
  it('marketing sends its own campaign: push with the campaign id, escaped e-mail, counts written', async () => {
    const res = await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: CAMP, status: 'sent', recipient_count: 3, push_sent: 3, email_sent: 2, sent_count: 3 });

    const [pushCall, emailCall] = fetchMock.mock.calls;
    expect(pushCall[0]).toBe('https://example.supabase.co/functions/v1/send-push');
    const pushInit = pushCall[1] as RequestInit;
    expect((pushInit.headers as Record<string, string>).apikey).toBe(SERVICE_KEY);
    expect(JSON.parse(pushInit.body as string)).toEqual({
      user_ids: ['u1', 'u2', 'u3'], title: 'Viaja hoy', body: 'Hola <b>Ana</b>\nVen', category: 'campaign',
      data: { deep_link: 'tricigo://home', content_type: 'campaign', content_id: CAMP },
    });
    expect(emailCall[0]).toBe('https://example.supabase.co/functions/v1/send-bulk-email');
    expect(JSON.parse((emailCall[1] as RequestInit).body as string)).toEqual({
      user_ids: ['u1', 'u2', 'u3'], subject: 'Viaja hoy',
      body_html: '<p>Hola &lt;b&gt;Ana&lt;/b&gt;<br/>Ven</p>', promo_code_id: null,
    });

    expect(lastUpdate(CAMP)).toMatchObject({
      status: 'sent', recipient_count: 3, push_sent: 3, email_sent: 2, sent_count: 3, last_error: null,
    });
    expect(db.campaigns[CAMP].status).toBe('sent');
  });

  it('an admin sends any campaign', async () => {
    expect((await call({ campaign_id: CAMP2 }, { token: 'jwt-admin' })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('409 when the campaign cannot be claimed (already sending, sent, cancelled or not due)', async () => {
    db.claimable = [];
    db.campaigns[CAMP].status = 'sending';
    const res = await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_claimable', status: 'sending' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nobody in the segment: no channel call, sent with zero', async () => {
    db.recipients = [];
    const res = await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastUpdate(CAMP)).toMatchObject({ status: 'sent', recipient_count: 0, sent_count: 0 });
  });

  it('push fails and e-mail works: sent, with the push error noted', async () => {
    pushResponse = new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(lastUpdate(CAMP)).toMatchObject({ status: 'sent', push_sent: 0, email_sent: 2, last_error: 'push: boom' });
  });

  it('every channel fails: failed', async () => {
    pushResponse = new Response('{}', { status: 502 });
    emailResponse = () => {
      throw new Error('network down');
    };
    const res = await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(res.status).toBe(200);
    expect(lastUpdate(CAMP)).toMatchObject({ status: 'failed', sent_count: 0 });
    expect(String(lastUpdate(CAMP)?.last_error)).toContain('email: network down');
  });

  it('the recipients cannot be read: failed, no channel call', async () => {
    db.recipientsError = { message: 'boom' };
    await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastUpdate(CAMP)).toMatchObject({ status: 'failed', last_error: 'recipients: boom' });
  });
});

describe('send-campaign: due runs (cron)', () => {
  it('claims every due campaign, answers 202 and sends them', async () => {
    const res = await call({ due: true }, { internal: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ claimed: [CAMP, CAMP2] });
    expect(db.rpcCalls[0]).toEqual({ fn: 'claim_campaigns', args: { p_campaign_id: null, p_limit: 5 } });
    expect(db.campaigns[CAMP].status).toBe('sent');
    expect(db.campaigns[CAMP2].status).toBe('sent');
  });

  it('nothing due: 202 with nothing claimed', async () => {
    db.claimable = [];
    const res = await call({ due: true }, { internal: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ claimed: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/send-campaign/index.test.ts`
Expected: FAIL, cannot resolve `./index.ts`.

- [ ] **Step 4: Implement `supabase/functions/send-campaign/index.ts`**

```ts
// ============================================================
// supabase/functions/send-campaign/index.ts
//
// The only sender of admin campaigns (00649). Two callers:
//   - the panel, right after inserting a campaign with "Enviar ahora":
//       { campaign_id }   (an admin, or marketing for a campaign its own account created)
//   - the cron job send-due-campaigns (dispatch_due_campaigns), with the service key:
//       { due: true }     claims up to 5 due campaigns, answers 202 at once and sends them in the
//                         background, so pg_net's 30 s timeout never cuts the call.
//
// A campaign is claimed (scheduled -> sending) by claim_campaigns, one statement with
// FOR UPDATE SKIP LOCKED, so the button and the cron never send it twice. The recipients come
// from campaign_recipient_ids (SQL, at send time). Push and e-mail go through the existing
// send-push and send-bulk-email with the service key; their own rules (notification preferences,
// marketing consent, proven addresses) still apply.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { getServiceKey, isServiceKeyToken } from '../_shared/service-key.ts';
import { isAdminRole, isPanelStaffRole } from '../_shared/panel-roles.ts';
import { campaignEmailHtml, campaignOutcome, type ChannelResult } from '../_shared/campaign-send.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const DUE_BATCH = 5;

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

interface Campaign {
  id: string;
  channel: string;
  message_title: string;
  message_body: string;
  promo_code_id: string | null;
  created_by: string | null;
}

// Supabase's background-task API; absent in tests and older runtimes.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

type Client = ReturnType<typeof createClient>;

async function callChannel(
  channel: 'push' | 'email',
  url: string,
  serviceKey: string,
  payload: Record<string, unknown>,
): Promise<ChannelResult> {
  const fn = channel === 'push' ? 'send-push' : 'send-bulk-email';
  try {
    const res = await fetch(`${url}/functions/v1/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as { sent?: number; error?: string };
    if (!res.ok) return { channel, ok: false, sent: 0, error: json.error ?? `HTTP ${res.status}` };
    return { channel, ok: true, sent: Number(json.sent ?? 0) };
  } catch (err) {
    return { channel, ok: false, sent: 0, error: (err as Error).message };
  }
}

async function sendCampaign(client: Client, url: string, serviceKey: string, c: Campaign) {
  const results: ChannelResult[] = [];
  let recipientError: string | undefined;
  let ids: string[] = [];

  const { data, error } = await client.rpc('campaign_recipient_ids', { p_campaign_id: c.id });
  if (error) {
    recipientError = `recipients: ${error.message}`;
  } else {
    ids = Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : [];
  }

  if (!recipientError && ids.length > 0) {
    if (c.channel === 'push' || c.channel === 'both') {
      results.push(await callChannel('push', url, serviceKey, {
        user_ids: ids,
        title: c.message_title,
        body: c.message_body,
        category: 'campaign',
        data: { deep_link: 'tricigo://home', content_type: 'campaign', content_id: c.id },
      }));
    }
    if (c.channel === 'email' || c.channel === 'both') {
      results.push(await callChannel('email', url, serviceKey, {
        user_ids: ids,
        subject: c.message_title,
        body_html: campaignEmailHtml(c.message_body),
        promo_code_id: c.promo_code_id,
      }));
    }
  }

  const outcome = campaignOutcome(results, recipientError);
  const row = {
    status: outcome.status,
    recipient_count: ids.length,
    push_sent: outcome.pushSent,
    email_sent: outcome.emailSent,
    sent_count: outcome.sentCount,
    last_error: outcome.lastError,
    sent_at: new Date().toISOString(),
  };
  const { error: updateError } = await client.from('campaigns').update(row).eq('id', c.id).eq('status', 'sending');
  if (updateError) console.error('[send-campaign] could not record the result', c.id, updateError.message);
  console.info(
    `[send-campaign] ${c.id}: ${outcome.status} recipients=${ids.length} push=${outcome.pushSent} email=${outcome.emailSent}` +
      (outcome.lastError ? ` error=${outcome.lastError}` : ''),
  );
  return { id: c.id, ...row, channels: results };
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const serviceKey = getServiceKey();
    const url = Deno.env.get('SUPABASE_URL')!;
    const client = createClient(url, serviceKey);
    const isInternal = isServiceKeyToken(req.headers.get('apikey') ?? '');

    let callerId: string | null = null;
    let callerRole: string | null = null;
    if (!isInternal) {
      const auth = req.headers.get('Authorization');
      if (!auth?.startsWith('Bearer ')) return json(401, { error: 'Missing authorization header' });
      const { data: { user }, error } = await client.auth.getUser(auth.replace('Bearer ', ''));
      if (error || !user) return json(401, { error: 'Invalid or expired token' });
      const { data: roleRow } = await client.from('users').select('role').eq('id', user.id).single();
      callerRole = (roleRow?.role as string | undefined) ?? null;
      if (!isPanelStaffRole(callerRole)) return json(403, { error: 'Forbidden: panel role required' });
      callerId = user.id;
    }

    const body = (await req.json().catch(() => ({}))) as { due?: unknown; campaign_id?: unknown };

    if (body.due === true) {
      if (!isInternal) return json(403, { error: 'Forbidden: due runs need the service key' });
      const { data, error } = await client.rpc('claim_campaigns', { p_campaign_id: null, p_limit: DUE_BATCH });
      if (error) throw new Error(error.message);
      const claimed = (data ?? []) as Campaign[];
      const work = (async () => {
        for (const c of claimed) await sendCampaign(client, url, serviceKey, c);
      })();
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(work);
      else await work;
      return json(202, { claimed: claimed.map((c) => c.id) });
    }

    const campaignId = typeof body.campaign_id === 'string' ? body.campaign_id : null;
    if (!campaignId) return json(400, { error: 'campaign_id required' });

    if (!isInternal && !isAdminRole(callerRole)) {
      const { data: own } = await client.from('campaigns').select('created_by').eq('id', campaignId).single();
      if (!own || (own as { created_by: string | null }).created_by !== callerId) {
        return json(403, { error: 'Forbidden: not your campaign' });
      }
    }

    const { data, error } = await client.rpc('claim_campaigns', { p_campaign_id: campaignId, p_limit: 1 });
    if (error) throw new Error(error.message);
    const claimed = (data ?? []) as Campaign[];
    if (claimed.length === 0) {
      const { data: row } = await client.from('campaigns').select('status').eq('id', campaignId).single();
      return json(409, { error: 'not_claimable', status: (row as { status?: string } | null)?.status ?? null });
    }
    return json(200, await sendCampaign(client, url, serviceKey, claimed[0]));
  } catch (err) {
    console.error('[send-campaign]', err);
    return json(500, { error: 'internal' });
  }
});
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/send-campaign/index.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 6: Type-check the function without Deno** (CLAUDE.md: `deno check` cannot reach esm.sh from the sandbox)

```bash
mkdir -p /tmp/claude-0/ef-check && cat > /tmp/claude-0/ef-check/deno.d.ts <<'EOF'
declare const Deno: { env: { get(n: string): string | undefined }; serve(h: (r: Request) => Response | Promise<Response>): void };
EOF
cat > /tmp/claude-0/ef-check/tsconfig.json <<EOF
{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext",
  "moduleResolution": "bundler", "allowImportingTsExtensions": true, "skipLibCheck": true, "lib": ["ES2022", "DOM"],
  "paths": { "https://esm.sh/@supabase/supabase-js@2.108.2": ["$PWD/node_modules/@supabase/supabase-js"] } },
  "files": ["/tmp/claude-0/ef-check/deno.d.ts", "$PWD/supabase/functions/send-campaign/index.ts"] }
EOF
npx tsc -p /tmp/claude-0/ef-check/tsconfig.json; echo "tsc exit=$?"
```
Expected: `tsc exit=0`. If supabase-js typing makes `client.rpc` / `from().update()` reject the untyped table, fix with a narrow cast at that call (`client.from('campaigns') as unknown as …` is not acceptable; prefer typing `Client` as `ReturnType<typeof createClient<any>>` only if needed and explain in a comment).

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/send-campaign packages/api/vitest.config.ts supabase/config.toml
git commit -m "feat(campaigns): send-campaign Edge Function, the only campaign sender"
```

---

### Task 7: `campaignService` in `@tricigo/api`

**Files:**
- Create: `packages/api/src/services/campaign.service.ts`
- Test: `packages/api/src/services/__tests__/campaign.test.ts`
- Modify: `packages/api/src/index.ts` (add the export next to `promotionService`)

- [ ] **Step 1: Write the failing tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
const mockInvoke = vi.fn();
const mockSingle = vi.fn();
const mockSelect = vi.fn(() => ({ single: mockSingle }));
const mockInsert = vi.fn(() => ({ select: mockSelect }));
const mockGetUser = vi.fn();

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({
    rpc: mockRpc,
    functions: { invoke: mockInvoke },
    from: () => ({ insert: mockInsert }),
    auth: { getUser: mockGetUser },
  }),
}));

import { campaignService } from '../campaign.service';
import { AppError } from '../../errors';

const INPUT = {
  name: 'Lluvia', audienceRole: 'customer' as const, segmentType: 'all' as const, segmentCityId: null,
  title: 'Llueve', body: 'Pide tu triciclo', promoCodeId: null, channel: 'push' as const,
  scheduledAt: '2026-10-10T14:00:00.000Z',
};

describe('campaignService', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockInvoke.mockReset();
    mockSingle.mockReset();
    mockInsert.mockClear();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u-1' } } });
  });

  it('create inserts the row without status or counters and returns its id', async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: 'c-1' }, error: null });
    await expect(campaignService.create(INPUT)).resolves.toBe('c-1');
    expect(mockInsert).toHaveBeenCalledWith({
      name: 'Lluvia', audience_role: 'customer', segment_type: 'all', segment_city_id: null,
      message_title: 'Llueve', message_body: 'Pide tu triciclo', promo_code_id: null, channel: 'push',
      scheduled_at: '2026-10-10T14:00:00.000Z', created_by: 'u-1',
    });
  });

  it('create throws the database error', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'denied' } });
    await expect(campaignService.create(INPUT)).rejects.toMatchObject({ message: 'denied' });
  });

  it('sendNow calls send-campaign with the id and returns its result', async () => {
    const result = { id: 'c-1', status: 'sent', recipient_count: 3, push_sent: 3, email_sent: 0, sent_count: 3,
      last_error: null, channels: [{ channel: 'push', ok: true, sent: 3 }] };
    mockInvoke.mockResolvedValueOnce({ data: result, error: null });
    await expect(campaignService.sendNow('c-1')).resolves.toEqual(result);
    expect(mockInvoke).toHaveBeenCalledWith('send-campaign', { body: { campaign_id: 'c-1' } });
  });

  it('sendNow turns a 409 into CAMPAIGN_NOT_CLAIMABLE with the current status', async () => {
    const context = new Response(JSON.stringify({ error: 'not_claimable', status: 'sending' }), { status: 409 });
    mockInvoke.mockResolvedValueOnce({ data: null, error: Object.assign(new Error('409'), { context }) });
    const err = await campaignService.sendNow('c-1').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'CAMPAIGN_NOT_CLAIMABLE', statusCode: 409, details: { status: 'sending' } });
  });

  it('sendNow throws any other error as is', async () => {
    const e = new Error('Failed to fetch');
    mockInvoke.mockResolvedValueOnce({ data: null, error: e });
    await expect(campaignService.sendNow('c-1')).rejects.toBe(e);
  });

  it('cancel returns what the RPC returns', async () => {
    mockRpc.mockResolvedValueOnce({ data: 'cancelled', error: null });
    await expect(campaignService.cancel('c-1')).resolves.toBe('cancelled');
    expect(mockRpc).toHaveBeenCalledWith('cancel_campaign', { p_campaign_id: 'c-1' });
    mockRpc.mockResolvedValueOnce({ data: 'sending', error: null });
    await expect(campaignService.cancel('c-1')).resolves.toBe('sending');
  });

  it('cancel turns the forbidden error into CAMPAIGN_CANCEL_FORBIDDEN with the server message', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'Solo puedes cancelar las campañas que creaste.', details: 'campaign_cancel_forbidden' },
    });
    const err = await campaignService.cancel('c-1').catch((e) => e);
    expect(err).toMatchObject({ code: 'CAMPAIGN_CANCEL_FORBIDDEN', statusCode: 400,
      message: 'Solo puedes cancelar las campañas que creaste.' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/campaign.test.ts`
Expected: FAIL, cannot resolve `../campaign.service`.

- [ ] **Step 3: Implement `packages/api/src/services/campaign.service.ts`**

```ts
// ============================================================
// Campaigns (00649). The panel only creates the row; the Edge Function send-campaign sends it,
// right away (sendNow) or when the cron job finds it due.
// ============================================================

import { getSupabaseClient } from '../client';
import { AppError } from '../errors';

export type CampaignChannel = 'push' | 'email' | 'both';
export type CampaignAudience = 'customer' | 'driver';
export type CampaignSegment = 'new_users' | 'power_users' | 'inactive' | 'all' | 'by_city';

export interface NewCampaign {
  name: string;
  audienceRole: CampaignAudience;
  segmentType: CampaignSegment;
  segmentCityId: string | null;
  title: string;
  body: string;
  promoCodeId: string | null;
  channel: CampaignChannel;
  /** UTC ISO instant; null sends as soon as possible. */
  scheduledAt: string | null;
}

export interface CampaignChannelResult {
  channel: 'push' | 'email';
  ok: boolean;
  sent: number;
  error?: string;
}

export interface CampaignSendResult {
  id: string;
  status: 'sent' | 'failed';
  recipient_count: number;
  push_sent: number;
  email_sent: number;
  sent_count: number;
  last_error: string | null;
  channels: CampaignChannelResult[];
}

export const campaignService = {
  /** Inserts the campaign. Status, counters and created_by are set by the server. */
  async create(input: NewCampaign): Promise<string> {
    const supabase = getSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from('campaigns')
      .insert({
        name: input.name,
        audience_role: input.audienceRole,
        segment_type: input.segmentType,
        segment_city_id: input.segmentCityId,
        message_title: input.title,
        message_body: input.body,
        promo_code_id: input.promoCodeId,
        channel: input.channel,
        scheduled_at: input.scheduledAt,
        created_by: user?.id ?? null,
      })
      .select('id')
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  },

  /** Sends a saved campaign now. 409 (already taken by the cron, or not scheduled) → CAMPAIGN_NOT_CLAIMABLE. */
  async sendNow(campaignId: string): Promise<CampaignSendResult> {
    const { data, error } = await getSupabaseClient().functions.invoke('send-campaign', {
      body: { campaign_id: campaignId },
    });
    if (error) {
      const context = (error as { context?: unknown }).context;
      if (context instanceof Response && context.status === 409) {
        const body = (await context.json().catch(() => ({}))) as { status?: string | null };
        throw new AppError('La campaña ya se está enviando o ya no está programada.', 'CAMPAIGN_NOT_CLAIMABLE', 409, {
          status: body.status ?? null,
        });
      }
      throw error;
    }
    return data as CampaignSendResult;
  },

  /** 'cancelled', or the status that prevented it ('sending', 'sent', …), or 'not_found'. */
  async cancel(campaignId: string): Promise<string> {
    const { data, error } = await getSupabaseClient().rpc('cancel_campaign', { p_campaign_id: campaignId });
    if (error) {
      if ((error as { details?: string }).details === 'campaign_cancel_forbidden') {
        // 400, not 403: getErrorMessage turns 401/403 into "session expired".
        throw new AppError(error.message, 'CAMPAIGN_CANCEL_FORBIDDEN', 400);
      }
      throw error;
    }
    return data as string;
  },
};
```

- [ ] **Step 4: Export it** — in `packages/api/src/index.ts`, after the `promotionService` export line add:

```ts
export {
  campaignService,
  type NewCampaign,
  type CampaignChannel,
  type CampaignAudience,
  type CampaignSegment,
  type CampaignSendResult,
  type CampaignChannelResult,
} from './services/campaign.service';
```

- [ ] **Step 5: Run the tests and the type check**

```bash
pnpm --filter @tricigo/api exec vitest run src/services/__tests__/campaign.test.ts
pnpm --filter @tricigo/api check-types
```
Expected: 7 tests PASS; check-types exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/services/campaign.service.ts packages/api/src/services/__tests__/campaign.test.ts packages/api/src/index.ts
git commit -m "feat(api): campaignService to create, send and cancel campaigns"
```

---

### Task 8: Status registry and i18n keys

**Files:**
- Modify: `apps/admin/src/lib/status-registry.ts` (the `campaign:` block)
- Modify: `packages/i18n/src/locales/es/admin.json`, `en/admin.json`, `pt/admin.json`

- [ ] **Step 1: Add the two statuses** — in the `campaign:` block of `apps/admin/src/lib/status-registry.ts`, after the `scheduled:` line add:

```ts
    sending: { label: 'Enviando', i18nKey: 'status_registry.campaign.sending', tone: 'info', icon: Clock },
```
and after the `sent:` line add:
```ts
    failed: { label: 'Falló', i18nKey: 'status_registry.campaign.failed', tone: 'danger', icon: XCircle },
```

- [ ] **Step 2: Add the keys with a script** (keeps the files' formatting: 2-space JSON, UTF-8, trailing newline — check `git diff` afterwards and match the existing style if it differs)

```bash
node - <<'EOF'
const fs = require('fs');
const add = {
  es: {
    campaigns: {
      field_schedule_havana: 'Programar para (hora de Cuba)',
      schedule_required: 'Elige la fecha y la hora',
      col_scheduled: 'Programada para',
      cancel_btn: 'Cancelar',
      cancel_title: 'Cancelar campaña',
      cancel_confirm: 'La campaña «{{name}}» no se va a enviar. ¿La cancelas?',
      toast_cancelled: 'Campaña cancelada',
      toast_cancel_late: 'Ya no se puede cancelar: el envío ya empezó o terminó.',
      toast_scheduled_at: 'Campaña programada para el {{when}} (hora de Cuba)',
      toast_already_sending: 'La campaña ya se está enviando. Revisa el estado en la lista.',
      warn_send_failed: 'Guardada, pero el envío no respondió: {{error}}. Revisa el estado en la lista.',
    },
    status_registry: { campaign: { sending: 'Enviando', failed: 'Falló' } },
  },
  en: {
    campaigns: {
      field_schedule_havana: 'Schedule for (Cuba time)',
      schedule_required: 'Choose the date and time',
      col_scheduled: 'Scheduled for',
      cancel_btn: 'Cancel',
      cancel_title: 'Cancel campaign',
      cancel_confirm: 'The campaign "{{name}}" will not be sent. Cancel it?',
      toast_cancelled: 'Campaign cancelled',
      toast_cancel_late: 'It can no longer be cancelled: sending has started or finished.',
      toast_scheduled_at: 'Campaign scheduled for {{when}} (Cuba time)',
      toast_already_sending: 'The campaign is already being sent. Check its status in the list.',
      warn_send_failed: 'Saved, but sending did not respond: {{error}}. Check its status in the list.',
    },
    status_registry: { campaign: { sending: 'Sending', failed: 'Failed' } },
  },
  pt: {
    campaigns: {
      field_schedule_havana: 'Agendar para (horário de Cuba)',
      schedule_required: 'Escolha a data e a hora',
      col_scheduled: 'Agendada para',
      cancel_btn: 'Cancelar',
      cancel_title: 'Cancelar campanha',
      cancel_confirm: 'A campanha «{{name}}» não será enviada. Cancelar?',
      toast_cancelled: 'Campanha cancelada',
      toast_cancel_late: 'Não pode mais ser cancelada: o envio já começou ou terminou.',
      toast_scheduled_at: 'Campanha agendada para {{when}} (horário de Cuba)',
      toast_already_sending: 'A campanha já está sendo enviada. Confira o status na lista.',
      warn_send_failed: 'Salva, mas o envio não respondeu: {{error}}. Confira o status na lista.',
    },
    status_registry: { campaign: { sending: 'Enviando', failed: 'Falhou' } },
  },
};
for (const [lang, groups] of Object.entries(add)) {
  const file = `packages/i18n/src/locales/${lang}/admin.json`;
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(json.campaigns, groups.campaigns);
  json.status_registry = json.status_registry ?? {};
  json.status_registry.campaign = { ...(json.status_registry.campaign ?? {}), ...groups.status_registry.campaign };
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}
EOF
git diff --stat packages/i18n
```
Expected: three files changed, only additions (if the diff reformats unrelated lines, revert and add the keys by hand instead).

- [ ] **Step 3: Run the i18n checks**

```bash
pnpm check:i18n
pnpm --filter @tricigo/utils exec vitest run src/__tests__/copyTuteo.test.ts src/__tests__/copyAccents.test.ts
```
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/lib/status-registry.ts packages/i18n/src/locales
git commit -m "feat(admin): campaign statuses sending and failed, copy for scheduling and cancelling"
```

---

### Task 9: Campaigns page

**Files:**
- Modify: `apps/admin/src/app/campaigns/page.tsx`

- [ ] **Step 1: Imports** — replace the import block at the top (lines 1–13) with:

```tsx
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Megaphone, Plus, X } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, campaignService, AppError, type CampaignSendResult } from '@tricigo/api';
import { cityService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { havanaLocalToUtcIso } from '@tricigo/utils/date';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { StatusBadge } from '@/components/data/StatusBadge';
import { formatAdminDate } from '@/lib/formatDate';
import { usePanelRole } from '@/lib/panelRole';
```
Check first that `AppError` is exported from `@tricigo/api` (`grep -n "AppError" packages/api/src/index.ts`); if not, import it from where other admin pages do.

- [ ] **Step 2: Campaign type** — add these fields to the `Campaign` type after `audience_role?`:

```tsx
  // mig 00649
  started_at?: string | null;
  recipient_count?: number;
  push_sent?: number;
  email_sent?: number;
  last_error?: string | null;
```

- [ ] **Step 3: State** — after `const [promotions, setPromotions] = useState<Promotion[]>([]);` add:

```tsx
  const { role } = usePanelRole();
  const isAdminRole = role === 'admin' || role === 'super_admin';
  const [myId, setMyId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Campaign | null>(null);

  useEffect(() => {
    void getSupabaseClient().auth.getUser().then(({ data }) => setMyId(data.user?.id ?? null));
  }, []);
```

- [ ] **Step 4: Silent reload and refresh while something is pending** — replace `loadCampaigns` and its effect with:

```tsx
  const loadCampaigns = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const supabase = getSupabaseClient();
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data, error: dbError } = await supabase
        .from('campaigns')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, to);
      if (dbError) throw dbError;
      setCampaigns((data ?? []) as Campaign[]);
    } catch (err) {
      if (!silent) {
        setCampaigns([]);
        setError(getErrorMessage(err));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  // A scheduled or sending campaign changes on the server: refresh the list every 30 s meanwhile.
  const hasPending = campaigns.some((c) => c.status === 'scheduled' || c.status === 'sending');
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => void loadCampaigns(true), 30_000);
    return () => clearInterval(timer);
  }, [hasPending, loadCampaigns]);
```
Then update the DataTable `onRetry` to `onRetry={() => void loadCampaigns()}` (unchanged signature works).

- [ ] **Step 5: Remove the browser send path** — delete the whole `getActiveUserIdsSince` and `getSegmentUserIds` functions (from the comment `// Which user_ids have ridden/driven recently?` through the end of `getSegmentUserIds`).

- [ ] **Step 6: Validation** — replace the schedule part of `validateForm`:

```tsx
    if (!formSendNow) {
      if (!formSchedule) {
        errors.schedule = t('campaigns.schedule_required', { defaultValue: 'Elige la fecha y la hora' });
      } else if (new Date(havanaLocalToUtcIso(formSchedule)) <= new Date()) {
        errors.schedule = t('campaigns.future_error', { defaultValue: 'Tiene que ser en el futuro' });
      }
    }
```

- [ ] **Step 7: Send handler** — replace the whole `handleSend` with:

```tsx
  // The warnings the old browser send showed, now from send-campaign's per-channel result.
  const warningsFor = (r: CampaignSendResult): string[] => {
    const w: string[] = [];
    if (r.recipient_count === 0) {
      w.push(t('campaigns.warn_no_recipients', { defaultValue: 'El segmento no tiene usuarios; no se envió nada.' }));
      return w;
    }
    for (const ch of r.channels) {
      if (ch.channel === 'push' && !ch.ok) {
        w.push(t('campaigns.warn_push_failed', { defaultValue: 'Guardada, pero falló el envío de push: {{error}}', error: ch.error ?? '' }));
      } else if (ch.channel === 'push' && ch.sent === 0) {
        w.push(t('campaigns.warn_push_zero', { defaultValue: 'Guardada, pero el push no llegó a ningún dispositivo (sin tokens activos).' }));
      } else if (ch.channel === 'email' && !ch.ok) {
        w.push(t('campaigns.warn_email_failed', { defaultValue: 'Guardada, pero falló el envío de correo: {{error}}', error: ch.error ?? '' }));
      } else if (ch.channel === 'email' && ch.sent === 0) {
        w.push(t('campaigns.warn_email_zero_consent', { defaultValue: 'Guardada, pero el correo no se entregó: nadie del segmento tiene un correo válido y aceptó recibir novedades.' }));
      }
    }
    return w;
  };

  const handleSend = async () => {
    if (!validateForm()) return;
    setSending(true);
    try {
      const scheduledAt = formSendNow ? null : havanaLocalToUtcIso(formSchedule);
      const id = await campaignService.create({
        name: formName,
        audienceRole: formAudience,
        segmentType: formSegment as 'new_users' | 'power_users' | 'inactive' | 'all' | 'by_city',
        segmentCityId: formSegment === 'by_city' ? formCityId : null,
        title: formTitle,
        body: formBody,
        promoCodeId: formPromoId || null,
        channel: formChannel as 'push' | 'email' | 'both',
        scheduledAt,
      });

      resetForm();
      setShowForm(false);
      setPage(0);

      if (scheduledAt) {
        await loadCampaigns();
        showToast('success', t('campaigns.toast_scheduled_at', {
          defaultValue: 'Campaña programada para el {{when}} (hora de Cuba)',
          when: formatAdminDate(scheduledAt),
        }));
        return;
      }

      try {
        const result = await campaignService.sendNow(id);
        const warnings = warningsFor(result);
        await loadCampaigns();
        if (warnings.length > 0) showToast('warning', warnings.join(' · '));
        else showToast('success', t('campaigns.toast_sent_n', { n: result.sent_count, defaultValue: 'Campaña enviada · {{n}} entregas' }));
      } catch (err) {
        await loadCampaigns();
        if (err instanceof AppError && err.code === 'CAMPAIGN_NOT_CLAIMABLE') {
          showToast('warning', t('campaigns.toast_already_sending', { defaultValue: 'La campaña ya se está enviando. Revisa el estado en la lista.' }));
        } else {
          showToast('warning', t('campaigns.warn_send_failed', {
            defaultValue: 'Guardada, pero el envío no respondió: {{error}}. Revisa el estado en la lista.',
            error: getErrorMessage(err),
          }));
        }
      }
    } catch (err) {
      showToast('error', getErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const handleCancel = async (c: Campaign) => {
    try {
      const outcome = await campaignService.cancel(c.id);
      if (outcome === 'cancelled') showToast('success', t('campaigns.toast_cancelled', { defaultValue: 'Campaña cancelada' }));
      else showToast('warning', t('campaigns.toast_cancel_late', { defaultValue: 'Ya no se puede cancelar: el envío ya empezó o terminó.' }));
    } catch (err) {
      showToast('error', getErrorMessage(err));
    } finally {
      await loadCampaigns();
    }
  };

  const canCancel = (c: Campaign) => c.status === 'scheduled' && (isAdminRole || (!!myId && c.created_by === myId));
```

- [ ] **Step 8: Columns** — in `columns`:
  1. Replace the `status` column's `cell` with:
     ```tsx
        cell: (c) => (
          <span title={c.last_error ?? undefined}>
            <StatusBadge domain="campaign" status={c.status} />
          </span>
        ),
     ```
  2. Insert before the `sent_count` column:
     ```tsx
      {
        id: 'scheduled_at',
        header: t('campaigns.col_scheduled', { defaultValue: 'Programada para' }),
        cell: (c) => <span className="text-ink-muted">{formatAdminDate(c.scheduled_at)}</span>,
        hideBelow: 'lg',
        width: '170px',
      },
     ```
  3. Append after the `created_at` column:
     ```tsx
      {
        id: 'actions',
        header: '',
        cell: (c) =>
          canCancel(c) ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCancelTarget(c);
              }}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-500/10 dark:text-red-400"
            >
              {t('campaigns.cancel_btn', { defaultValue: 'Cancelar' })}
            </button>
          ) : null,
        align: 'right',
        width: '100px',
        hideInCard: false,
      },
     ```
  4. Change the `useMemo` dependency list from `[t]` to `[t, myId, isAdminRole]` and keep the eslint comment.

- [ ] **Step 9: Schedule field label** — in the form, change the schedule `FormField` label to:
```tsx
<FormField label={t('campaigns.field_schedule_havana', { defaultValue: 'Programar para (hora de Cuba)' })} required error={formErrors.schedule}>
```

- [ ] **Step 10: Cancel confirmation** — right after the closing `/>` of `<DataTable<Campaign> … />` add:

```tsx
      <AdminConfirmModal
        open={!!cancelTarget}
        title={t('campaigns.cancel_title', { defaultValue: 'Cancelar campaña' })}
        message={t('campaigns.cancel_confirm', {
          defaultValue: 'La campaña «{{name}}» no se va a enviar. ¿La cancelas?',
          name: cancelTarget?.name ?? '',
        })}
        variant="danger"
        onConfirm={async () => {
          if (cancelTarget) {
            const target = cancelTarget;
            setCancelTarget(null);
            await handleCancel(target);
          }
        }}
        onCancel={() => setCancelTarget(null)}
      />
```

- [ ] **Step 11: Clean up and check** — remove now-unused imports and variables (`notificationService` is gone from the imports already; `getErrorMessage` and `useMemo` stay). Then:

```bash
pnpm --filter @tricigo/admin check-types
pnpm --filter @tricigo/admin lint
grep -n "send-bulk-email\|sendCampaignPush\|getSegmentUserIds" apps/admin/src/app/campaigns/page.tsx
```
Expected: check-types 0 errors; lint 0 errors (warnings no more than before); the grep prints nothing.

- [ ] **Step 12: Commit**

```bash
git add apps/admin/src/app/campaigns/page.tsx
git commit -m "feat(admin): campaigns are sent by the server, scheduled in Havana time and cancellable"
```

---

### Task 10: Docs, full verification and push

**Files:**
- Modify: `CLAUDE.md` (new subsection right after "Rol `marketing` en el panel admin (00641/00642, PR #1115)")

- [ ] **Step 1: Add the CLAUDE.md subsection** (Spanish, like the rest of that file)

```markdown
### Campañas: las manda el servidor, ahora o a la hora elegida (00649)

Hasta 00649, "Programar para" guardaba la campaña como `scheduled` y nada la mandaba nunca; "Enviar ahora" corría en el navegador. Ahora el panel solo inserta la campaña y la manda la Edge Function `send-campaign`:

- **"Enviar ahora"** inserta y llama a `send-campaign` con el id. **"Programar"** inserta con `scheduled_at` (la hora elegida es hora de Cuba: `havanaLocalToUtcIso`), y el cron `send-due-campaigns` (cada minuto, `dispatch_due_campaigns()`) llama a `send-campaign` con `{due: true}` solo si hay alguna vencida.
- **Estados:** `scheduled → sending → sent | failed`, `scheduled → cancelled`. `claim_campaigns` toma la campaña con `FOR UPDATE SKIP LOCKED`: el botón y el cron nunca la mandan dos veces. Una `sending` de más de 15 minutos pasa a `failed` con `last_error = 'interrupted'` y no se reintenta.
- **Destinatarios:** `campaign_recipient_ids` (SQL, al momento del envío, sin cuentas bloqueadas). Devuelve un array y no un conjunto: PostgREST corta los conjuntos en 1000 filas.
- **Insert de cliente:** `trg_campaigns_client_insert` fuerza `scheduled`, contadores en 0 y `created_by`. Excepción legacy: un insert con `status = 'sent'` se guarda tal cual, porque una pestaña vieja del panel ya la mandó desde el navegador. `authenticated` no tiene UPDATE sobre `campaigns`: cancelar es `cancel_campaign` (admin cualquiera, marketing solo las suyas).
- **Diagnóstico:** `SELECT id, name, status, scheduled_at, started_at, recipient_count, push_sent, email_sent, last_error FROM campaigns ORDER BY created_at DESC LIMIT 10;` y, para el cron, `cron_http_calls` con `jobname = 'send-due-campaigns'`. Los logs de la función dicen `[send-campaign] <id>: <status> recipients=… push=… email=…`.
- **Límite:** `send-bulk-email` manda de a uno con 50 ms entre correos; una campaña de correo de más de ~2000 destinatarios puede pasar el tiempo máximo de la función.
```

- [ ] **Step 2: Full repo checks**

```bash
pnpm check-types
pnpm --filter @tricigo/admin lint
pnpm --filter @tricigo/api exec vitest run
pnpm --filter @tricigo/utils exec vitest run
pnpm check:i18n && pnpm check:migration-grants && pnpm check:ef-imports
supabase/tests/00649/run.sh supabase/migrations/00649_scheduled_campaigns.sql | tail -1
supabase/tests/00649/run.sh none | tail -1
```
Expected: everything passes; GREEN shows `FAIL=0`; RED shows `FAIL` > 0. Record both summary lines for the PR body.

- [ ] **Step 3: Admin build with the middleware**

```bash
cd apps/admin && NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=x npx next build 2>&1 | tail -30; cd -
```
Expected: build succeeds and lists `ƒ Middleware`.

- [ ] **Step 4: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: how campaigns are sent and diagnosed (00649)"
git fetch -q origin master && git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | grep -c '^00649' || true
git push -u origin claude/hopeful-shannon-g3theu
```
Expected: the grep counts 0 (nobody else took 00649 on master meanwhile); the push succeeds.

---

## Out of scope (from the spec)

Editing a scheduled campaign, retrying failed ones, open/click tracking, and the promotions page date inputs.
