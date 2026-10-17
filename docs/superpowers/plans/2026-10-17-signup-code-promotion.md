# Signup Code Promotions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person who registered with a signup code (MOTORENKO) that marketing linked to a promotion gets that promotion on their next ride without typing anything.

**Architecture:** Migration 00665 adds `acquisition_codes.promotion_id` and a BEFORE INSERT trigger on `rides` that fills in `promo_code_id` before the existing promo validator runs, so every eligibility rule stays in one place. A read RPC lets the apps show the discount before booking, and the stats RPC gains the link and its use. The panel links promotions to codes; the passenger app and the web prefill and validate the code automatically.

**Tech Stack:** Postgres 16/17 (plpgsql), Supabase PostgREST, TypeScript (`@tricigo/api`, `@tricigo/utils`), Next.js 15 (admin, web), Expo React Native (client), vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-signup-code-promotion-design.md`.

---

## Facts read from prod on 2026-10-17 (do not re-derive)

| Object | Live state |
|---|---|
| `tg_rides_validate_promo_discount()` | md5 `cad4cf62d95e5055950b67564c6da7f4`, 9664 chars, SECURITY DEFINER, EXECUTE only `service_role` (trigger functions are not EXECUTE-checked when they fire) |
| `admin_signup_code_stats()` | md5 `16a8ed1ebe03aa82f2f75676783a9099`, 1119 chars, 12 columns, gate `is_admin() OR is_marketing()`, EXECUTE `authenticated`, `service_role` |
| BEFORE INSERT row triggers on `rides` (name order) | `rides_enforce_active_city, rides_normalize_scheduling, rides_scheduled_limit, rides_sync_coords_trg, rides_validate_promo_discount, trg_…`. `rides_signup_promo` sorts between `rides_scheduled_limit` and `rides_sync_coords_trg`, before the validator |
| `rides.ride_mode` | `text`, default `'passenger'`, values `cargo`, `passenger` |
| `promotions.valid_from` | NOT NULL; `type` is enum `promotion_type` |
| `acquisition_codes` | 0 rows; policies `acquisition_codes_admin_all` and `acquisition_codes_all_marketing`; `authenticated` has all table privileges |
| `users.signup_code` | 0 users have one |
| `promotions` | 4 rows, 2 active |
| `user_role` enum | `customer, driver, admin, super_admin, marketing` |
| Latest migration in master | 00664; open PRs hold 00662 (#1160) and 00569 (#965). **Re-check before writing the file** (CLAUDE.md § "Pre-flight para elegir número de migración") |

**Why the trigger function is SECURITY INVOKER.** Inside a SECURITY DEFINER function `current_user` is always the owner, so `current_user IN ('anon','authenticated')` would never be true (CLAUDE.md § "`current_user` no sirve para saber quién llamó a una SECURITY DEFINER"). The trigger runs as the client and calls `_my_signup_promotion_id()` (SECURITY DEFINER, no arguments) for the one lookup a client cannot do itself.

**Local Postgres on this Windows PC.** No PostGIS, so the 00665 rehearsal has its own scaffold with text columns instead of `geography` and two stubs. Binaries: `<scratchpad>/pg-download/pg16.zip` (EnterpriseDB portable 16.14). Windows deletes files in the scratchpad Temp folder during long sessions; re-extract when `psql.exe` is missing.

```bash
S="C:/Users/Eduardo/AppData/Local/Temp/claude/C--Users-Eduardo-TriciGo--claude-worktrees-tricigo-1-8-0-eas-builds-519e4a/d9bb53f8-6b66-48c9-8499-e25a93612e97/scratchpad"
[ -x "$S/pgsql/bin/psql.exe" ] || (cd "$S" && tar.exe -xf pg-download/pg16.zip pgsql/bin pgsql/lib pgsql/share)
netstat -ano | grep LISTENING | grep -E ':54[0-9]{2} '      # pick a port NOT in this list, e.g. 5465
[ -d "$S/pgdata665" ] || "$S/pgsql/bin/initdb" -D "$S/pgdata665" -U pgtest -A trust -E UTF8 --no-locale
"$S/pgsql/bin/pg_ctl" -D "$S/pgdata665" -o "-p 5465 -c listen_addresses=127.0.0.1" -l "$S/pg665.log" -w start
```

`pg_ctl start` does not return (postgres inherits the pipe): run it with `run_in_background`, then confirm with `"$S/pgsql/bin/pg_ctl" -D "$S/pgdata665" status` and that the PID listening on 5465 is the first line of `$S/pgdata665/postmaster.pid`. Every `run.sh` call below is:

```bash
PGBIN="$S/pgsql/bin" PGPORT=5465 bash supabase/tests/00665/run.sh <none | supabase/migrations/00665_signup_code_promotion.sql>
```

## File structure

| File | Responsibility |
|---|---|
| `supabase/tests/00665/live-bodies.sql` (new, generated) | The 13 live function bodies and their EXECUTE grants, read from prod |
| `supabase/tests/00665/scaffold.sql` (new) | Roles, tables, policies, stubs and seeds the rehearsal needs; includes `live-bodies.sql` |
| `supabase/tests/00665/run.sh` (new) | RED/GREEN rehearsal, idempotency, CRLF copy, negative proofs |
| `supabase/migrations/00665_signup_code_promotion.sql` (new) | Column, lookup, trigger, read RPC, stats RPC, self-checks |
| `packages/utils/src/signupPromo.ts` (new) + test | Pure rules: prefill, auto-validate/clear, label check, promotion status |
| `packages/api/src/services/acquisition-code.service.ts` + test | `promotionId` on create, `setPromotion`, new stats fields |
| `packages/api/src/services/ride.service.ts` + `__tests__/ride.test.ts` | `getMySignupPromotion()` |
| `apps/admin/src/app/code-performance/page.tsx` | Promotion select in the form and in each row, "Usaron el descuento" |
| `apps/client/src/stores/ride.store.ts`, `apps/client/src/hooks/useSignupPromotion.ts` (new), `apps/client/app/(tabs)/index.tsx` | Prefill, auto-validate, label |
| `apps/web/src/app/book/page.tsx` | Same on the web |
| `packages/i18n/src/locales/{es,en,pt}/{rider,web}.json` | One label each |
| `CLAUDE.md` | New section |

---

### Task 1: Capture the live bodies (controller only: needs the Supabase MCP)

**Files:**
- Create: `supabase/tests/00665/live-bodies.sql`
- Create (scratchpad, not committed): `$S/extract_live665.py`

- [ ] **Step 1: Run the capture query with `mcp__…__execute_sql`.** The `pad` makes the tool save the answer to a file; note that file's path.

```sql
SELECT json_build_object('fns', json_agg(json_build_object(
  'sig', p.oid::regprocedure::text,
  'def', pg_get_functiondef(p.oid),
  'md5', md5(p.prosrc),
  'grantees', (SELECT coalesce(json_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END), '[]'::json)
                 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner)
) ORDER BY p.proname), 'pad', repeat('#', 150000))::text AS j
FROM pg_proc p
WHERE p.oid IN ('auth.uid()'::regprocedure, 'public.current_user_role()'::regprocedure,
  'public.is_admin()'::regprocedure, 'public.is_super_admin()'::regprocedure, 'public.is_marketing()'::regprocedure,
  'public.get_platform_config_numeric(text, numeric)'::regprocedure,
  'public.tg_rides_validate_promo_discount()'::regprocedure, 'public.tg_rides_rollback_promo_on_cancel()'::regprocedure,
  'public._reward_identity_hash(uuid)'::regprocedure, 'public._reward_claim_status(uuid, text)'::regprocedure,
  'public._claim_reward(uuid, text, uuid, uuid)'::regprocedure, 'public.admin_signup_code_stats()'::regprocedure,
  'public.validate_promo_code(text, uuid, integer)'::regprocedure);
```

- [ ] **Step 2: Write `$S/extract_live665.py`:**

```python
# python -I extract_live665.py <saved MCP result file> <out live-bodies.sql>
import json, re, sys

raw = open(sys.argv[1], encoding='utf-8').read()
try:
    outer = json.loads(raw)
    text = outer['result'] if isinstance(outer, dict) else str(outer)
except json.JSONDecodeError:
    text = raw
m = re.search(r'<untrusted-data-[^>]+>\s*(\[.*\])\s*</untrusted-data', text, re.S)
assert m, 'no rows in the MCP result'
fns = json.loads(json.loads(m.group(1))[0]['j'])['fns']
assert len(fns) == 13, len(fns)

ALLOWED = {'PUBLIC', 'anon', 'authenticated', 'service_role'}
out = ['-- LIVE bodies and EXECUTE grants read from prod on 2026-10-17 for the 00665 rehearsal.',
       '-- Generated (plan 2026-10-17-signup-code-promotion, Task 1). Do not edit: run.sh S0 checks every md5.', '']
for f in fns:
    name = f['sig'].split('(')[0]
    sig = f['sig'] if '.' in name else 'public.' + f['sig']
    out.append(f['def'].replace('\r', '').rstrip() + ';')
    out.append(f'REVOKE ALL ON FUNCTION {sig} FROM PUBLIC;')
    for g in sorted(set(f['grantees']) & ALLOWED):
        out.append(f'GRANT EXECUTE ON FUNCTION {sig} TO {g};')
    out.append('')
open(sys.argv[2], 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
print('\n'.join(f"{f['sig']} {f['md5']}" for f in fns))
```

- [ ] **Step 3: Run it and compare the printed md5s with this list** (all 13 must match):

```bash
python -I "$S/extract_live665.py" "<saved file>" supabase/tests/00665/live-bodies.sql
```

```
_claim_reward(uuid,text,uuid,uuid)            d9a8726c2f105908c0df7fe8c59b2982
_reward_claim_status(uuid,text)               73d57eecb3631f0db8d1bc9d7a71fb30
_reward_identity_hash(uuid)                   4f1942d94b70a77d6b5007d776f5b425
admin_signup_code_stats()                     16a8ed1ebe03aa82f2f75676783a9099
current_user_role()                           cb4a7c12d4e21fe2997135833f141e25
get_platform_config_numeric(text,numeric)     13d2587037eca74854cf2394ba42a90c
is_admin()                                    22cb75e91980d512498034cd33e1eda2
is_marketing()                                1903156b6a1218a543888ae2ebfb3656
is_super_admin()                              5655a4615e92e8b1e323d06c7566b058
tg_rides_rollback_promo_on_cancel()           0fd8994f3d1dd121e5168ff58ab0fdbc
tg_rides_validate_promo_discount()            cad4cf62d95e5055950b67564c6da7f4
auth.uid()                                    cdef18c69c4f4cbbced2eaf81e628b49
validate_promo_code(text,uuid,integer)        952805817a1ea73ab0fbb93f28884a30
```

If a md5 differs, stop: prod changed since this plan was written, and Task 3's guards and this table need the new values.

- [ ] **Step 4: Check the file has no `\r` and is LF:** `tr -cd '\r' < supabase/tests/00665/live-bodies.sql | wc -c` prints `0`.

---

### Task 2: Rehearsal scaffold and runner (RED)

> **Superseded (2026-10-17):** the committed `supabase/tests/00665/scaffold.sql` and `run.sh` replace the blocks below. Two review rounds added tests (A10–A25, M1–M18, S6b, N5–N9) and changed helpers. Read the files, not this text.

**Files:**
- Create: `supabase/tests/00665/scaffold.sql`
- Create: `supabase/tests/00665/run.sh`

- [ ] **Step 1: Write `supabase/tests/00665/scaffold.sql`:**

```sql
-- Scaffold for the 00665 rehearsal (local Postgres 16, no PostGIS needed).
-- The tables and columns the promo validator, the cancel rollback,
-- get_my_signup_promotion() and admin_signup_code_stats() read, with the LIVE
-- bodies and EXECUTE grants read from prod on 2026-10-17 (live-bodies.sql;
-- run.sh S0 checks every md5). PostGIS is replaced by text columns and two
-- stubs: the validator only calls ST_DWithin / ST_Distance in its partner-place
-- query, and the rehearsal has no partner places. A NON-superuser role (prod:
-- postgres) owns everything; run.sh applies the migration as that role. Like
-- prod, new functions in public get EXECUTE for anon, authenticated and
-- service_role by default (set at the end, so the live grants stay as read).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  phone text UNIQUE,
  phone_confirmed_at timestamptz
);

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.promotion_type AS ENUM ('percentage_discount', 'fixed_discount', 'bonus_credit');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text,
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.users TO anon, authenticated;
GRANT ALL ON public.users TO service_role;

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'approved'
);
CREATE TABLE public.service_type_configs (slug text PRIMARY KEY, max_passengers integer NOT NULL DEFAULT 4);

CREATE TABLE public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  type public.promotion_type NOT NULL,
  discount_percent numeric,
  discount_fixed_cup integer,
  is_active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now() - interval '1 day',
  valid_until timestamptz,
  max_uses integer,
  current_uses integer NOT NULL DEFAULT 0,
  first_ride_only boolean NOT NULL DEFAULT false
);
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.corporate_accounts (id uuid PRIMARY KEY, commission_percent numeric);
CREATE TABLE public.partner_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_active boolean NOT NULL DEFAULT true,
  valid_until timestamptz,
  location text NOT NULL,
  radius_m integer NOT NULL,
  discount_percent numeric NOT NULL
);
CREATE TABLE public.admin_promo_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id uuid, ride_id uuid, customer_id uuid, promo_code_id uuid,
  discount_amount_cup_supplied integer, estimated_fare_cup integer, notes text
);

-- rides: the columns the triggers read; locations as text (no PostGIS).
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status NOT NULL DEFAULT 'searching',
  service_type text NOT NULL REFERENCES public.service_type_configs(slug),
  ride_mode text NOT NULL DEFAULT 'passenger',
  pickup_location text NOT NULL,
  dropoff_location text NOT NULL,
  estimated_fare_cup integer NOT NULL DEFAULT 0 CHECK (estimated_fare_cup >= 0),
  surge_multiplier numeric NOT NULL DEFAULT 1,
  promo_code_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL,
  discount_amount_cup integer NOT NULL DEFAULT 0,
  shared_ride boolean NOT NULL DEFAULT false,
  shared_ride_seats_occupied integer,
  shared_ride_discount_cup integer NOT NULL DEFAULT 0,
  partner_place_id uuid,
  partner_discount_cup integer NOT NULL DEFAULT 0,
  corporate_account_id uuid
);
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.rides TO authenticated;
GRANT ALL ON public.rides TO service_role;

CREATE TABLE public.ride_pricing_snapshots (
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  snapshot_type text NOT NULL,
  total integer,
  pre_waypoints_total integer,
  surge_multiplier numeric,
  UNIQUE (ride_id, snapshot_type)
);
ALTER TABLE public.ride_pricing_snapshots ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.promotion_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  ride_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX promotion_uses_promotion_id_user_id_key ON public.promotion_uses USING btree (promotion_id, user_id)
  WHERE (user_id <> '00000000-0000-0000-0000-000000000099'::uuid);
ALTER TABLE public.promotion_uses ENABLE ROW LEVEL SECURITY;

-- 00658: salt and claims (lock tables).
CREATE TABLE public.reward_identity_salt (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  salt text NOT NULL
);
ALTER TABLE public.reward_identity_salt ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.reward_claims (
  identity_hash text NOT NULL,
  claim text NOT NULL,
  user_id uuid NOT NULL,
  ride_id uuid,
  referral_id uuid,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  PRIMARY KEY (identity_hash, claim)
);
ALTER TABLE public.reward_claims ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reward_identity_salt, public.reward_claims TO service_role;

-- 00619: acquisition codes (LIVE columns and grants) and users.signup_code.
CREATE TABLE public.acquisition_codes (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9-]{3,24}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  channel text NOT NULL CHECK (channel IN ('influencer', 'ugc', 'bolsas', 'pantallas', 'grupos', 'medios', 'otro')),
  audience text NOT NULL DEFAULT 'ambos' CHECK (audience IN ('pasajeros', 'choferes', 'ambos')),
  is_active boolean NOT NULL DEFAULT true,
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL
);
ALTER TABLE public.acquisition_codes ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.acquisition_codes TO authenticated, service_role;
ALTER TABLE public.users ADD COLUMN signup_code text REFERENCES public.acquisition_codes(code) ON UPDATE CASCADE;

-- LIVE function bodies and EXECUTE grants.
\ir live-bodies.sql

-- Policies (after auth.uid(), is_admin() and is_marketing() exist).
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());
CREATE POLICY rides_insert_own ON public.rides FOR INSERT WITH CHECK (customer_id = auth.uid());
CREATE POLICY rides_select_own ON public.rides FOR SELECT USING (customer_id = auth.uid() OR is_admin());
CREATE POLICY acquisition_codes_admin_all ON public.acquisition_codes FOR ALL TO authenticated
  USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
CREATE POLICY acquisition_codes_all_marketing ON public.acquisition_codes FOR ALL TO authenticated
  USING ((SELECT public.is_marketing())) WITH CHECK ((SELECT public.is_marketing()));

-- PostGIS stubs: no partner place ever matches.
CREATE FUNCTION public.st_dwithin(text, text, integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT false';
CREATE FUNCTION public.st_distance(text, text) RETURNS double precision LANGUAGE sql IMMUTABLE AS 'SELECT 0::double precision';

-- Simplified estimate snapshot (prod: tg_rides_create_estimate_snapshot):
-- the contract is total = the estimated fare the insert left.
CREATE FUNCTION public.tg_rides_create_estimate_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO ride_pricing_snapshots (ride_id, snapshot_type, total, surge_multiplier)
  VALUES (NEW.id, 'estimate', NEW.estimated_fare_cup, NEW.surge_multiplier)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$function$;

-- LIVE trigger definitions.
CREATE TRIGGER rides_create_estimate_snapshot AFTER INSERT ON public.rides FOR EACH ROW EXECUTE FUNCTION tg_rides_create_estimate_snapshot();
CREATE TRIGGER rides_validate_promo_discount BEFORE INSERT OR UPDATE OF promo_code_id, discount_amount_cup, shared_ride, shared_ride_seats_occupied, dropoff_location, corporate_account_id ON public.rides FOR EACH ROW EXECUTE FUNCTION tg_rides_validate_promo_discount();
CREATE TRIGGER tg_rides_rollback_promo_on_cancel AFTER UPDATE OF status ON public.rides FOR EACH ROW WHEN (((new.status = 'canceled'::ride_status) AND (old.status <> 'canceled'::ride_status))) EXECUTE FUNCTION tg_rides_rollback_promo_on_cancel();

-- Seeds.
INSERT INTO public.service_type_configs (slug) VALUES ('auto_standard');
INSERT INTO public.platform_config (key, value) VALUES ('commission_rate', '0.15');
INSERT INTO public.reward_identity_salt (id, salt) VALUES (1, repeat('ab', 32));
INSERT INTO public.users (id, role, full_name) VALUES
  ('00000000-0000-0000-0000-000000000099', 'customer', 'Usuario eliminado');

-- Like prod: new functions in public are executable by the API roles until a
-- migration revokes it.
ALTER DEFAULT PRIVILEGES FOR ROLE tricigo_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

RESET ROLE;
```

- [ ] **Step 2: Write `supabase/tests/00665/run.sh`:**

```bash
#!/usr/bin/env bash
# Rehearsal runner for migration 00665 (local Postgres 16, no PostGIS needed).
#   supabase/tests/00665/run.sh none
#       -> scaffold (prod's live bodies) + tests (RED: the column and functions are missing)
#   supabase/tests/00665/run.sh supabase/migrations/00665_signup_code_promotion.sql
#       -> the same + migration x2 (idempotency) + tests + CRLF copy + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see the plan docs/superpowers/plans/2026-10-17-signup-code-promotion.md
# and CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod".
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00665/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr665
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ANON=00000000-0000-0000-0000-000000000099
ANA=a0000000-0000-4000-8000-000000000001      # registered with MOTO, phone 5355500001
ANA2=a0000000-0000-4000-8000-000000000011     # ANA's phone on a new account, also MOTO
NOPH=a0000000-0000-4000-8000-000000000002     # MOTO, phone never confirmed
RIDER2=a0000000-0000-4000-8000-000000000006   # no signup code, phone 5355500006
CARA=c0000000-0000-4000-8000-000000000003     # SINPROMO (a code with no promotion), phone 5355500003
DIEGO=d0000000-0000-4000-8000-000000000004    # driver
EVA=e0000000-0000-4000-8000-000000000005      # platform admin, registered with MOTO
GINA=f0000000-0000-4000-8000-000000000008     # MOTO; her phone already used BIENVENIDA
MARK=f0000000-0000-4000-8000-000000000010     # marketing
DP_DIEGO=dd000000-0000-4000-8000-000000000004
PROMO=f1000000-0000-4000-8000-000000000001    # BIENVENIDA, 25 %
P20=f1000000-0000-4000-8000-000000000002      # MOTO20, 20 %: the promotion linked to MOTO
CORP=c0000000-0000-4000-8000-0000000000c0
PICK="'POINT(-82.3666 23.1357)'"
DROP="'POINT(-82.3666 23.1384)'"
R1=22222222-0000-4000-8000-000000000001; R2=22222222-0000-4000-8000-000000000002

tx(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
# client USER SQL: SQL from USER's app session (role authenticated), then back to the test superuser with no JWT
client(){ printf "SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; SET LOCAL request.jwt.claim.sub = '';" "$1" "$2"; }
# ride ID CUSTOMER [PROMO] [RIDE_MODE] [CORPORATE_ACCOUNT]
ride(){ local promo="NULL" mode="${4:-passenger}" corp="NULL"
  [ -n "${3:-}" ] && promo="'$3'"; [ -n "${5:-}" ] && corp="'$5'"
  echo "INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup, promo_code_id, ride_mode, corporate_account_id)
        VALUES ('$1', '$2', 'auto_standard', $PICK, $DROP, 4000, $promo, '$mode', $corp);"; }
state(){ echo "SELECT coalesce(promo_code_id::text, 'none') || '|' || discount_amount_cup FROM public.rides WHERE id = '$1';"; }
complete(){ echo "UPDATE public.rides SET driver_id = '$2', status = 'completed' WHERE id = '$1';"; }
cancel(){ echo "UPDATE public.rides SET status = 'canceled' WHERE id = '$1';"; }
# del USER: what deleting the account does (00657); the phone's claim stays (00658)
del(){ echo "UPDATE public.promotion_uses SET user_id = '$ANON' WHERE user_id = '$1'; DELETE FROM auth.users WHERE id = '$1';"; }
# again USER PHONE: a new account confirms the phone of a deleted one
again(){ echo "INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$1', '$2', now());"; }
link(){ echo "UPDATE public.acquisition_codes SET promotion_id = ${2:-NULL} WHERE code = '$1';"; }
MINE="SELECT code || '|' || type || '|' || coalesce(discount_percent::text, '-') || '|' || first_ride_only || '|' || signup_code FROM public.get_my_signup_promotion();"
COUNT_MINE="SELECT count(*) FROM public.get_my_signup_promotion();"
STATS="SELECT code || '|' || signups || '|' || coalesce(promotion_code, '-') || '|' || promo_rides FROM public.admin_signup_code_stats() ORDER BY code COLLATE \"C\";"
NEWFNS="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
        WHERE proname IN ('_my_signup_promotion_id', 'tg_rides_signup_promo', 'get_my_signup_promotion', 'admin_signup_code_stats')"
LIVE="SELECT string_agg(proname || '=' || md5(replace(prosrc, chr(13), '')), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
      WHERE proname IN ('uid', 'current_user_role', 'is_admin', 'is_super_admin', 'is_marketing', 'get_platform_config_numeric',
        'tg_rides_validate_promo_discount', 'tg_rides_rollback_promo_on_cancel', '_reward_identity_hash', '_reward_claim_status',
        '_claim_reward', 'admin_signup_code_stats', 'validate_promo_code')"
LIVE_MD5="_claim_reward=d9a8726c2f105908c0df7fe8c59b2982,_reward_claim_status=73d57eecb3631f0db8d1bc9d7a71fb30,_reward_identity_hash=4f1942d94b70a77d6b5007d776f5b425,admin_signup_code_stats=16a8ed1ebe03aa82f2f75676783a9099,current_user_role=cb4a7c12d4e21fe2997135833f141e25,get_platform_config_numeric=13d2587037eca74854cf2394ba42a90c,is_admin=22cb75e91980d512498034cd33e1eda2,is_marketing=1903156b6a1218a543888ae2ebfb3656,is_super_admin=5655a4615e92e8b1e323d06c7566b058,tg_rides_rollback_promo_on_cancel=0fd8994f3d1dd121e5168ff58ab0fdbc,tg_rides_validate_promo_discount=cad4cf62d95e5055950b67564c6da7f4,uid=cdef18c69c4f4cbbced2eaf81e628b49,validate_promo_code=952805817a1ea73ab0fbb93f28884a30"

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         (cd "$DIR" && $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f scaffold.sql >/dev/null 2>&1) || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name) VALUES
    ('$ANA', 'customer', 'Ana'), ('$ANA2', 'customer', 'Ana otra vez'), ('$NOPH', 'customer', 'Sin teléfono'),
    ('$RIDER2', 'customer', 'Rider Two'), ('$CARA', 'customer', 'Cara'), ('$DIEGO', 'driver', 'Diego'),
    ('$EVA', 'admin', 'Eva'), ('$GINA', 'customer', 'Gina'), ('$MARK', 'marketing', 'Mark');
  INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
    ('$ANA', '5355500001', now()), ('$NOPH', '5355500099', NULL), ('$RIDER2', '5355500006', now()),
    ('$CARA', '5355500003', now()), ('$DIEGO', '5355500004', now()), ('$EVA', '5355500010', now()),
    ('$GINA', '5355500008', now()), ('$MARK', '5355500011', now());
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP_DIEGO', '$DIEGO');
  INSERT INTO public.corporate_accounts (id, commission_percent) VALUES ('$CORP', 10);
  INSERT INTO public.promotions (id, code, type, discount_percent) VALUES
    ('$PROMO', 'BIENVENIDA', 'percentage_discount', 25), ('$P20', 'MOTO20', 'percentage_discount', 20);
  INSERT INTO public.acquisition_codes (code, label, channel) VALUES ('MOTO', 'Motorenko', 'influencer'), ('SINPROMO', 'Sin promoción', 'otro');
  UPDATE public.users SET signup_code = 'MOTO' WHERE id IN ('$ANA', '$ANA2', '$NOPH', '$EVA', '$GINA');
  UPDATE public.users SET signup_code = 'SINPROMO' WHERE id = '$CARA';
  -- GINA's phone used BIENVENIDA before
  INSERT INTO public.promotion_uses (promotion_id, user_id) VALUES ('$PROMO', '$GINA');
  SELECT public._claim_reward('$GINA', 'promo:$PROMO');
  -- a SECURITY DEFINER function that creates a ride for the caller (recurring rides, support do this)
  CREATE FUNCTION public.test_definer_ride(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog' AS \$f\$
    INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup)
    VALUES (p_id, auth.uid(), 'auto_standard', 'POINT(-82.3666 23.1357)', 'POINT(-82.3666 23.1384)', 4000);
  \$f\$;
  ALTER FUNCTION public.test_definer_ride(uuid) OWNER TO tricigo_owner;
  GRANT EXECUTE ON FUNCTION public.test_definer_ride(uuid) TO authenticated;" >/dev/null 2>&1; }
# the link exists only with the migration; without it this fails and the tests below are RED
link_moto(){ $BIN/psql $CONN -d "$1" -qAt -c "$(link MOTO "'$P20'")" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 the scaffold carries prod's live bodies" "$LIVE" "$LIVE_MD5"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1 || { echo "migration NOT idempotent"; exit 1; }
  val "S1 one trigger and one link column after two runs" \
    "SELECT count(*) FROM pg_trigger WHERE tgname = 'rides_signup_promo'; SELECT count(*) FROM information_schema.columns WHERE table_name = 'acquisition_codes' AND column_name = 'promotion_id';" "1;1"
fi
link_moto $DB

echo "== 1. the linked promotion is applied when a person creates a ride =="
USES="SELECT count(*) FROM public.promotion_uses WHERE promotion_id = '$P20';"
CLAIMED="SELECT count(*) FROM public.reward_claims WHERE claim = 'promo:$P20' AND released_at IS NULL;"
val "A1 a ride with no code gets the code's promotion" "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "$P20|800"
val "A2 ... and takes a use and the phone's claim" "$(tx "$(client $ANA "$(ride $R1 $ANA)") $USES $CLAIMED")" "1;1"
val "A3 a code the person typed wins" "$(tx "$(client $ANA "$(ride $R1 $ANA $PROMO)") $(state $R1)")" "$PROMO|1000"
val "A4 someone with no signup code gets nothing" "$(tx "$(client $RIDER2 "$(ride $R1 $RIDER2)") $(state $R1)")" "none|0"
val "A5 a code with no promotion gives nothing" "$(tx "$(client $CARA "$(ride $R1 $CARA)") $(state $R1)")" "none|0"
val "A6 a paused or pending promotion gives nothing, and the ride is created" \
  "$(tx "UPDATE public.promotions SET is_active = false WHERE id = '$P20'; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "none|0"
val "A7 a promotion that has not started gives nothing" \
  "$(tx "UPDATE public.promotions SET valid_from = now() + interval '1 day' WHERE id = '$P20'; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "none|0"
val "A8 an expired promotion gives nothing" \
  "$(tx "UPDATE public.promotions SET valid_until = now() - interval '1 minute' WHERE id = '$P20'; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "none|0"
val "A9 a promotion out of uses gives nothing" \
  "$(tx "UPDATE public.promotions SET max_uses = 0 WHERE id = '$P20'; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "none|0"
val "A10 a phone that already used the promotion gets nothing" \
  "$(tx "$(link MOTO "'$PROMO'") $(client $GINA "$(ride $R1 $GINA)") $(state $R1)")" "none|0"
val "A11 ... also from a new account after deleting the old one" \
  "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(del $ANA) $(again $ANA2 5355500001) $(client $ANA2 "$(ride $R2 $ANA2)") $(state $R2)")" "none|0"
val "A12 a first-ride-only promotion after a completed ride gives nothing" \
  "$(tx "UPDATE public.promotions SET first_ride_only = true WHERE id = '$P20'; $(ride $R1 $ANA) $(complete $R1 $DP_DIEGO)
         $(client $ANA "$(ride $R2 $ANA)") $(state $R2)")" "none|0"
val "A13 a delivery does not spend it" "$(tx "$(client $ANA "$(ride $R1 $ANA '' cargo)") $(state $R1)")" "none|0"
val "A14 a ride a company pays does not spend it" "$(tx "$(client $ANA "$(ride $R1 $ANA '' passenger $CORP)") $(state $R1)")" "none|0"
val "A15 an admin's own ride is left alone" "$(tx "$(client $EVA "$(ride $R1 $EVA)") $(state $R1)")" "none|0"
val "A16 a ride a SECURITY DEFINER function creates is left alone" \
  "$(tx "$(client $ANA "SELECT public.test_definer_ride('$R1');") $(state $R1)")" "none|0"
val "A17 a ride created with no JWT (cron, SQL) is left alone" "$(tx "$(ride $R1 $ANA) $(state $R1)")" "none|0"
val "A18 the link is read when the ride is created, not at signup" \
  "$(tx "$(link MOTO) $(client $ANA "$(ride $R1 $ANA)") $(state $R1) $(link MOTO "'$P20'") $(client $ANA "$(ride $R2 $ANA)") $(state $R2)")" "none|0;$P20|800"
val "A19 a canceled ride gives it back for the next one" \
  "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(cancel $R1) $(client $ANA "$(ride $R2 $ANA)") $(state $R2)")" "$P20|800"
val "A20 a phone that was never confirmed gets nothing" "$(tx "$(client $NOPH "$(ride $R1 $NOPH)") $(state $R1)")" "none|0"
val "A21 deleting the promotion clears the link" \
  "$(tx "DELETE FROM public.promotions WHERE id = '$P20'; SELECT coalesce(promotion_id::text, 'none') FROM public.acquisition_codes WHERE code = 'MOTO';")" "none"

echo "== 2. get_my_signup_promotion() =="
val "M1 a person registered with the code sees the promotion" "$(tx "$(client $ANA "$MINE")")" "MOTO20|percentage_discount|20|false|MOTO"
val "M2 nothing without a signup code" "$(tx "$(client $RIDER2 "$COUNT_MINE")")" "0"
val "M3 nothing once it is used" "$(tx "$(client $ANA "$(ride $R1 $ANA) $COUNT_MINE")")" "0"
val "M4 nothing while the promotion is paused" \
  "$(tx "UPDATE public.promotions SET is_active = false WHERE id = '$P20'; $(client $ANA "$COUNT_MINE")")" "0"
val "M5 nothing for a phone that already used it" "$(tx "$(link MOTO "'$PROMO'") $(client $GINA "$COUNT_MINE")")" "0"
val "M6 nothing for a first-ride-only promotion after a completed ride" \
  "$(tx "UPDATE public.promotions SET first_ride_only = true WHERE id = '$P20'; $(ride $R1 $ANA) $(complete $R1 $DP_DIEGO) $(client $ANA "$COUNT_MINE")")" "0"
val "M7 nothing without a confirmed phone" "$(tx "$(client $NOPH "$COUNT_MINE")")" "0"
val "M8 nothing when it is out of uses" \
  "$(tx "UPDATE public.promotions SET max_uses = 0 WHERE id = '$P20'; $(client $ANA "$COUNT_MINE")")" "0"
val "M9 it shows again after a canceled ride" \
  "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(cancel $R1) $(client $ANA "$COUNT_MINE")")" "1"
err "M10 anon cannot call it" "BEGIN; SET LOCAL ROLE anon; SELECT * FROM public.get_my_signup_promotion(); ROLLBACK;" \
  "permission denied for function get_my_signup_promotion"
err "M11 ... nor the lookup the trigger uses" "BEGIN; SET LOCAL ROLE anon; SELECT public._my_signup_promotion_id(); ROLLBACK;" \
  "permission denied for function _my_signup_promotion_id"
val "M12 the lookup answers only for the caller" "$(tx "$(client $RIDER2 "SELECT coalesce(public._my_signup_promotion_id()::text, 'none');")")" "none"

echo "== 3. admin_signup_code_stats() =="
val "S2 an admin sees the promotion and the completed rides that used it" \
  "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(complete $R1 $DP_DIEGO) $(client $EVA "$STATS")")" "MOTO|5|MOTO20|1;SINPROMO|1|-|0"
val "S3 marketing sees it too" "$(tx "$(client $MARK "SELECT count(*) FROM public.admin_signup_code_stats();")")" "2"
err "S4 a passenger does not" "$(tx "$(client $ANA "SELECT count(*) FROM public.admin_signup_code_stats();")")" "Admin only"
val "S5 a use by someone who did not register with the code does not count" \
  "$(tx "$(client $RIDER2 "$(ride $R1 $RIDER2 $P20)") $(complete $R1 $DP_DIEGO) $(client $EVA "$STATS")")" "MOTO|5|MOTO20|0;SINPROMO|1|-|0"
val "S6 the twelve columns from before are unchanged" \
  "$(tx "$(client $EVA "SELECT code || '|' || label || '|' || channel || '|' || audience || '|' || is_active || '|' || rider_signups || '|' || driver_signups
           || '|' || drivers_approved || '|' || riders_with_ride || '|' || drivers_with_ride FROM public.admin_signup_code_stats() WHERE code = 'MOTO';")")" \
  "MOTO|Motorenko|influencer|ambos|true|5|0|0|0|0"
val "S7 the panel can preselect the linked promotion" \
  "$(tx "$(client $EVA "SELECT promotion_id FROM public.admin_signup_code_stats() WHERE code = 'MOTO';")")" "$P20"

echo "== 4. permissions and shape =="
val "G1 the trigger function is SECURITY INVOKER" "SELECT prosecdef FROM pg_proc WHERE proname = 'tg_rides_signup_promo';" "f"
val "G2 anon calls none of the three" \
  "SELECT has_function_privilege('anon', 'public.get_my_signup_promotion()', 'EXECUTE') || '|' || has_function_privilege('anon', 'public._my_signup_promotion_id()', 'EXECUTE')
       || '|' || has_function_privilege('anon', 'public.admin_signup_code_stats()', 'EXECUTE');" "false|false|false"
val "G3 authenticated calls the three" \
  "SELECT has_function_privilege('authenticated', 'public.get_my_signup_promotion()', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public._my_signup_promotion_id()', 'EXECUTE')
       || '|' || has_function_privilege('authenticated', 'public.admin_signup_code_stats()', 'EXECUTE');" "true|true|true"
val "G4 BEFORE INSERT row triggers fire in this order" \
  "SELECT string_agg(tgname, ',' ORDER BY tgname COLLATE \"C\") FROM pg_trigger WHERE tgrelid = 'public.rides'::regclass AND NOT tgisinternal AND (tgtype & 7) = 7;" \
  "rides_signup_promo,rides_validate_promo_discount"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration refuses or catches what it must =="
  NEG=pr665n
  fresh $NEG
  run $NEG "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tg_rides_validate_promo_discount()'::regprocedure),
            E'  RETURN NEW;\nEND;', E'  RETURN NEW; -- local edit\nEND;'); END \$x\$;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "tg_rides_validate_promo_discount() is not the body read from prod" \
    && ok "N1 a validator body it does not know aborts it" || ko "N1" "got [$r]"
  fresh $NEG
  run $NEG "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.admin_signup_code_stats()'::regprocedure),
            'ORDER BY count(u.id) DESC', 'ORDER BY count(u.id) ASC'); END \$x\$;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "admin_signup_code_stats() is not the body read from prod" \
    && ok "N2 a stats body it does not know aborts it" || ko "N2" "got [$r]"
  fresh $NEG
  run $NEG "ALTER TRIGGER rides_validate_promo_discount ON public.rides RENAME TO rides_a_validate_promo_discount;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "has to fire before the promo validator" \
    && ok "N3 a validator that would fire first aborts it" || ko "N3" "got [$r]"
  fresh $NEG
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $NEG "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ] && [ "$(run $NEG "$NEWFNS")" = "$(run $DB "$NEWFNS")" ] \
     && [ "$(run $NEG "SELECT count(*) FROM pg_proc WHERE position(chr(13) IN prosrc) > 0")" = "0" ]; then
    ok "N4 pasted with CRLF line ends, the bodies match the LF ones"
  else ko "N4" "apply [$r], bodies [$(run $NEG "$NEWFNS")]"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1
  echo "== bodies after 00665 (copy into CLAUDE.md) =="
  run $DB "SELECT string_agg(proname || ' ' || md5(prosrc) || '/' || length(prosrc), E'\n' ORDER BY proname COLLATE \"C\") FROM pg_proc
           WHERE proname IN ('_my_signup_promotion_id', 'tg_rides_signup_promo', 'get_my_signup_promotion', 'admin_signup_code_stats')"
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 3: Start the local cluster** (see "Local Postgres on this Windows PC" above).

- [ ] **Step 4: Run RED and confirm the scaffold loads and the new behavior is missing.**

Run: `PGBIN="$S/pgsql/bin" PGPORT=5465 bash supabase/tests/00665/run.sh none`
Expected: `PASS S0` (the scaffold loaded and the 13 bodies match prod). These FAIL, because the column, the trigger and the new functions do not exist: A1, A2, A10, A18, A19, A21, M1–M12, S2, S5, S7, G1–G4. The "nothing happens" tests (A3–A9, A11–A17, A20) and S3, S4, S6 pass already: nothing applies a signup promotion yet, and the old stats function exists. The last line is `== result: N passed, M failed ==` with M > 0. If `scaffold failed` prints, run `psql -f scaffold.sql` by hand from `supabase/tests/00665` to see the error and fix the scaffold (not the live bodies).

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/00665/scaffold.sql supabase/tests/00665/run.sh supabase/tests/00665/live-bodies.sql
git commit -m "test(db): rehearsal for 00665 signup code promotions (RED)"
```

---

### Task 3: Migration 00665 (GREEN)

> **Superseded (2026-10-17):** the committed `supabase/migrations/00665_signup_code_promotion.sql` replaces the block below. After the SQL review it takes `rides` before `promotions`, runs every trigger check inside the protected block, casts two outputs and checks that the lookup functions stay SECURITY DEFINER. Its md5 values differ from the ones in this text.

**Files:**
- Create: `supabase/migrations/00665_signup_code_promotion.sql`

- [ ] **Step 1: Re-check the number.** Run the two commands in CLAUDE.md § "Pre-flight para elegir número de migración" (master's last five, then every open PR's migration files). If 00665 is taken, use the next free number in the file name, in run.sh's header and in every place this plan says 00665.

- [ ] **Step 2: Write the migration.** Write it with the Write tool (not through bash: the bash tool turns `\\` into `\`). It must be LF only.

```sql
-- 00665: a signup code can carry a promotion.
--
-- Marketing gives each influencer and channel a signup code (00619). Until now
-- it only recorded where a person came from. acquisition_codes.promotion_id
-- links a code to a promotion, and a person who registered with that code gets
-- the promotion on the next ride they create, without typing it:
--
--   rides_signup_promo          BEFORE INSERT on rides: fills in promo_code_id
--                               when the person typed none. It fires before
--                               rides_validate_promo_discount, which decides as
--                               it does for a typed code: active, dates, first
--                               ride, once per confirmed phone (00658), uses.
--   get_my_signup_promotion()   the linked promotion, only when the validator
--                               would accept it now. The apps show it before
--                               the person books.
--   admin_signup_code_stats()   + promotion_id, promotion_code, promo_rides.
--
-- tg_rides_signup_promo is SECURITY INVOKER on purpose. Inside a SECURITY
-- DEFINER function current_user is always the owner, and the trigger has to
-- tell a ride a person creates (current_user anon or authenticated) from one a
-- SECURITY DEFINER function, the cron or the service role creates. Clients
-- cannot read acquisition_codes (admin and marketing only), so the lookup goes
-- through _my_signup_promotion_id(), which answers only for auth.uid().
--
-- Deliveries (ride_mode other than passenger) and rides a company pays
-- (corporate_account_id) do not spend the welcome discount. The code's own
-- is_active does not matter: it only controls who can still register with it.

SET LOCAL lock_timeout = '10s';

-- 0. What this relies on is what was read from prod on 2026-10-17.
DO $guard$
DECLARE
  v_md5 text;
  v_result text;
BEGIN
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc WHERE oid = to_regprocedure('public.tg_rides_validate_promo_discount()');
  IF v_md5 IS DISTINCT FROM 'cad4cf62d95e5055950b67564c6da7f4' THEN
    RAISE EXCEPTION '00665: tg_rides_validate_promo_discount() is not the body read from prod (md5 %)', v_md5;
  END IF;

  SELECT md5(replace(prosrc, chr(13), '')), pg_get_function_result(oid) INTO v_md5, v_result
    FROM pg_proc WHERE oid = to_regprocedure('public.admin_signup_code_stats()');
  IF v_result IS NULL
     OR (v_result NOT LIKE '%promo_rides bigint%' AND v_md5 IS DISTINCT FROM '16a8ed1ebe03aa82f2f75676783a9099') THEN
    RAISE EXCEPTION '00665: admin_signup_code_stats() is not the body read from prod (md5 %)', v_md5;
  END IF;
END
$guard$;

-- 1. The link.
ALTER TABLE public.acquisition_codes
  ADD COLUMN IF NOT EXISTS promotion_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.acquisition_codes.promotion_id IS
  '00665: promotion applied to the next ride of people who registered with this code, while that promotion is active.';
CREATE INDEX IF NOT EXISTS idx_acquisition_codes_promotion
  ON public.acquisition_codes (promotion_id) WHERE promotion_id IS NOT NULL;

-- 2. The caller's linked promotion, for the trigger.
CREATE OR REPLACE FUNCTION public._my_signup_promotion_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT ac.promotion_id
    FROM public.users u
    JOIN public.acquisition_codes ac ON ac.code = u.signup_code
   WHERE u.id = auth.uid();
$function$;
REVOKE ALL ON FUNCTION public._my_signup_promotion_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._my_signup_promotion_id() TO authenticated, service_role;

-- 3. Fill in the promotion when a person creates a ride.
CREATE OR REPLACE FUNCTION public.tg_rides_signup_promo()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_promo uuid;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated')
     OR auth.uid() IS NULL
     OR NEW.customer_id IS DISTINCT FROM auth.uid()
     OR NEW.promo_code_id IS NOT NULL
     OR COALESCE(NEW.ride_mode, 'passenger') <> 'passenger'
     OR NEW.corporate_account_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Never block the ride: a failed lookup leaves it without the promotion.
  BEGIN
    IF public.is_admin() THEN
      RETURN NEW;
    END IF;
    v_promo := public._my_signup_promotion_id();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00665 tg_rides_signup_promo: lookup failed for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  -- Every rule (active, dates, first ride, once per phone, uses) belongs to
  -- the validator, which fires next and drops the promotion if one fails.
  IF v_promo IS NOT NULL THEN
    NEW.promo_code_id := v_promo;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_rides_signup_promo() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_rides_signup_promo() TO service_role;

CREATE OR REPLACE TRIGGER rides_signup_promo
  BEFORE INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_signup_promo();

-- 4. What the apps show before the person books.
CREATE OR REPLACE FUNCTION public.get_my_signup_promotion()
 RETURNS TABLE(code text, type text, discount_percent numeric, discount_fixed_cup integer,
               first_ride_only boolean, valid_until timestamp with time zone, signup_code text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  -- The rules tg_rides_validate_promo_discount applies when the ride is
  -- created (00658): the row is there exactly when rides_signup_promo would
  -- give the person the discount.
  RETURN QUERY
  SELECT p.code::text, p.type::text, p.discount_percent::numeric, p.discount_fixed_cup::integer,
         COALESCE(p.first_ride_only, false), p.valid_until, u.signup_code
    FROM public.users u
    JOIN public.acquisition_codes ac ON ac.code = u.signup_code
    JOIN public.promotions p ON p.id = ac.promotion_id
   WHERE u.id = v_uid
     AND p.is_active
     AND (p.valid_from IS NULL OR p.valid_from <= now())
     AND (p.valid_until IS NULL OR p.valid_until > now())
     AND (p.max_uses IS NULL OR p.current_uses < p.max_uses)
     AND NOT EXISTS (SELECT 1 FROM public.promotion_uses pu
                      WHERE pu.promotion_id = p.id AND pu.user_id = v_uid)
     AND public._reward_claim_status(v_uid, 'promo:' || p.id::text) = 'free'
     AND NOT (COALESCE(p.first_ride_only, false) AND EXISTS (
           SELECT 1 FROM public.rides r WHERE r.customer_id = v_uid AND r.status = 'completed'));
END;
$function$;
REVOKE ALL ON FUNCTION public.get_my_signup_promotion() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_signup_promotion() TO authenticated, service_role;

-- 5. The code's results, with its promotion and how many rides used it.
-- New columns change the return type: DROP and CREATE, from the live body.
DROP FUNCTION IF EXISTS public.admin_signup_code_stats();
CREATE FUNCTION public.admin_signup_code_stats()
 RETURNS TABLE(code text, label text, channel text, audience text, is_active boolean,
               created_at timestamp with time zone, signups bigint, rider_signups bigint,
               driver_signups bigint, drivers_approved bigint, riders_with_ride bigint,
               drivers_with_ride bigint, promotion_id uuid, promotion_code text, promo_rides bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH u AS (
    SELECT u.id, u.signup_code, dp.id AS dp_id, dp.status AS dp_status
    FROM public.users u
    LEFT JOIN public.driver_profiles dp ON dp.user_id = u.id
    WHERE u.signup_code IS NOT NULL
  )
  SELECT
    ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at,
    count(u.id),
    count(u.id) FILTER (WHERE u.dp_id IS NULL),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL),
    count(u.id) FILTER (WHERE u.dp_status = 'approved'),
    count(u.id) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.rides r WHERE r.customer_id = u.id AND r.status = 'completed')),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.rides r WHERE r.driver_id = u.dp_id AND r.status = 'completed')),
    ac.promotion_id,
    p.code::text,
    (SELECT count(*) FROM public.rides r
       JOIN public.users ru ON ru.id = r.customer_id
      WHERE ru.signup_code = ac.code
        AND r.promo_code_id = ac.promotion_id
        AND r.status = 'completed')
  FROM public.acquisition_codes ac
  LEFT JOIN public.promotions p ON p.id = ac.promotion_id
  LEFT JOIN u ON u.signup_code = ac.code
  GROUP BY ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at, ac.promotion_id, p.code
  ORDER BY count(u.id) DESC, ac.created_at DESC;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_signup_code_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_signup_code_stats() TO authenticated, service_role;

-- 6. Pasted from Windows (CRLF), the bodies carry \r: rewrite them without it.
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._my_signup_promotion_id()', 'public.tg_rides_signup_promo()',
    'public.get_my_signup_promotion()', 'public.admin_signup_code_stats()']::regprocedure[]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- 7. Self-checks.
DO $check$
DECLARE
  v_ours text;
  v_validator text;
BEGIN
  -- BEFORE ROW triggers fire in name order (C collation); the validator has
  -- to see the promotion this trigger filled in.
  SELECT t.tgname::text INTO v_ours
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.rides'::regclass
     AND t.tgfoid = 'public.tg_rides_signup_promo()'::regprocedure
     AND t.tgenabled <> 'D' AND (t.tgtype & 7) = 7;
  SELECT min(t.tgname::text COLLATE "C") INTO v_validator
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.rides'::regclass
     AND t.tgfoid = 'public.tg_rides_validate_promo_discount()'::regprocedure
     AND t.tgenabled <> 'D' AND (t.tgtype & 7) = 7;
  IF v_ours IS NULL OR v_validator IS NULL OR NOT (v_ours COLLATE "C" < v_validator COLLATE "C") THEN
    RAISE EXCEPTION '00665: rides_signup_promo has to fire before the promo validator (ours %, validator %)',
      v_ours, v_validator;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.acquisition_codes'::regclass AND c.contype = 'f'
                    AND c.confrelid = 'public.promotions'::regclass AND c.confdeltype = 'n') THEN
    RAISE EXCEPTION '00665: acquisition_codes.promotion_id has to reference promotions ON DELETE SET NULL';
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.tg_rides_signup_promo()'::regprocedure) THEN
    RAISE EXCEPTION '00665: tg_rides_signup_promo() must be SECURITY INVOKER: current_user tells a client insert apart';
  END IF;

  IF has_function_privilege('anon', 'public.get_my_signup_promotion()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._my_signup_promotion_id()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_signup_code_stats()', 'EXECUTE') THEN
    RAISE EXCEPTION '00665: anon can call a function it must not';
  END IF;
  IF NOT (has_function_privilege('authenticated', 'public.get_my_signup_promotion()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public._my_signup_promotion_id()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.admin_signup_code_stats()', 'EXECUTE')) THEN
    RAISE EXCEPTION '00665: authenticated lost EXECUTE on a function the apps or the panel call';
  END IF;

  IF position('is_marketing()' IN (SELECT prosrc FROM pg_proc
                                    WHERE oid = 'public.admin_signup_code_stats()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00665: admin_signup_code_stats() lost its admin-or-marketing gate';
  END IF;
END
$check$;
```

- [ ] **Step 3: Check the file is LF:** `tr -cd '\r' < supabase/migrations/00665_signup_code_promotion.sql | wc -c` prints `0`.

- [ ] **Step 4: Run GREEN**

Run: `PGBIN="$S/pgsql/bin" PGPORT=5465 bash supabase/tests/00665/run.sh supabase/migrations/00665_signup_code_promotion.sql`
Expected: every line `PASS`, including S0, S1, A1–A21, M1–M12, S2–S7, G1–G4 and N1–N4, then the four `md5/length` lines and `== result: <n> passed, 0 failed ==`. If a test fails, fix the migration (never the expected value) unless the test itself is wrong; explain any test change in the commit message.

- [ ] **Step 5: Save the four md5/length lines** printed under `== bodies after 00665 ==`: Task 10 writes them into CLAUDE.md.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00665_signup_code_promotion.sql
git commit -m "feat(db): 00665 a signup code can carry a promotion"
```

---

### Task 4: Pure rules in `@tricigo/utils`

**Files:**
- Create: `packages/utils/src/signupPromo.ts`
- Create: `packages/utils/src/__tests__/signupPromo.test.ts`
- Modify: `packages/utils/src/index.ts` (add one export line)

- [ ] **Step 1: Write the failing test** `packages/utils/src/__tests__/signupPromo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  isSignupPromoCode,
  signupPromoPrefill,
  signupPromoAction,
  promotionLinkStatus,
} from '../signupPromo';

describe('isSignupPromoCode', () => {
  it('matches the signup promotion code, ignoring case and spaces', () => {
    expect(isSignupPromoCode(' moto20 ', 'MOTO20')).toBe(true);
  });
  it('is false for another code, an empty field or no signup promotion', () => {
    expect(isSignupPromoCode('OTRO', 'MOTO20')).toBe(false);
    expect(isSignupPromoCode('', 'MOTO20')).toBe(false);
    expect(isSignupPromoCode('MOTO20', null)).toBe(false);
  });
});

describe('signupPromoPrefill', () => {
  it('fills an empty field with the signup promotion code', () => {
    expect(signupPromoPrefill('', 'MOTO20')).toBe('MOTO20');
    expect(signupPromoPrefill('   ', 'MOTO20')).toBe('MOTO20');
  });
  it('leaves a typed or linked code alone', () => {
    expect(signupPromoPrefill('VERANO', 'MOTO20')).toBeNull();
  });
  it('does nothing without a signup promotion', () => {
    expect(signupPromoPrefill('', null)).toBeNull();
  });
});

describe('signupPromoAction', () => {
  const base = {
    promoCode: 'MOTO20',
    signupPromoCode: 'MOTO20',
    hasResult: false,
    validating: false,
    fareCup: 4000,
    eligible: true,
  };

  it('validates the signup code once there is a fare and no result', () => {
    expect(signupPromoAction(base)).toBe('validate');
  });
  it('waits for a fare', () => {
    expect(signupPromoAction({ ...base, fareCup: 0 })).toBe('none');
  });
  it('does not validate twice', () => {
    expect(signupPromoAction({ ...base, hasResult: true })).toBe('none');
    expect(signupPromoAction({ ...base, validating: true })).toBe('none');
  });
  it('never touches a code the person typed', () => {
    expect(signupPromoAction({ ...base, promoCode: 'VERANO' })).toBe('none');
    expect(signupPromoAction({ ...base, promoCode: 'VERANO', hasResult: true, eligible: false })).toBe('none');
  });
  it('clears its result on a delivery or a company ride, and validates again when that changes back', () => {
    expect(signupPromoAction({ ...base, hasResult: true, eligible: false })).toBe('clear');
    expect(signupPromoAction({ ...base, hasResult: false, eligible: false })).toBe('none');
  });
});

describe('promotionLinkStatus', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const active = {
    is_active: true,
    pending_approval: false,
    valid_from: '2026-10-01T00:00:00Z',
    valid_until: null,
    max_uses: null,
    current_uses: 0,
  };

  it('is active when on, started, not expired and with uses left', () => {
    expect(promotionLinkStatus(active, now)).toBe('active');
  });
  it('tells pending approval from paused', () => {
    expect(promotionLinkStatus({ ...active, is_active: false, pending_approval: true }, now)).toBe('pending');
    expect(promotionLinkStatus({ ...active, is_active: false }, now)).toBe('paused');
  });
  it('is scheduled before it starts and expired after it ends', () => {
    expect(promotionLinkStatus({ ...active, valid_from: '2026-10-18T00:00:00Z' }, now)).toBe('scheduled');
    expect(promotionLinkStatus({ ...active, valid_until: '2026-10-17T12:00:00Z' }, now)).toBe('expired');
  });
  it('is exhausted with no uses left', () => {
    expect(promotionLinkStatus({ ...active, max_uses: 10, current_uses: 10 }, now)).toBe('exhausted');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/signupPromo.test.ts`
Expected: FAIL, `Failed to resolve import "../signupPromo"`.

- [ ] **Step 3: Write `packages/utils/src/signupPromo.ts`:**

```ts
// ============================================================
// Signup code promotions (00665): a promotion linked to the code a person
// registered with. The server applies it to their next ride without a code;
// these rules decide what the booking screens show before that.
// ============================================================

function normalize(code: string): string {
  return code.trim().toUpperCase();
}

/** Whether the promo field holds the signup promotion's code. */
export function isSignupPromoCode(promoCode: string, signupPromoCode: string | null): boolean {
  return !!signupPromoCode && normalize(promoCode) !== '' && normalize(promoCode) === normalize(signupPromoCode);
}

/** The code to put in an empty promo field, or null to leave the field as it is. */
export function signupPromoPrefill(currentCode: string, signupPromoCode: string | null): string | null {
  if (!signupPromoCode || currentCode.trim() !== '') return null;
  return signupPromoCode;
}

export type SignupPromoAction = 'validate' | 'clear' | 'none';

export interface SignupPromoState {
  /** What the promo field holds. */
  promoCode: string;
  /** The signup promotion's code, or null when there is none. */
  signupPromoCode: string | null;
  /** A validation result (valid or not) is on screen. */
  hasResult: boolean;
  validating: boolean;
  /** The fare of the selected service, in CUP. */
  fareCup: number;
  /** A passenger ride the person pays: not a delivery, no company account. */
  eligible: boolean;
}

/**
 * What to do with the signup code without a tap. The server applies it only to
 * a passenger ride the person pays, so the screens validate it only for those,
 * and clear its result when the ride stops being one (the app would otherwise
 * send the promotion with a delivery or a company ride). A code the person
 * typed is never touched.
 */
export function signupPromoAction(s: SignupPromoState): SignupPromoAction {
  if (s.validating || !isSignupPromoCode(s.promoCode, s.signupPromoCode)) return 'none';
  if (!s.eligible) return s.hasResult ? 'clear' : 'none';
  if (!s.hasResult && s.fareCup > 0) return 'validate';
  return 'none';
}

export type PromotionLinkStatus = 'active' | 'pending' | 'paused' | 'scheduled' | 'expired' | 'exhausted';

export interface PromotionLinkInput {
  is_active: boolean;
  pending_approval?: boolean | null;
  valid_from: string | null;
  valid_until: string | null;
  max_uses: number | null;
  current_uses: number;
}

/** Whether a promotion linked to a signup code applies today, and if not, why. */
export function promotionLinkStatus(p: PromotionLinkInput, now: Date = new Date()): PromotionLinkStatus {
  if (!p.is_active) return p.pending_approval ? 'pending' : 'paused';
  const t = now.getTime();
  if (p.valid_from && new Date(p.valid_from).getTime() > t) return 'scheduled';
  if (p.valid_until && new Date(p.valid_until).getTime() <= t) return 'expired';
  if (p.max_uses != null && p.current_uses >= p.max_uses) return 'exhausted';
  return 'active';
}
```

- [ ] **Step 4: Export it.** In `packages/utils/src/index.ts`, after the line `export * from './ledger';`, add:

```ts
export * from './signupPromo';
```

- [ ] **Step 5: Run the test and the package suite**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/signupPromo.test.ts` → PASS (all tests).
Run: `pnpm --filter @tricigo/utils test` → PASS, no other test broken.

- [ ] **Step 6: Commit**

```bash
git add packages/utils/src/signupPromo.ts packages/utils/src/__tests__/signupPromo.test.ts packages/utils/src/index.ts
git commit -m "feat(utils): rules for showing a signup code promotion"
```

---

### Task 5: `acquisitionCodeService`: link a promotion, read the new stats

**Files:**
- Modify: `packages/api/src/services/acquisition-code.service.ts`
- Test: `packages/api/src/services/__tests__/acquisition-code.test.ts`

- [ ] **Step 1: Add the failing tests.** In `acquisition-code.test.ts`, add a helper after `mockInsertChain`:

```ts
function mockUpdateChain(result: { error: unknown }) {
  const eq = vi.fn().mockResolvedValue(result);
  const update = vi.fn(() => ({ eq }));
  mockFrom.mockReturnValueOnce({ update });
  return { update, eq };
}
```

Inside `describe('create', …)`, change the expected insert of the first test to include `promotion_id: null`:

```ts
      expect(insert).toHaveBeenCalledWith({
        code: 'MOTORENKO',
        label: 'Motorenko',
        channel: 'influencer',
        audience: 'choferes',
        notes: null,
        promotion_id: null,
      });
```

and add:

```ts
    it('links the promotion chosen in the form', async () => {
      const { insert } = mockInsertChain({ data: { code: 'MOTORENKO' }, error: null });

      await acquisitionCodeService.create({
        code: 'MOTORENKO', label: 'Motorenko', channel: 'influencer', audience: 'ambos', promotionId: 'p-1',
      });

      expect(insert).toHaveBeenCalledWith(expect.objectContaining({ promotion_id: 'p-1' }));
    });

    it('explains a promotion deleted while the form was open', async () => {
      mockInsertChain({ data: null, error: { code: '23503', message: 'violates foreign key constraint' } });

      await expect(
        acquisitionCodeService.create({ code: 'MOTORENKO', label: 'x', channel: 'otro', audience: 'ambos', promotionId: 'gone' }),
      ).rejects.toThrow('La promoción ya no existe');
    });
```

Add a new `describe` block:

```ts
  describe('setPromotion', () => {
    it('links a promotion to the code', async () => {
      const { update, eq } = mockUpdateChain({ error: null });

      await acquisitionCodeService.setPromotion('MOTORENKO', 'p-1');

      expect(mockFrom).toHaveBeenCalledWith('acquisition_codes');
      expect(update).toHaveBeenCalledWith({ promotion_id: 'p-1' });
      expect(eq).toHaveBeenCalledWith('code', 'MOTORENKO');
    });

    it('unlinks it with null', async () => {
      const { update } = mockUpdateChain({ error: null });

      await acquisitionCodeService.setPromotion('MOTORENKO', null);

      expect(update).toHaveBeenCalledWith({ promotion_id: null });
    });

    it('explains a promotion that no longer exists', async () => {
      mockUpdateChain({ error: { code: '23503', message: 'violates foreign key constraint' } });

      await expect(acquisitionCodeService.setPromotion('MOTORENKO', 'gone')).rejects.toThrow('La promoción ya no existe');
    });
  });
```

In `describe('getStats', …)`, add:

```ts
    it('reads the linked promotion and its completed rides', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{
          code: 'MOTORENKO', label: 'Motorenko', channel: 'influencer', audience: 'ambos', is_active: true,
          created_at: '2026-10-06', signups: '2', rider_signups: '2', driver_signups: '0',
          drivers_approved: '0', riders_with_ride: '1', drivers_with_ride: '0',
          promotion_id: 'p-1', promotion_code: 'MOTO20', promo_rides: '1',
        }],
        error: null,
      });

      const [row] = await acquisitionCodeService.getStats();

      expect(row).toMatchObject({ promotion_id: 'p-1', promotion_code: 'MOTO20', promo_rides: 1 });
    });

    it('works before migration 00665, without the promotion columns', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{
          code: 'MOTORENKO', label: 'Motorenko', channel: 'influencer', audience: 'ambos', is_active: true,
          created_at: '2026-10-06', signups: '2', rider_signups: '2', driver_signups: '0',
          drivers_approved: '0', riders_with_ride: '1', drivers_with_ride: '0',
        }],
        error: null,
      });

      const [row] = await acquisitionCodeService.getStats();

      expect(row).toMatchObject({ promotion_id: null, promotion_code: null, promo_rides: 0 });
    });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/acquisition-code.test.ts`
Expected: FAIL (`promotion_id` missing from the insert, `setPromotion is not a function`, stats fields undefined).

- [ ] **Step 3: Implement.** In `acquisition-code.service.ts`:

Change the header comment's second paragraph line `// They pay no bonus: they only record where` … through `// the user came from.` to:

```ts
// They pay no bonus. They record where the user came from and, when a
// promotion is linked (00665), the server applies it to the user's next ride.
```

Add `promotion_id` to `AcquisitionCode`:

```ts
export interface AcquisitionCode {
  code: string;
  label: string;
  channel: AcquisitionChannel;
  audience: AcquisitionAudience;
  is_active: boolean;
  notes: string | null;
  /** 00665: the promotion people who register with this code get on their next ride. */
  promotion_id: string | null;
  created_at: string;
}
```

Add the three fields at the end of `AcquisitionCodeStats`:

```ts
  drivers_with_ride: number;
  /** 00665: the linked promotion; null when none (or before the migration). */
  promotion_id: string | null;
  promotion_code: string | null;
  /** 00665: completed rides that used the linked promotion, by people who registered with the code. */
  promo_rides: number;
}
```

Add `promotionId` to `NewAcquisitionCode`:

```ts
export interface NewAcquisitionCode {
  code: string;
  label: string;
  channel: AcquisitionChannel;
  audience: AcquisitionAudience;
  notes?: string | null;
  promotionId?: string | null;
}
```

Add above `export const acquisitionCodeService`:

```ts
const PROMOTION_GONE = 'La promoción ya no existe. Recarga la página y elige otra.';
```

In `getStats`, add to the mapped object after `drivers_with_ride: Number(row.drivers_with_ride),`:

```ts
      promotion_id: row.promotion_id ?? null,
      promotion_code: row.promotion_code ?? null,
      promo_rides: Number(row.promo_rides ?? 0),
```

In `create`, add `promotion_id: input.promotionId ?? null,` after `notes: input.notes?.trim() || null,`, and add a `23503` branch:

```ts
    if (error) {
      if (error.code === '23505') throw new Error(`El código ${code} ya existe o es el código de referido de un usuario.`);
      if (error.code === '23503') throw new Error(PROMOTION_GONE);
      throw error;
    }
```

Add after `setActive`:

```ts
  /**
   * Links a promotion to the code, or unlinks it with null (00665). An UPDATE
   * that RLS filters out answers OK with 0 rows: the page confirms against the
   * reloaded stats.
   */
  async setPromotion(code: string, promotionId: string | null): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('acquisition_codes')
      .update({ promotion_id: promotionId })
      .eq('code', code);
    if (error) {
      if (error.code === '23503') throw new Error(PROMOTION_GONE);
      throw error;
    }
  },
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/acquisition-code.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/acquisition-code.service.ts packages/api/src/services/__tests__/acquisition-code.test.ts
git commit -m "feat(api): link a promotion to a signup code"
```

---

### Task 6: `rideService.getMySignupPromotion()`

**Files:**
- Modify: `packages/api/src/services/ride.service.ts` (new interface near the top, new method after `validatePromoCode`)
- Modify: `packages/api/src/index.ts`
- Test: `packages/api/src/services/__tests__/ride.test.ts` (append)

- [ ] **Step 1: Write the failing tests.** Append to `ride.test.ts`:

```ts
// ============================================================
// getMySignupPromotion (00665)
// ============================================================

describe('rideService.getMySignupPromotion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the linked promotion of the code the user registered with', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{
        code: 'MOTO20', type: 'percentage_discount', discount_percent: 20, discount_fixed_cup: null,
        first_ride_only: true, valid_until: null, signup_code: 'MOTORENKO',
      }],
      error: null,
    });

    const promo = await rideService.getMySignupPromotion();

    expect(mockRpc).toHaveBeenCalledWith('get_my_signup_promotion');
    expect(promo).toEqual({
      code: 'MOTO20', type: 'percentage_discount', discountPercent: 20, discountFixedCup: null,
      firstRideOnly: true, validUntil: null, signupCode: 'MOTORENKO',
    });
  });

  it('turns numeric strings into numbers', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{
        code: 'MENOS500', type: 'fixed_discount', discount_percent: null, discount_fixed_cup: '500',
        first_ride_only: false, valid_until: '2026-12-31T00:00:00Z', signup_code: 'BOLSAS-VEDADO',
      }],
      error: null,
    });

    const promo = await rideService.getMySignupPromotion();

    expect(promo?.discountFixedCup).toBe(500);
    expect(promo?.validUntil).toBe('2026-12-31T00:00:00Z');
  });

  it('is null when there is no linked promotion', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await rideService.getMySignupPromotion()).toBeNull();
  });

  it('is null before migration 00665 (function missing)', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    expect(await rideService.getMySignupPromotion()).toBeNull();
  });

  it('is null on any other error, without throwing', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied' } });
    expect(await rideService.getMySignupPromotion()).toBeNull();
    mockRpc.mockRejectedValueOnce(new Error('network'));
    expect(await rideService.getMySignupPromotion()).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/ride.test.ts -t getMySignupPromotion`
Expected: FAIL, `rideService.getMySignupPromotion is not a function`.

- [ ] **Step 3: Implement.** In `ride.service.ts`, before `export interface CreateRideParams {`, add:

```ts
/** 00665: the promotion linked to the code the user registered with, when the server would apply it now. */
export interface SignupPromotion {
  /** The promotion's code; the booking screens put it in the promo field. */
  code: string;
  type: Promotion['type'];
  discountPercent: number | null;
  discountFixedCup: number | null;
  firstRideOnly: boolean;
  validUntil: string | null;
  /** The signup code the user typed (MOTORENKO), for the label. */
  signupCode: string;
}
```

After the closing `},` of `validatePromoCode`, add:

```ts
  /**
   * 00665: the promotion linked to the code the user registered with, or null.
   * The server applies it to the next ride anyway; this only lets the booking
   * screens show it. Never throws: any error, including the function missing
   * before the migration (PGRST202), is null.
   */
  async getMySignupPromotion(): Promise<SignupPromotion | null> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.rpc('get_my_signup_promotion');
      if (error || !Array.isArray(data) || data.length === 0) return null;
      const row = data[0] as {
        code?: string;
        type: Promotion['type'];
        discount_percent: number | string | null;
        discount_fixed_cup: number | string | null;
        first_ride_only: boolean | null;
        valid_until: string | null;
        signup_code: string;
      };
      if (!row?.code) return null;
      return {
        code: row.code,
        type: row.type,
        discountPercent: row.discount_percent == null ? null : Number(row.discount_percent),
        discountFixedCup: row.discount_fixed_cup == null ? null : Number(row.discount_fixed_cup),
        firstRideOnly: row.first_ride_only === true,
        validUntil: row.valid_until ?? null,
        signupCode: row.signup_code,
      };
    } catch {
      return null;
    }
  },
```

In `packages/api/src/index.ts`, after `export { rideService } from './services/ride.service';`, add:

```ts
export type { SignupPromotion } from './services/ride.service';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/ride.test.ts` → PASS (the new block and every existing test).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/ride.service.ts packages/api/src/index.ts packages/api/src/services/__tests__/ride.test.ts
git commit -m "feat(api): read the promotion of the user's signup code"
```

---

### Task 7: Admin panel `/code-performance`

**Files:**
- Modify: `apps/admin/src/app/code-performance/page.tsx`

The admin has no vitest; Task 4's `promotionLinkStatus` carries the logic. Verify with `pnpm check-types` here and in the browser after deploy (Task 11).

- [ ] **Step 1: Imports.** Add `promotionService` and `type Promotion` to the `@tricigo/api` import, and change the utils import to:

```ts
import { formatCUP, getErrorMessage, promotionLinkStatus, type PromotionLinkStatus } from '@tricigo/utils';
```

- [ ] **Step 2: Form state.** Add `promotionId: string;` to `interface AcquisitionForm` and `promotionId: ''` to `EMPTY_FORM`:

```ts
const EMPTY_FORM: AcquisitionForm = { code: '', label: '', channel: 'influencer', audience: 'ambos', notes: '', promotionId: '' };
```

- [ ] **Step 3: Load promotions.** After the `useEffect(() => { void loadCodes(); }, [loadCodes]);` block, add:

```tsx
  // Promotions for the "Promoción" selects. Marketing and admins read the
  // table (00642). If this fails the codes still work: the selects stay off.
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [promotionsError, setPromotionsError] = useState(false);
  useEffect(() => {
    promotionService
      .getAll(0, 200)
      .then((rows) => {
        setPromotions(rows);
        setPromotionsError(false);
      })
      .catch(() => {
        setPromotions([]);
        setPromotionsError(true);
      });
  }, []);
  const promotionById = useMemo(() => new Map(promotions.map((p) => [p.id, p])), [promotions]);
  const [linkingCodes, setLinkingCodes] = useState<ReadonlySet<string>>(() => new Set());

  const statusLabels = useMemo<Record<PromotionLinkStatus, string>>(
    () => ({
      active: t('code_performance.promo_status_active', { defaultValue: 'activa' }),
      pending: t('code_performance.promo_status_pending', { defaultValue: 'pendiente de aprobación' }),
      paused: t('code_performance.promo_status_paused', { defaultValue: 'pausada' }),
      scheduled: t('code_performance.promo_status_scheduled', { defaultValue: 'todavía no empieza' }),
      expired: t('code_performance.promo_status_expired', { defaultValue: 'vencida' }),
      exhausted: t('code_performance.promo_status_exhausted', { defaultValue: 'sin usos' }),
    }),
    [t],
  );

  const promotionOptionLabel = useCallback(
    (p: Promotion) => {
      const discount = p.type === 'fixed_discount' ? `−${num(p.discount_fixed_cup ?? 0)} CUP` : `${p.discount_percent ?? 0} %`;
      return `${p.code} · ${discount} · ${statusLabels[promotionLinkStatus(p)]}`;
    },
    [statusLabels],
  );
```

- [ ] **Step 4: Linking from a row.** After `handleToggleActive`, add:

```tsx
  const handleSetPromotion = useCallback(
    async (row: AcquisitionRow, promotionId: string | null) => {
      setLinkingCodes((prev) => new Set(prev).add(row.code));
      try {
        await acquisitionCodeService.setPromotion(row.code, promotionId);
        // An UPDATE that RLS filters out answers OK with 0 rows: confirm it.
        const rows = await loadCodes(true);
        if (!rows) return;
        if ((rows.find((r) => r.code === row.code)?.promotion_id ?? null) === promotionId) {
          showToast(
            'success',
            promotionId
              ? t('code_performance.toast_promo_linked', { code: row.code, defaultValue: 'Promoción vinculada a {{code}}' })
              : t('code_performance.toast_promo_unlinked', { code: row.code, defaultValue: 'Promoción quitada de {{code}}' }),
          );
        } else {
          showToast(
            'error',
            t('code_performance.toggle_not_saved', {
              defaultValue: 'El cambio no se guardó. Recarga la página e inténtalo de nuevo.',
            }),
          );
        }
      } catch (err) {
        showToast('error', getErrorMessage(err));
      } finally {
        setLinkingCodes((prev) => {
          const rest = new Set(prev);
          rest.delete(row.code);
          return rest;
        });
      }
    },
    [loadCodes, showToast, t],
  );
```

- [ ] **Step 5: Create with a promotion.** In `handleCreate`, add `promotionId: form.promotionId || null,` after `notes: form.notes,`. In the form, before the `notes` `<Field>`, add:

```tsx
                <Field label={t('code_performance.field_promotion', { defaultValue: 'Promoción (opcional)' })}>
                  <select
                    value={form.promotionId}
                    onChange={(e) => updateForm('promotionId', e.target.value)}
                    disabled={promotionsError}
                    className={inputCls}
                  >
                    <option value="">{t('code_performance.no_promotion', { defaultValue: 'Sin promoción' })}</option>
                    {promotions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {promotionOptionLabel(p)}
                      </option>
                    ))}
                  </select>
                </Field>
```

Change the notes field's className from `"sm:col-span-2 lg:col-span-3"` to `"sm:col-span-2 lg:col-span-2"` so the grid still has four columns per row.

- [ ] **Step 6: Help text.** Replace the `form_help` defaultValue with:

```
'Estos códigos no pagan bono: registran de dónde viene cada persona. La gente los escribe en «Código de invitación» al registrarse. Si eliges una promoción, quien se registre con el código la recibe en su próximo viaje sin escribir nada, mientras la promoción esté activa. Activar una promoción lo decide un administrador. Usa un código por influencer, lote de bolsas, pantalla o grupo.'
```

and the `description_acquisition` defaultValue with:

```
'Cuánta gente se registró con cada código de origen, cuántos llegaron a su primer viaje y cuántos usaron la promoción del código. Total histórico.'
```

- [ ] **Step 7: Two new columns.** In `acquisitionColumns`, after the `first_rides` column and before `is_active`, add:

```tsx
      {
        id: 'promotion',
        header: t('code_performance.col_promotion', { defaultValue: 'Promoción' }),
        cell: (c) => {
          const linked = c.promotion_id ? promotionById.get(c.promotion_id) : undefined;
          const status = linked ? promotionLinkStatus(linked) : null;
          return (
            <span className="inline-flex flex-col gap-1">
              <select
                value={c.promotion_id ?? ''}
                onChange={(e) => void handleSetPromotion(c, e.target.value || null)}
                disabled={promotionsError || linkingCodes.has(c.code)}
                aria-label={t('code_performance.promotion_aria', { code: c.code, defaultValue: 'Promoción de {{code}}' })}
                className={`${inputCls} h-8 min-w-[11rem] text-[12px]`}
              >
                <option value="">{t('code_performance.no_promotion', { defaultValue: 'Sin promoción' })}</option>
                {c.promotion_id && !linked && (
                  <option value={c.promotion_id}>{c.promotion_code ?? c.promotion_id}</option>
                )}
                {promotions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {promotionOptionLabel(p)}
                  </option>
                ))}
              </select>
              {status && status !== 'active' && (
                <span className="text-[11px] text-amber-800 dark:text-amber-400">
                  {t('code_performance.promo_not_applied', {
                    status: statusLabels[status],
                    defaultValue: 'No se aplica: {{status}}',
                  })}
                </span>
              )}
            </span>
          );
        },
        hideBelow: 'lg',
      },
      {
        id: 'promo_rides',
        header: t('code_performance.col_promo_rides', { defaultValue: 'Usaron el descuento' }),
        cell: (c) => <span className="font-mono text-ink-muted" data-tabular>{num(c.promo_rides)}</span>,
        align: 'right',
        sortKey: 'promo_rides',
        width: '110px',
        hideBelow: 'lg',
      },
```

Add `promotionById, promotions, promotionsError, linkingCodes, handleSetPromotion, promotionOptionLabel, statusLabels` to that `useMemo`'s dependency array.

- [ ] **Step 8: CSV.** In `handleExportCodes`, before the `is_active` column, add:

```ts
        { key: 'promotion_code', label: t('code_performance.col_promotion', { defaultValue: 'Promoción' }) },
        { key: 'promo_rides', label: t('code_performance.col_promo_rides', { defaultValue: 'Usaron el descuento' }) },
```

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @tricigo/admin check-types` (if that script name does not exist in `apps/admin/package.json`, run `pnpm check-types`).
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/admin/src/app/code-performance/page.tsx
git commit -m "feat(admin): link a promotion to each signup code"
```

---

### Task 8: Passenger app: prefill, auto-validate, label

**Files:**
- Modify: `apps/client/src/stores/ride.store.ts`
- Create: `apps/client/src/hooks/useSignupPromotion.ts`
- Modify: `apps/client/app/(tabs)/index.tsx` (SelectingView ~3113–3300 and its promo chip ~4180; ReviewingView ~4815)
- Modify: `packages/i18n/src/locales/{es,en,pt}/rider.json`

- [ ] **Step 1: Store field.** In `ride.store.ts`:
  - Add `import type { SignupPromotion } from '@tricigo/api';` with the other type imports.
  - In `interface RideState`, after `promoResult: PromoResult | null;`, add:

```ts
  /**
   * 00665: the promotion of the user's signup code, as the server would apply
   * it now. Account-level, so draft resets keep it; the booking sheet reloads
   * it each time it opens.
   */
  signupPromo: SignupPromotion | null;
```

  - After `setPromoResult: (result: PromoResult | null) => void;`, add `setSignupPromo: (promo: SignupPromotion | null) => void;`.
  - In the initial state, after `promoResult: null,` (the one at ~line 233), add `signupPromo: null,`.
  - After `setPromoResult: (promoResult) => set({ promoResult }),`, add `setSignupPromo: (signupPromo) => set({ signupPromo }),`.
  - In `resetAll`'s `set({…})`, after `promoResult: null,`, add `signupPromo: null,`.

- [ ] **Step 2: Hook** `apps/client/src/hooks/useSignupPromotion.ts`:

```ts
import { useEffect } from 'react';
import { rideService } from '@tricigo/api';
import { signupPromoPrefill } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';

/**
 * Loads the promotion of the code the user registered with (00665) when the
 * booking sheet opens, and puts its code in an empty promo field. The server
 * applies it to the ride anyway; this only shows the discount before "Pedir".
 * A code the user typed or opened from a link is never replaced.
 */
export function useSignupPromotion(): void {
  const userId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void rideService.getMySignupPromotion().then((promo) => {
      if (cancelled) return;
      const store = useRideStore.getState();
      store.setSignupPromo(promo);
      const code = signupPromoPrefill(store.promoCode, promo?.code ?? null);
      if (code) store.setPromoCode(code);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);
}
```

- [ ] **Step 3: Wire it in `SelectingView`.** In `apps/client/app/(tabs)/index.tsx`:
  - Import: `import { useSignupPromotion } from '@/hooks/useSignupPromotion';` next to the other `@/hooks/...` imports, and add `isSignupPromoCode, signupPromoAction` to the existing `@tricigo/utils` import of that file.
  - In `SelectingView`, right after the line `const { requestEstimate, confirmRide, validatePromo, validatingPromo } = useRideActions();` (~line 3145), add:

```tsx
  useSignupPromotion();
  const signupPromo = useRideStore((s) => s.signupPromo);
  const setPromoResult = useRideStore((s) => s.setPromoResult);
```

  - Right after `const selectedEstimate = allFareEstimates?.[selectedEstimateSlug] ?? null;` (~line 3284), add:

```tsx
  // 00665: validate the signup code's promotion without a tap, only for a
  // passenger ride the person pays (the rides the server applies it to).
  useEffect(() => {
    const action = signupPromoAction({
      promoCode,
      signupPromoCode: signupPromo?.code ?? null,
      hasResult: promoResult != null,
      validating: validatingPromo,
      fareCup: selectedEstimate?.estimated_fare_cup ?? 0,
      eligible: draft.serviceType !== 'mensajeria' && !draft.corporateAccountId,
    });
    if (action === 'validate') void validatePromo();
    else if (action === 'clear') setPromoResult(null);
  }, [promoCode, signupPromo, promoResult, validatingPromo, selectedEstimate?.estimated_fare_cup,
      draft.serviceType, draft.corporateAccountId, validatePromo, setPromoResult]);
```

If `SelectingView` already destructures `setPromoResult` from `useRideStore()`, drop the extra selector line and use that one.

- [ ] **Step 4: Label in `SelectingView`.** Replace the chip text (~line 4183):

```tsx
                <Text variant="caption" style={{ color: MAP_COLORS.pickup }}>{'¡'}Descuento de {formatCUP(promoResult.discountAmount)} aplicado!</Text>
```

with:

```tsx
                <Text variant="caption" style={{ color: MAP_COLORS.pickup }}>
                  {signupPromo && isSignupPromoCode(promoCode, signupPromo.code)
                    ? t('ride.signup_promo_applied', {
                        code: signupPromo.signupCode,
                        amount: formatCUP(promoResult.discountAmount),
                        defaultValue: 'Descuento de tu código {{code}}: {{amount}}',
                      })
                    : <>{'¡'}Descuento de {formatCUP(promoResult.discountAmount)} aplicado!</>}
                </Text>
```

- [ ] **Step 5: Label in `ReviewingView`.** Add `const signupPromo = useRideStore((s) => s.signupPromo);` after its `useRideActions()` line (~4263). In its result `<Text>` (~4825), replace

```tsx
                  {promoResult.valid
                    ? t('ride.discount_applied', { defaultValue: `Descuento de ${formatCUP(promoResult.discountAmount)} aplicado`, amount: formatCUP(promoResult.discountAmount) })
```

with

```tsx
                  {promoResult.valid
                    ? (signupPromo && isSignupPromoCode(promoCode, signupPromo.code)
                        ? t('ride.signup_promo_applied', {
                            code: signupPromo.signupCode,
                            amount: formatCUP(promoResult.discountAmount),
                            defaultValue: 'Descuento de tu código {{code}}: {{amount}}',
                          })
                        : t('ride.discount_applied', { defaultValue: `Descuento de ${formatCUP(promoResult.discountAmount)} aplicado`, amount: formatCUP(promoResult.discountAmount) }))
```

keeping the rest of that ternary as it is.

- [ ] **Step 6: Translations.** In each `packages/i18n/src/locales/<lang>/rider.json`, add one line right after the line with `"promo_error_phone_required"` (it is inside `"ride"`):
  - es: `    "signup_promo_applied": "Descuento de tu código {{code}}: {{amount}}",`
  - en: `    "signup_promo_applied": "Discount from your code {{code}}: {{amount}}",`
  - pt: `    "signup_promo_applied": "Desconto do seu código {{code}}: {{amount}}",`

- [ ] **Step 7: Check**

Run: `pnpm check-types` → no errors.
Run: `pnpm --filter @tricigo/client test` → PASS.
Run: `node -e "for (const l of ['es','en','pt']) JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/'+l+'/rider.json','utf8'))"` → no output (valid JSON).
Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/copyTuteo.test.ts` → PASS (the new copy is in tú).

- [ ] **Step 8: Commit**

```bash
git add apps/client/src/stores/ride.store.ts apps/client/src/hooks/useSignupPromotion.ts "apps/client/app/(tabs)/index.tsx" packages/i18n/src/locales/es/rider.json packages/i18n/src/locales/en/rider.json packages/i18n/src/locales/pt/rider.json
git commit -m "feat(client): show the signup code's promotion before booking"
```

---

### Task 9: Web `/book`

**Files:**
- Modify: `apps/web/src/app/book/page.tsx`
- Modify: `packages/i18n/src/locales/{es,en,pt}/web.json`

- [ ] **Step 1: Imports.** Add `type SignupPromotion` to the `@tricigo/api` import and `isSignupPromoCode, signupPromoAction, signupPromoPrefill` to the `@tricigo/utils` import of the file.

- [ ] **Step 2: Load and prefill.** After the existing prefill `useEffect` (the one reading `?promo=` and `tricigo_pending_promo`, ~line 203), add:

```tsx
  // 00665: the promotion of the code the user registered with. Loaded after the
  // ?promo= / pending-link prefill above, so a code from a link always wins.
  const [signupPromo, setSignupPromo] = useState<SignupPromotion | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    void rideService.getMySignupPromotion().then((promo) => {
      if (cancelled) return;
      setSignupPromo(promo);
      setPromoCode((cur) => signupPromoPrefill(cur, promo?.code ?? null) ?? cur);
    });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);
  const showsSignupPromo = !!signupPromo && isSignupPromoCode(promoCode, signupPromo.code);
```

- [ ] **Step 3: Auto-validate.** After `handleApplyPromo`'s closing brace, add:

```tsx
  // 00665: validate the signup code without a tap, only for a passenger ride
  // the person pays; clear it when the ride becomes a delivery or a company ride.
  useEffect(() => {
    const action = signupPromoAction({
      promoCode,
      signupPromoCode: signupPromo?.code ?? null,
      hasResult: promoResult != null,
      validating: promoValidating,
      fareCup: selectedEstimate?.estimated_fare_cup ?? 0,
      eligible: serviceType !== 'mensajeria' && !selectedCorporateId,
    });
    if (action === 'validate') void handleApplyPromo();
    else if (action === 'clear') setPromoResult(null);
    // handleApplyPromo is recreated every render; the inputs it reads are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoCode, signupPromo, promoResult, promoValidating, selectedEstimate?.estimated_fare_cup, serviceType, selectedCorporateId]);
```

Before writing it, confirm with `grep -n "corporate_account_id" apps/web/src/app/book/page.tsx` that the ride sends `corporate_account_id` whenever `selectedCorporateId` is set (~line 838). If it is gated by something else too, use that same condition for `eligible`.

Both new `useEffect`s must stay above the page's early return `if (authLoading || !isAuthenticated) {` (~line 918): a hook after an early return is the "Should have a queue" crash class.

- [ ] **Step 4: No "Quitar" for the signup code, the field stays editable, and its label.** In the promo block (~line 1873–1920):

Change the input's `disabled={promoResult?.valid === true}` to:

```tsx
                disabled={promoResult?.valid === true && !showsSignupPromo}
```

(typing another code replaces the signup one; its `onChange` already clears the result). Change `              {promoResult?.valid ? (` (the line that opens the "Quitar" button) to:

```tsx
              {promoResult?.valid ? (showsSignupPromo ? null : (
```

and the three lines that close the "Quitar" button

```tsx
                  Quitar
                </button>
              ) : (
```

to

```tsx
                  Quitar
                </button>
              )) : (
```

so "Quitar" renders only for a typed code (the server would apply the signup one again). Then replace the result text:

```tsx
                {promoResult.valid
                  ? `Descuento aplicado: -${formatPrice(promoResult.discount)}`
                  : promoResult.error}
```

with:

```tsx
                {promoResult.valid
                  ? (showsSignupPromo
                      ? t('book.signup_promo_applied', {
                          code: signupPromo!.signupCode,
                          amount: formatPrice(promoResult.discount),
                          defaultValue: 'Descuento de tu código {{code}}: {{amount}}',
                        })
                      : `Descuento aplicado: -${formatPrice(promoResult.discount)}`)
                  : promoResult.error}
```

- [ ] **Step 5: Translations.** In each `packages/i18n/src/locales/<lang>/web.json`, add one line right after the line with `"promo_error_phone_required"` (it is inside `"book"`):
  - es: `    "signup_promo_applied": "Descuento de tu código {{code}}: {{amount}}",`
  - en: `    "signup_promo_applied": "Discount from your code {{code}}: {{amount}}",`
  - pt: `    "signup_promo_applied": "Desconto do seu código {{code}}: {{amount}}",`

- [ ] **Step 6: Check**

Run: `pnpm check-types` → no errors.
Run: `node -e "for (const l of ['es','en','pt']) JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/'+l+'/web.json','utf8'))"` → no output.
Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/copyTuteo.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/book/page.tsx packages/i18n/src/locales/es/web.json packages/i18n/src/locales/en/web.json packages/i18n/src/locales/pt/web.json
git commit -m "feat(web): show the signup code's promotion before booking"
```

---

### Task 10: Full checks and CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Everything green**

Run, and paste each result into the PR body:
- `pnpm check-types`
- `pnpm exec turbo run test --force` (no turbo cache replay; see memory "turbo test cache replay")
- `PGBIN="$S/pgsql/bin" PGPORT=5465 bash supabase/tests/00665/run.sh supabase/migrations/00665_signup_code_promotion.sql`
- `pnpm check:migration-grants` (00665 creates no table; it must pass)

- [ ] **Step 2: CLAUDE.md.** Add this section right after the section "### Bonos de una vez por persona: van atados al teléfono confirmado (00658, 2026-10-12)", with the four md5/length values from Task 3 Step 5 in place of `<…>`:

```markdown
### Un código de origen puede traer una promoción (00665)

Marketing le vincula una promoción a un código de origen (MOTORENKO) desde `/code-performance`, y quien se registró con ese código la recibe en su próximo viaje sin escribir nada. Diseño: `docs/superpowers/specs/2026-10-17-signup-code-promotion-design.md`. Ensayo: `supabase/tests/00665/run.sh` (no necesita PostGIS).

- **Dónde se decide.** El trigger `rides_signup_promo` (BEFORE INSERT en `rides`) solo pone `promo_code_id` cuando la persona no escribió un código. Todas las reglas (activa, fechas, primer viaje, una vez por teléfono de 00658, usos) las aplica el validador `rides_validate_promo_discount`, que dispara después por orden de nombre. La migración aborta si el validador dispararía antes.
- **Es SECURITY INVOKER a propósito.** Necesita `current_user` para saber si el viaje lo crea una persona (`anon` o `authenticated`); adentro de una SECURITY DEFINER sería siempre el dueño. La búsqueda la hace `_my_signup_promotion_id()` (SECURITY DEFINER, sin argumentos, solo para `auth.uid()`), porque los clientes no leen `acquisition_codes`. **No la pases a SECURITY DEFINER**: el trigger dejaría de aplicar la promoción sin ningún error. La migración lo comprueba.
- **A quién no se aplica:** envíos (`ride_mode` distinto de `passenger`), viajes que paga una empresa, viajes de un admin, los que crea una función SECURITY DEFINER, el cron o el service role. El `is_active` del código no importa: solo decide quién puede registrarse con él.
- **El vínculo se lee al crear el viaje**, así que también vale para quien se registró antes de vincularlo. Borrar la promoción borra el vínculo (`ON DELETE SET NULL`).
- **`get_my_signup_promotion()`** devuelve la promoción solo cuando el validador la aceptaría en ese momento. La app y la web la usan para poner el código y validarlo sin un toque (`signupPromoAction` en `@tricigo/utils`), solo para un viaje de pasajero que paga la persona. No hay botón para quitarla: el servidor la volvería a aplicar.
- **`admin_signup_code_stats()`** suma `promotion_id`, `promotion_code` y `promo_rides` (viajes completados con esa promoción por gente registrada con el código).
- **Limitación conocida:** si el destino es un lugar aliado (00559) con un descuento mayor, gana el del lugar y el uso de la promoción igual se consume. Pasa lo mismo con un código escrito. El del lugar llega como mucho a la comisión (15 %).
- Cuerpos tras 00665 (md5/largo): `_my_signup_promotion_id` `<…>`, `tg_rides_signup_promo` `<…>`, `get_my_signup_promotion` `<…>`, `admin_signup_code_stats` `<…>`. Una migración que redefina el validador tiene que mantener la verja de md5 de 00665 en mente: un cuerpo nuevo del validador hace abortar un nuevo apply de 00665.
- **Estado:** escrita y ensayada, no aplicada.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: signup code promotions (00665)"
```

---

### Task 11: Rollout (each step only with the owner's OK)

- [ ] **Step 1: Push and open the PR** (owner OK for the push). Body from a temp file with `--body-file`, including: what it does, the four test outputs from Task 10, "Migración no aplicada todavía", and the rollout order below. Bind it with `mcp__ccd_pr__bind_pr`.

- [ ] **Step 2: Optional prod probe** (owner OK). In a block that rolls back: `DO $probe$ BEGIN EXECUTE $mig$<the whole migration>$mig$; RAISE EXCEPTION 'PROBE ok %', (SELECT count(*) FROM pg_trigger WHERE tgname = 'rides_signup_promo'); END $probe$;`. The migration has `DROP FUNCTION`: through MCP this may wait for an approval in the app that never shows (CLAUDE.md § "Aplicar migraciones pesadas por MCP"). If it is cut twice, skip the probe; the local rehearsal covers the behavior.

- [ ] **Step 3: Apply the migration** (owner OK, ask with AskUserQuestion: "SÍ — aplica la migración 00665 en prod"). Try `apply_migration` once; if it is cut at 60 s, verify by object (it may not have run) and give the owner the SQL Editor steps: open `https://supabase.com/dashboard/project/lqaufszburqvlslpcuac/sql/new`, paste the file from GitHub ("Copy raw file"), Run, confirm "Run this query". The `$crlf$` block fixes a Windows paste.

- [ ] **Step 4: Verify in prod by object:**

```sql
SELECT proname, md5(prosrc) || '/' || length(prosrc) FROM pg_proc
WHERE proname IN ('_my_signup_promotion_id', 'tg_rides_signup_promo', 'get_my_signup_promotion', 'admin_signup_code_stats')
ORDER BY 1;
SELECT string_agg(tgname, ',' ORDER BY tgname COLLATE "C") FROM pg_trigger
WHERE tgrelid = 'public.rides'::regclass AND NOT tgisinternal AND (tgtype & 7) = 7;
SELECT column_name FROM information_schema.columns WHERE table_name = 'acquisition_codes' AND column_name = 'promotion_id';
```

The md5s must equal the ones in CLAUDE.md; the trigger list must contain `rides_signup_promo` before `rides_validate_promo_discount`. Then, as the passenger demo account in a block that rolls back (owner OK), create a ride and check it gets no promotion (it has no signup code).

- [ ] **Step 5: Merge** (owner says "Sí, autorizo el squash-merge de #N"). The admin and web deploys follow; confirm both workflows finish green.

- [ ] **Step 6: Panel check in the browser** (owner logged in): open `admin.tricigo.com/code-performance`, tab "Códigos de origen": the "Promoción" and "Usaron el descuento" columns show, and the form has the select. Do not link anything without the owner's OK; linking is a prod write.

- [ ] **Step 7: Client OTA to 1.8.0** (owner OK), with the local procedure used for the 1.8.0 crash fix (memory "driver no ota"): `npx expo export --platform android --platform ios --output-dir dist --clear` with the production `EXPO_PUBLIC_*` values, grep the bundle for `signup_promo_applied`, then `eas update --channel production --environment production --input-dir dist --skip-bundler --non-interactive` from `apps/client`.

- [ ] **Step 8: Update CLAUDE.md "Estado"** with the apply date and how it was applied, and update the marketing message (Promociones section) with: "Si le eliges una promoción a un código, quien se registre con él la recibe en su primer viaje sin escribir nada. La promoción tiene que estar activa; activarla lo aprueba un administrador."
