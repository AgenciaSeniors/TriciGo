# Missed-ride apology coupon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators get a panel page listing passengers whose request found no driver and who have not ridden since, write to each by WhatsApp with a prefilled apology, and the server gives them a personal coupon that applies on its own on their next ride.

**Architecture:** Migration 00674 adds `promotions.grant_only`, two lock tables (`promotion_grants`, `missed_ride_contacts`), a segment helper, a list (`admin_missed_riders`), a coupon header (`admin_missed_ride_coupon`) and the contact action (`ops_contact_missed_rider`), a BEFORE INSERT trigger on `rides` that attaches the coupon, and in-place patches to the promo validator, `validate_promo_code` and `get_my_signup_promotion`. The panel adds a `riders.outreach` capability, the `/missed-rides` page and a "Cupón de disculpa" checkbox in Promociones; `@tricigo/utils` builds the message, `@tricigo/api` wraps the RPCs.

**Tech Stack:** PostgreSQL 16 (plpgsql, Supabase), bash rehearsal runner on a local cluster, TypeScript, Next.js 15 admin panel, vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-missed-ride-apology-coupon-design.md`.

---

## Before you start

- Branch: `claude/missed-ride-apology-coupon` (has the spec commit). Check `git branch --show-current` before every commit.
- Migration number: 00674. Re-check right before Task 2 and before pushing:
  ```bash
  git fetch -q origin master
  git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3
  for pr in $(gh pr list --state open --json number --jq '.[].number'); do gh pr view $pr --json files --jq '.files[].path' | grep supabase/migrations; done
  ```
  If 00674 is taken, rename every `00674` in this plan (file names, comments, markers, runner) to the next free number.
- Local Postgres 16 for the rehearsal: CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (on Windows, the EnterpriseDB portable binaries in the scratchpad). Below, `PGBIN`/`PGPORT` are that cluster's `bin` folder and port.
- `pnpm install --frozen-lockfile` if the worktree has no `node_modules`.

## File structure

| File | Responsibility |
|---|---|
| Create `supabase/tests/00674/extra.sql` | What the rehearsal needs beyond the 00665 scaffold: the operator role, columns, `admin_actions`, live `is_ops_staff`/`is_operator` |
| Create `supabase/tests/00674/run.sh` | Rehearsal runner: RED without the migration, GREEN with it, negative proofs |
| Create `supabase/migrations/00674_missed_ride_apology_coupon.sql` | All server changes |
| Create `packages/utils/src/missedRideOutreach.ts` (+ test) | The apology message and the discount text |
| Modify `packages/utils/src/index.ts`, `packages/utils/package.json` | Export it |
| Modify `packages/utils/src/adminPanelAccess.ts` (+ test) | `riders.outreach` capability, `/missed-rides` route |
| Create `packages/api/src/services/missed-ride.service.ts` (+ test) | The three RPCs |
| Modify `packages/api/src/services/promotion.service.ts`, `packages/api/src/index.ts` | `grant_only` field, exports |
| Modify `apps/admin/src/lib/opsErrors.ts` | New refusal codes |
| Modify `packages/i18n/src/locales/{es,en,pt}/admin.json` | Texts |
| Modify `apps/admin/src/app/promotions/page.tsx` | "Cupón de disculpa" checkbox and badge |
| Create `apps/admin/src/app/missed-rides/page.tsx` | The page |
| Modify `apps/admin/src/components/layout/Sidebar.tsx`, `Header.tsx` | Menu entry and title |
| Modify `CLAUDE.md` | Operating notes |

---

### Task 1: Rehearsal base and RED tests

**Files:**
- Create: `supabase/tests/00674/extra.sql`
- Create: `supabase/tests/00674/run.sh`

The base reuses the 00665 rehearsal: `supabase/tests/00665/scaffold.sql` (which includes `live-bodies.sql` with `\ir`), then migration 00665 itself (prod has it), then `extra.sql`.

- [ ] **Step 1: Write `supabase/tests/00674/extra.sql`**

```sql
-- What the 00674 rehearsal needs beyond the 00665 scaffold, as in prod on 2026-11-02:
-- the operator role (00667), users.is_test, the ride and promotion columns 00674 reads,
-- admin_actions, and the LIVE bodies of is_ops_staff() and is_operator() (00668; run.sh S0
-- checks their md5). Run by the test superuser after the scaffold and migration 00665.
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'operator';

SET ROLE tricigo_owner;

ALTER TABLE public.users ADD COLUMN is_test boolean NOT NULL DEFAULT false;
ALTER TABLE public.promotions
  ADD COLUMN is_public boolean NOT NULL DEFAULT true,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.rides
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN canceled_at timestamptz,
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN pickup_address text,
  ADD COLUMN dropoff_address text;

CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.admin_actions TO service_role;

-- LIVE bodies (prod, 2026-11-02).
CREATE OR REPLACE FUNCTION public.is_operator()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is an operator, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'operator';
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_ops_staff()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- Admins, super admins and operators (00668). No JWT subject: false, with the early return of
  -- is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin', 'operator');
END;
$function$;

RESET ROLE;
```

- [ ] **Step 2: Write `supabase/tests/00674/run.sh`**

```bash
#!/usr/bin/env bash
# Rehearsal runner for migration 00674 (local Postgres 16, no PostGIS needed).
#   supabase/tests/00674/run.sh none
#       -> base (the 00665 scaffold, migration 00665, extra.sql) + tests (RED: 00674 is missing)
#   supabase/tests/00674/run.sh supabase/migrations/00674_missed_ride_apology_coupon.sql
#       -> the same + migration x2 (idempotency) + tests + CRLF copy + negative proofs (GREEN)
# The migrations are applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod".
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00674/run.sh ...
# Another database name (two runs at once): PGDB=<name> ...  (the negative proofs use <name>n)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB="${PGDB:-pr674}"
NEG="${PGDB:-pr674}n"
M665="$REPO/supabase/migrations/00665_signup_code_promotion.sql"
FRESHLOG="$(mktemp)"; trap 'rm -f "$FRESHLOG"' EXIT
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

OPS=0b000000-0000-4000-8000-000000000001    # operator
ADM=0b000000-0000-4000-8000-000000000002    # admin
MARK=0b000000-0000-4000-8000-000000000003   # marketing
ANA=a0000000-0000-4000-8000-000000000001    # no driver 3 h ago after 2 min; signup code MOTO (BIENVENIDA)
ANA2=a0000000-0000-4000-8000-000000000011   # ANA's phone on a new account (C10)
BETO=a0000000-0000-4000-8000-000000000002   # no driver 3 days ago, completed a ride since
CARL=a0000000-0000-4000-8000-000000000003   # canceled after 20 s
NORA=a0000000-0000-4000-8000-000000000004   # no driver 1 day ago, phone never confirmed
TINA=a0000000-0000-4000-8000-000000000005   # no driver 1 day ago, test account
OLGA=a0000000-0000-4000-8000-000000000006   # no driver 100 days ago
RIDER2=a0000000-0000-4000-8000-000000000007 # never missed a driver
DIEGO=d0000000-0000-4000-8000-000000000001; DP=dd000000-0000-4000-8000-000000000001
PERDON=f1000000-0000-4000-8000-000000000001 # grant-only, 500 CUP, the newest
VIEJO=f1000000-0000-4000-8000-000000000002  # grant-only, 300 CUP, a day older
BIENV=f1000000-0000-4000-8000-000000000003  # public, 25 %, linked to the signup code MOTO
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
# missed USER AGO WAIT: a request USER made AGO, canceled with no driver after WAIT
missed(){ echo "INSERT INTO public.rides (customer_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at, canceled_at, pickup_address, dropoff_address)
        VALUES ('$1', 'auto_standard', 'canceled', $PICK, $DROP, 4000, now() - interval '$2', now() - interval '$2' + interval '$3', 'Capitolio', 'Hotel Nacional');"; }
state(){ echo "SELECT coalesce(promo_code_id::text, 'none') || '|' || discount_amount_cup FROM public.rides WHERE id = '$1';"; }
cancel(){ echo "UPDATE public.rides SET status = 'canceled' WHERE id = '$1';"; }
# expect USER: remember USER's latest cancellation (what the panel shows and sends back)
expect(){ echo "SELECT 1 WHERE set_config('t.failed', coalesce((SELECT max(canceled_at)::text FROM public.rides WHERE customer_id = '$1' AND status = 'canceled'), ''), true) IS NULL;"; }
# contact USER [TIMESTAMP-SQL]: write to USER; prints error-or-true|coupon code|coupon reason
contact(){ local at="${2:-NULLIF(current_setting('t.failed', true), '')::timestamptz}"
  echo "SELECT coalesce(r ->> 'error', r ->> 'success') || '|' || coalesce(r -> 'coupon' ->> 'code', '-') || '|' || coalesce(r ->> 'coupon_reason', '-')
          FROM (SELECT public.ops_contact_missed_rider('$1', $at) AS r) x;"; }
GRANT="$(expect $ANA) $(client $OPS "$(contact $ANA)")"
LIST_PENDING="SELECT string_agg(full_name, ',' ORDER BY last_failed_at DESC) FROM public.admin_missed_riders('pending', NULL);"
MINE="SELECT code || '|' || type || '|' || coalesce(discount_fixed_cup::text, '-') || '|' || signup_code FROM public.get_my_signup_promotion();"
LIVE="SELECT string_agg(proname || '=' || md5(replace(prosrc, chr(13), '')), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname IN ('tg_rides_validate_promo_discount', 'validate_promo_code',
        'get_my_signup_promotion', 'tg_rides_signup_promo', '_claim_reward', '_reward_claim_status',
        'tg_rides_rollback_promo_on_cancel', 'is_ops_staff', 'is_operator')"
LIVE_MD5="_claim_reward=d9a8726c2f105908c0df7fe8c59b2982,_reward_claim_status=73d57eecb3631f0db8d1bc9d7a71fb30,get_my_signup_promotion=b4209984f4bd3e9e822e28e3e28eb3c9,is_operator=16438eb527af61eaa2d0b3d9a53f08f9,is_ops_staff=d6774e4677be1072e66b247492e9cb9a,tg_rides_rollback_promo_on_cancel=0fd8994f3d1dd121e5168ff58ab0fdbc,tg_rides_signup_promo=a295af88635a82cf9dbc0b272013ef30,tg_rides_validate_promo_discount=cad4cf62d95e5055950b67564c6da7f4,validate_promo_code=952805817a1ea73ab0fbb93f28884a30"
NEWFNS="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ('_missed_rider_summary', '_missed_ride_current_coupon',
          '_my_granted_promotion_id', 'admin_missed_riders', 'admin_missed_ride_coupon', 'ops_contact_missed_rider',
          'tg_rides_promo_grant', 'tg_rides_validate_promo_discount', 'validate_promo_code', 'get_my_signup_promotion')"
marker(){ echo "SELECT (length(prosrc) - length(replace(prosrc, '$2', ''))) / length('$2') FROM pg_proc WHERE proname = '$1';"; }
MARKERS="$(marker tg_rides_validate_promo_discount '00674: a grant-only promotion counts only') $(marker validate_promo_code '00674: a grant-only promotion is invalid') $(marker get_my_signup_promotion '00674: an apology coupon goes first')"

# fresh DB: the base and the seed. On a failure it prints what psql said and returns 1.
fresh(){ : > "$FRESHLOG"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- create database failed:"; cat "$FRESHLOG"; return 1; }
  (cd "$REPO/supabase/tests/00665" && "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f scaffold.sql >/dev/null 2>>"$FRESHLOG") \
    || { echo "-- the 00665 scaffold failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M665" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- migration 00665 failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/extra.sql" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- extra.sql failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name, is_test) VALUES
    ('$OPS', 'operator', 'Oscar Operador', false), ('$ADM', 'admin', 'Adela', false), ('$MARK', 'marketing', 'Mark', false),
    ('$ANA', 'customer', 'Ana Perez', false), ('$ANA2', 'customer', 'Ana otra vez', false), ('$BETO', 'customer', 'Beto', false),
    ('$CARL', 'customer', 'Carla', false), ('$NORA', 'customer', 'Nora', false), ('$TINA', 'customer', 'Tina', true),
    ('$OLGA', 'customer', 'Olga', false), ('$RIDER2', 'customer', 'Rider Dos', false), ('$DIEGO', 'driver', 'Diego', false);
  INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
    ('$OPS', '5355500021', now()), ('$ADM', '5355500022', now()), ('$MARK', '5355500023', now()),
    ('$ANA', '5355500001', now()), ('$BETO', '5355500002', now()), ('$CARL', '5355500003', now()),
    ('$NORA', '5355500004', NULL), ('$TINA', '5355500005', now()), ('$OLGA', '5355500006', now()),
    ('$RIDER2', '5355500007', now()), ('$DIEGO', '5355500008', now());
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP', '$DIEGO');
  INSERT INTO public.corporate_accounts (id, commission_percent) VALUES ('$CORP', 10);
  INSERT INTO public.platform_config (key, value) VALUES ('support_alert_after_s', '60');
  INSERT INTO public.promotions (id, code, type, discount_percent, discount_fixed_cup, created_at) VALUES
    ('$PERDON', 'PERDON', 'fixed_discount', NULL, 500, now()),
    ('$VIEJO', 'VIEJO', 'fixed_discount', NULL, 300, now() - interval '1 day'),
    ('$BIENV', 'BIENVENIDA', 'percentage_discount', 25, NULL, now() - interval '2 days');
  INSERT INTO public.acquisition_codes (code, label, channel, promotion_id) VALUES ('MOTO', 'Motorenko', 'influencer', '$BIENV');
  UPDATE public.users SET signup_code = 'MOTO' WHERE id = '$ANA';
  $(missed $ANA '3 hours' '2 minutes')
  $(missed $BETO '3 days' '5 minutes')
  INSERT INTO public.rides (customer_id, driver_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at)
    VALUES ('$BETO', '$DP', 'auto_standard', 'completed', $PICK, $DROP, 4000, now() - interval '2 days');
  $(missed $CARL '2 hours' '20 seconds')
  $(missed $NORA '1 day' '3 minutes')
  $(missed $TINA '1 day' '3 minutes')
  $(missed $OLGA '100 days' '4 minutes')" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- the seed failed:"; cat "$FRESHLOG"; return 1; }; }
# the coupons exist only with the migration; without it this fails and the tests below are RED
mark(){ "$BIN/psql" $CONN -d "$1" -qAt -c "UPDATE public.promotions SET grant_only = true, is_public = false WHERE id IN ('$PERDON', '$VIEJO');" >/dev/null 2>&1; }
apply_err(){ local out; if out=$("$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

echo "== reset database =="
fresh $DB || { echo "base failed"; exit 1; }
val "S0 the base carries prod's live bodies" "$LIVE" "$LIVE_MD5"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  mark $DB   # set between the two runs: the second one must leave it alone
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1 || { echo "migration NOT idempotent"; exit 1; }
  val "S1 two runs: one trigger, one constraint, each patch once, and the marked coupons survive" \
    "SELECT count(*) FROM pg_trigger WHERE tgname = 'rides_promo_grant'; SELECT count(*) FROM pg_constraint WHERE conname = 'promotions_grant_only_private'; $MARKERS SELECT count(*) FROM public.promotions WHERE grant_only;" \
    "1;1;1;1;1;2"
else
  mark $DB   # RED: grant_only does not exist yet
fi

echo "== 1. who is on the list =="
val "L1 pending: no driver after 60 s and no ride since; not the 20 s one, not the one who rode, not the test account" \
  "$(tx "$(client $OPS "$LIST_PENDING")")" "Ana Perez,Nora,Olga"
val "L2 the 30-day window leaves the 100-day-old one out" \
  "$(tx "$(client $OPS "SELECT string_agg(full_name, ',' ORDER BY last_failed_at DESC) FROM public.admin_missed_riders('pending', 30);")")" "Ana Perez,Nora"
val "L3 the confirmed phone, or nothing" \
  "$(tx "$(client $OPS "SELECT string_agg(coalesce(phone, '-'), ',' ORDER BY last_failed_at DESC) FROM public.admin_missed_riders('pending', NULL);")")" "5355500001,-,5355500006"
val "L4 the request count and the last one's addresses" \
  "$(tx "$(client $OPS "SELECT failed_requests || '|' || last_pickup || '|' || last_dropoff || '|' || in_segment FROM public.admin_missed_riders('pending', NULL) WHERE user_id = '$ANA';")")" \
  "1|Capitolio|Hotel Nacional|true"
err "L5 marketing does not see it" "$(tx "$(client $MARK "$LIST_PENDING")")" "forbidden"
err "L6 a passenger does not see it" "$(tx "$(client $RIDER2 "$LIST_PENDING")")" "forbidden"
val "L7 an admin sees it" "$(tx "$(client $ADM "$LIST_PENDING")")" "Ana Perez,Nora,Olga"
err "L8 an unknown view is refused" "$(tx "$(client $OPS "SELECT count(*) FROM public.admin_missed_riders('everyone', NULL);")")" "invalid_view"

echo "== 2. writing to someone =="
val "C1 an operator writes to Ana: success, the newest coupon" "$(tx "$GRANT")" "true|PERDON|-"
val "C2 ... one grant, one contact, the phone's claim and one admin_actions row" \
  "$(tx "$GRANT SELECT count(*) FROM public.promotion_grants WHERE user_id = '$ANA' AND promotion_id = '$PERDON'; SELECT count(*) FROM public.missed_ride_contacts WHERE user_id = '$ANA' AND contacted_by = '$OPS' AND grant_id IS NOT NULL; SELECT count(*) FROM public.reward_claims WHERE claim = 'missed_ride_coupon' AND user_id = '$ANA' AND released_at IS NULL; SELECT count(*) FROM public.admin_actions WHERE action = 'missed_rider_contacted' AND admin_id = '$OPS' AND target_id = '$ANA';")" \
  "true|PERDON|-;1;1;1;1"
val "C3 writing again returns the same coupon and adds a contact, not a grant" \
  "$(tx "$GRANT $(client $OPS "$(contact $ANA)") SELECT count(*) FROM public.promotion_grants WHERE user_id = '$ANA'; SELECT count(*) FROM public.missed_ride_contacts WHERE user_id = '$ANA';")" \
  "true|PERDON|-;true|PERDON|-;1;2"
val "C4 a stale failure time is refused and records nothing" \
  "$(tx "SELECT 1 WHERE set_config('t.failed', (now() - interval '5 hours')::text, true) IS NULL; $(client $OPS "$(contact $ANA)") SELECT count(*) FROM public.missed_ride_contacts;")" \
  "missed_rider_changed|-|-;0"
val "C5 no confirmed phone: refused, nothing recorded" \
  "$(tx "$(expect $NORA) $(client $OPS "$(contact $NORA)") SELECT count(*) FROM public.missed_ride_contacts;")" "no_phone|-|-;0"
val "C6 not in the segment: rode since, canceled at once, test account, never missed" \
  "$(tx "$(expect $BETO) $(client $OPS "$(contact $BETO)") $(expect $CARL) $(client $OPS "$(contact $CARL)") $(expect $TINA) $(client $OPS "$(contact $TINA)") $(client $OPS "$(contact $RIDER2 'now()')")")" \
  "not_eligible|-|-;not_eligible|-|-;not_eligible|-|-;not_eligible|-|-"
val "C7 nobody writes to themselves" "$(tx "$(client $OPS "$(contact $OPS 'now()')")")" "self_action|-|-"
val "C8 marketing and a passenger cannot write" \
  "$(tx "$(expect $ANA) $(client $MARK "$(contact $ANA)") $(client $RIDER2 "$(contact $ANA)")")" "forbidden|-|-;forbidden|-|-"
val "C9 with no active coupon the contact is recorded without one" \
  "$(tx "UPDATE public.promotions SET is_active = false WHERE id IN ('$PERDON', '$VIEJO'); $GRANT SELECT count(*) FROM public.promotion_grants; SELECT count(*) FROM public.missed_ride_contacts WHERE grant_id IS NULL;")" \
  "true|-|no_coupon_available;0;1"
val "C10 the same phone on a new account gets no second coupon" \
  "$(tx "$GRANT UPDATE auth.users SET phone = NULL WHERE id = '$ANA'; INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$ANA2', '5355500001', now()); $(missed $ANA2 '2 hours' '3 minutes') $(expect $ANA2) $(client $OPS "$(contact $ANA2)")")" \
  "true|PERDON|-;true|-|already_given"
val "C11 a used coupon is not offered again" \
  "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA)") $(client $OPS "$(contact $ANA)")")" "true|PERDON|-;true|-|coupon_used"
val "C12 a paused coupon is not offered again" \
  "$(tx "$GRANT UPDATE public.promotions SET is_active = false WHERE id = '$PERDON'; $(client $OPS "$(contact $ANA)")")" "true|PERDON|-;true|-|coupon_unusable"
val "C13 the contacted view shows the coupon and who wrote; pending drops her" \
  "$(tx "$GRANT $(client $OPS "$LIST_PENDING SELECT full_name || '|' || coupon_status || '|' || coupon_code || '|' || contacts || '|' || last_contacted_by FROM public.admin_missed_riders('contacted', NULL);")")" \
  "true|PERDON|-;Nora,Olga;Ana Perez|granted|PERDON|1|Oscar Operador"
val "C14 a completed ride after the contact shows as riding again" \
  "$(tx "$GRANT INSERT INTO public.rides (customer_id, driver_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at) VALUES ('$ANA', '$DP', 'auto_standard', 'completed', $PICK, $DROP, 4000, now() + interval '1 minute'); $(client $OPS "SELECT rode_after_contact || '|' || in_segment FROM public.admin_missed_riders('contacted', NULL) WHERE user_id = '$ANA';")")" \
  "true|PERDON|-;true|false"
val "C15 the coupon header shows the newest active coupon" \
  "$(tx "$(client $OPS "SELECT public.admin_missed_ride_coupon() ->> 'code';")")" "PERDON"
err "C16 marketing does not read the coupon header" "$(tx "$(client $MARK "SELECT public.admin_missed_ride_coupon();")")" "forbidden"

echo "== 3. the coupon on the next ride =="
val "A1 Ana's next ride gets the coupon, before her signup promotion" \
  "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "true|PERDON|-;$PERDON|500"
val "A2 a code she types wins" "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA $BIENV)") $(state $R1)")" "true|PERDON|-;$BIENV|1000"
val "A3 not on a delivery or a ride a company pays" \
  "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA '' cargo) $(ride $R2 $ANA '' passenger $CORP)") $(state $R1) $(state $R2)")" \
  "true|PERDON|-;none|0;none|0"
val "A4 once used, the next ride gets the signup promotion instead" \
  "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA) $(ride $R2 $ANA)") $(state $R1) $(state $R2)")" "true|PERDON|-;$PERDON|500;$BIENV|1000"
val "A5 a canceled ride gives the coupon back" \
  "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA)") $(cancel $R1) $(client $ANA "$(ride $R2 $ANA)") $(state $R2)")" "true|PERDON|-;$PERDON|500"
val "A6 someone else typing the code gets nothing" \
  "$(tx "$GRANT $(client $RIDER2 "$(ride $R1 $RIDER2 $PERDON)") $(state $R1)")" "true|PERDON|-;none|0"
val "A7 the code's preview: valid for Ana, invalid for anyone else" \
  "$(tx "$GRANT $(client $ANA "SELECT (r ->> 'valid') || '|' || (r ->> 'discount_amount') FROM (SELECT public.validate_promo_code('PERDON', '$ANA', 4000) AS r) x;") $(client $RIDER2 "SELECT public.validate_promo_code('PERDON', '$RIDER2', 4000) ->> 'error';")")" \
  "true|PERDON|-;true|500;invalid"
val "A8 the apps' prefill: the coupon first, then the signup promotion once it is used" \
  "$(tx "$(client $ANA "$MINE") $GRANT $(client $ANA "$MINE") $(client $ANA "$(ride $R1 $ANA) $MINE")")" \
  "BIENVENIDA|percentage_discount|-|MOTO;true|PERDON|-;PERDON|fixed_discount|500|PERDON;BIENVENIDA|percentage_discount|-|MOTO"
val "A9 a ride made with no JWT is left alone" "$(tx "$GRANT $(ride $R1 $ANA) $(state $R1)")" "true|PERDON|-;none|0"

echo "== 4. data rules =="
err "D1 a grant-only promotion cannot be public" "$(tx "UPDATE public.promotions SET is_public = true WHERE id = '$PERDON';")" "promotions_grant_only_private"
err "D2 a coupon someone holds cannot be deleted" "$(tx "$GRANT DELETE FROM public.promotions WHERE id = '$PERDON';")" "promotion_grants_promotion_id_fkey"
err "D3 one coupon per account" \
  "$(tx "$GRANT INSERT INTO public.promotion_grants (promotion_id, user_id, source, granted_by) VALUES ('$VIEJO', '$ANA', 'missed_ride', '$OPS');")" \
  "promotion_grants_user_source_key"
err "D4 the apps cannot read the grants" "$(tx "$(client $ANA "SELECT count(*) FROM public.promotion_grants;")")" "permission denied for table promotion_grants"
err "D5 ... nor the contacts, not even an operator" "$(tx "$(client $OPS "SELECT count(*) FROM public.missed_ride_contacts;")")" "permission denied for table missed_ride_contacts"
err "D6 anon cannot call the list" "$(tx "SET LOCAL ROLE anon; SELECT count(*) FROM public.admin_missed_riders('pending', NULL);")" "permission denied for function admin_missed_riders"

echo "== 5. shape =="
val "G1 the ride trigger function is SECURITY INVOKER" "SELECT prosecdef FROM pg_proc WHERE proname = 'tg_rides_promo_grant';" "f"
val "G2 BEFORE INSERT row triggers on rides fire in this order" \
  "SELECT string_agg(tgname, ',' ORDER BY tgname COLLATE \"C\") FROM pg_trigger WHERE tgrelid = 'public.rides'::regclass AND NOT tgisinternal AND (tgtype & 7) = 7;" \
  "rides_promo_grant,rides_signup_promo,rides_validate_promo_discount"
val "G3 anon calls none; authenticated calls the four the panel and the apps use, not the two helpers" \
  "SELECT string_agg(has_function_privilege('anon', u.f, 'EXECUTE') || '/' || has_function_privilege('authenticated', u.f, 'EXECUTE'), ',' ORDER BY u.i)
     FROM unnest(ARRAY['public.admin_missed_riders(text,integer)', 'public.admin_missed_ride_coupon()',
                       'public.ops_contact_missed_rider(uuid,timestamptz)', 'public._my_granted_promotion_id()',
                       'public._missed_rider_summary(uuid)', 'public._missed_ride_current_coupon()']) WITH ORDINALITY AS u(f, i);" \
  "false/true,false/true,false/true,false/true,false/false,false/false"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration refuses or catches what it must =="
  fresh_neg(){ fresh $NEG || { echo "negative-proof database failed"; exit 1; }; }
  # mutant FILE SED-SCRIPT: FILE is a copy of the migration with one sed edit; returns 1 when the edit changed nothing
  mutant(){ sed -e "$2" "$MIG" > "$1"; ! cmp -s "$MIG" "$1"; }
  # neg_mutant ID LABEL SED-SCRIPT WANT: a fresh database, the migration with one edit; it has to abort with WANT
  neg_mutant(){ local id="$1" label="$2" script="$3" want="$4" f r; f="$(mktemp)"
    if ! mutant "$f" "$script"; then ko "$id $label" "setup did not change the migration copy"; rm -f "$f"; return; fi
    fresh_neg; r=$(apply_err $NEG "$f"); rm -f "$f"
    echo "$r" | grep -q "$want" && ok "$id $label" || ko "$id $label" "got [$r]"; }
  # drift ID LABEL FUNCTION OLD NEW WANT: one live body differs from prod; the migration has to abort with WANT
  drift(){ local r; fresh_neg
    run $NEG "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('$3'::regprocedure), '$4', '$5'); END \$d\$;" >/dev/null
    r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "$6" && ok "$1 $2" || ko "$1 $2" "got [$r]"; }
  drift N1 "a validator it does not know aborts it" 'public.tg_rides_validate_promo_discount()' \
    'v_cap INTEGER;' 'v_cap INTEGER; -- drift' "tg_rides_validate_promo_discount() is not the body read from prod"
  drift N2 "a validate_promo_code it does not know aborts it" 'public.validate_promo_code(text,uuid,integer)' \
    'v_discount INTEGER := 0;' 'v_discount INTEGER := 0; -- drift' "validate_promo_code(text,uuid,integer) is not the body read from prod"
  drift N3 "a get_my_signup_promotion it does not know aborts it" 'public.get_my_signup_promotion()' \
    'v_uid uuid := auth.uid();' 'v_uid uuid := auth.uid(); -- drift' "get_my_signup_promotion() is not the body read from prod"
  fresh_neg
  run $NEG "ALTER TRIGGER rides_validate_promo_discount ON public.rides RENAME TO rides_a_validate_promo_discount;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "rides_promo_grant has to fire before" \
    && ok "N4 a validator that would fire first aborts it" || ko "N4 a validator that would fire first aborts it" "got [$r]"
  fresh_neg
  run $NEG "CREATE FUNCTION public.zz_rogue() RETURNS boolean LANGUAGE sql AS 'SELECT public.is_ops_staff()';" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "other functions call the ops checks" \
    && ok "N5 another function calling the ops checks aborts it" || ko "N5 another function calling the ops checks aborts it" "got [$r]"
  fresh_neg
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $NEG "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ] && [ "$(run $NEG "$NEWFNS")" = "$(run $DB "$NEWFNS")" ] \
     && [ "$(run $NEG "SELECT count(*) FROM pg_proc WHERE position(chr(13) IN prosrc) > 0")" = "0" ]; then
    ok "N6 pasted with CRLF line ends, the bodies match the LF ones"
  else ko "N6 pasted with CRLF line ends, the bodies match the LF ones" "apply [$r], bodies [$(run $NEG "$NEWFNS")]"; fi
  neg_mutant N7 "a SECURITY DEFINER trigger function aborts it" \
    '/^CREATE OR REPLACE FUNCTION public.tg_rides_promo_grant()$/,/^AS \$function\$$/s/^ LANGUAGE plpgsql$/ LANGUAGE plpgsql SECURITY DEFINER/' \
    "must be SECURITY INVOKER"
  neg_mutant N8 "a grants table open to the apps aborts it" \
    's/^REVOKE ALL ON public.promotion_grants FROM PUBLIC, anon, authenticated;$/GRANT SELECT ON public.promotion_grants TO authenticated;/' \
    "is open to a client"
  neg_mutant N9 "an ops function that logs nothing aborts it" \
    's/INSERT INTO public.admin_actions (admin_id/INSERT INTO public.not_admin_actions (admin_id/' \
    "is not a proper ops function"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1
  echo "== bodies after 00674 (copy into CLAUDE.md) =="
  "$BIN/psql" $CONN -d "$DB" -qAt -c "SELECT string_agg(proname || ' ' || md5(prosrc) || '/' || length(prosrc), E'\n' ORDER BY proname COLLATE \"C\") FROM pg_proc
           WHERE pronamespace = 'public'::regnamespace AND proname IN ('_missed_rider_summary', '_missed_ride_current_coupon',
             '_my_granted_promotion_id', 'admin_missed_riders', 'admin_missed_ride_coupon', 'ops_contact_missed_rider',
             'tg_rides_promo_grant', 'tg_rides_validate_promo_discount', 'validate_promo_code', 'get_my_signup_promotion')" | tr -d '\r'
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 3: Run it without the migration (RED)**

Run: `PGBIN=<bin> PGPORT=<port> bash supabase/tests/00674/run.sh none`
Expected: `PASS  S0 the base carries prod's live bodies`, every other test `FAIL` (the functions and the column do not exist), last line `== result: 1 passed, 42 failed ==`. If S0 fails, the base does not match prod: stop and compare the md5 it printed with prod's (`SELECT proname, md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE ...`).

- [ ] **Step 4: Commit**

```bash
git add supabase/tests/00674/extra.sql supabase/tests/00674/run.sh
git commit -m "test(00674): rehearsal for the missed-ride apology coupon (red)"
```

---

### Task 2: Migration 00674 (GREEN)

**Files:**
- Create: `supabase/migrations/00674_missed_ride_apology_coupon.sql`

The file must contain **no backslash**: the prod rehearsal (Task 10) embeds it in a dollar-quoted literal.

- [ ] **Step 1: Write the migration**

```sql
-- 00674: an apology coupon for people whose ride found no driver.
--
-- Spec: docs/superpowers/specs/2026-11-02-missed-ride-apology-coupon-design.md
--
-- The panel's /missed-rides page lists passengers whose request was canceled with no driver after
-- waiting support_alert_after_s, with no completed ride since. An operator (or an admin) writes
-- to each one by WhatsApp:
--
--   admin_missed_riders(view, days)       the list, for operations staff;
--   admin_missed_ride_coupon()            the coupon in use: the newest active grant-only promotion;
--   ops_contact_missed_rider(user, at)    records the contact and, once per confirmed phone ever,
--                                         gives the person that coupon (promotion_grants).
--
-- The coupon applies on its own on the person's next passenger ride (rides_promo_grant, before
-- rides_signup_promo and the promo validator). Nobody else can use it, even typing its code: the
-- validator and validate_promo_code refuse a grant-only promotion without a grant. The installed
-- apps prefill it through get_my_signup_promotion, which returns it first.
--
-- tg_rides_promo_grant is SECURITY INVOKER on purpose, like tg_rides_signup_promo (00665): it
-- tells a ride a person creates (current_user anon or authenticated) from one a SECURITY DEFINER
-- function, the cron or the service role creates.

SET LOCAL lock_timeout = '5s';

-- Rides before promotions, the order a ride write with a promotion takes (00665). Inside DO so a
-- second run in autocommit still works (a bare LOCK needs a transaction block).
DO $lock$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE public.rides IN SHARE ROW EXCLUSIVE MODE;
END
$lock$;

-- 0. The three bodies it patches are the ones read from prod on 2026-11-02, or already patched.
DO $guard$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT f.fn, f.want, md5(replace(p.prosrc, chr(13), '')) AS got,
           position(f.marker IN p.prosrc) > 0 AS patched
      FROM (VALUES
        ('public.tg_rides_validate_promo_discount()', 'cad4cf62d95e5055950b67564c6da7f4',
         '00674: a grant-only promotion counts only for the person it was given to.'),
        ('public.validate_promo_code(text,uuid,integer)', '952805817a1ea73ab0fbb93f28884a30',
         '00674: a grant-only promotion is invalid for anyone it was not given to.'),
        ('public.get_my_signup_promotion()', 'b4209984f4bd3e9e822e28e3e28eb3c9',
         '00674: an apology coupon goes first')
      ) AS f(fn, want, marker)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.fn)
  LOOP
    IF v_row.got IS NULL THEN
      RAISE EXCEPTION '00674: % does not exist', v_row.fn;
    END IF;
    IF NOT v_row.patched AND v_row.got <> v_row.want THEN
      RAISE EXCEPTION '00674: % is not the body read from prod (md5 %)', v_row.fn, v_row.got;
    END IF;
  END LOOP;
END
$guard$;

-- 1. Data.
ALTER TABLE public.promotions ADD COLUMN IF NOT EXISTS grant_only boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.promotions.grant_only IS
  '00674: an apology coupon. Only a person with a promotion_grants row can use it, and it is never public.';

DO $constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.promotions'::regclass AND conname = 'promotions_grant_only_private') THEN
    ALTER TABLE public.promotions ADD CONSTRAINT promotions_grant_only_private
      CHECK (NOT (grant_only AND COALESCE(is_public, true)));
  END IF;
END
$constraint$;

-- One apology coupon per account. The phone rule is the reward_claims row (claim
-- 'missed_ride_coupon', 00658), which outlives the account. granted_by and contacted_by have no
-- foreign key, like ride_dispute_escalations (00673), so deleting a team account is never blocked.
CREATE TABLE IF NOT EXISTS public.promotion_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES public.promotions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source = 'missed_ride'),
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotion_grants_user_source_key UNIQUE (user_id, source)
);
CREATE INDEX IF NOT EXISTS promotion_grants_promotion_idx ON public.promotion_grants (promotion_id);
ALTER TABLE public.promotion_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promotion_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.promotion_grants TO service_role;

CREATE TABLE IF NOT EXISTS public.missed_ride_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  contacted_by uuid NOT NULL,
  contacted_at timestamptz NOT NULL DEFAULT now(),
  last_failed_ride_id uuid,
  grant_id uuid REFERENCES public.promotion_grants(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS missed_ride_contacts_user_idx ON public.missed_ride_contacts (user_id, contacted_at DESC);
ALTER TABLE public.missed_ride_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.missed_ride_contacts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.missed_ride_contacts TO service_role;

-- 2. Helpers.

-- Per person: the latest passenger request canceled with no driver after waiting
-- support_alert_after_s, how many there were, and whether the person is in the segment: an active,
-- non-test, non-team, non-system account with no completed ride created after that request.
CREATE OR REPLACE FUNCTION public._missed_rider_summary(p_user_id uuid DEFAULT NULL)
 RETURNS TABLE (user_id uuid, last_failed_ride_id uuid, last_failed_at timestamptz, last_pickup text,
                last_dropoff text, failed_requests bigint, eligible boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH cfg AS (
    SELECT make_interval(secs => public.get_platform_config_numeric('support_alert_after_s', 60)::double precision) AS wait
  ), f AS (
    SELECT r.id, r.customer_id, r.canceled_at, r.pickup_address::text AS pickup, r.dropoff_address::text AS dropoff
      FROM public.rides r CROSS JOIN cfg
     WHERE r.status = 'canceled'
       AND r.driver_id IS NULL
       AND COALESCE(r.ride_mode, 'passenger') = 'passenger'
       AND r.canceled_at IS NOT NULL
       AND (p_user_id IS NULL OR r.customer_id = p_user_id)
       AND r.canceled_at - GREATEST(r.created_at, COALESCE(r.scheduled_at, r.created_at)) >= cfg.wait
  ), last AS (
    SELECT DISTINCT ON (f.customer_id) f.customer_id, f.id, f.canceled_at, f.pickup, f.dropoff
      FROM f ORDER BY f.customer_id, f.canceled_at DESC, f.id
  ), cnt AS (
    SELECT f.customer_id, count(*) AS n FROM f GROUP BY f.customer_id
  )
  SELECT l.customer_id, l.id, l.canceled_at, l.pickup, l.dropoff, c.n,
         (u.is_active
          AND NOT COALESCE(u.is_test, false)
          AND u.role::text NOT IN ('admin', 'super_admin', 'marketing', 'operator')
          AND l.customer_id NOT IN ('00000000-0000-0000-0000-000000000001'::uuid,
                                    '00000000-0000-0000-0000-000000000099'::uuid)
          AND NOT EXISTS (SELECT 1 FROM public.rides r2
                           WHERE r2.customer_id = l.customer_id AND r2.status = 'completed'
                             AND r2.created_at > l.canceled_at))
    FROM last l
    JOIN cnt c ON c.customer_id = l.customer_id
    JOIN public.users u ON u.id = l.customer_id;
$function$;
REVOKE ALL ON FUNCTION public._missed_rider_summary(uuid) FROM PUBLIC, anon, authenticated;

-- The coupon an operator gives now: the newest active grant-only promotion inside its dates with
-- uses left. The page header and the grant both read it, so they always pick the same one.
CREATE OR REPLACE FUNCTION public._missed_ride_current_coupon()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT p.id
    FROM public.promotions p
   WHERE p.grant_only
     AND p.is_active
     AND (p.valid_from IS NULL OR p.valid_from <= now())
     AND (p.valid_until IS NULL OR p.valid_until > now())
     AND (p.max_uses IS NULL OR p.current_uses < p.max_uses)
   ORDER BY p.created_at DESC, p.id
   LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public._missed_ride_current_coupon() FROM PUBLIC, anon, authenticated;

-- The caller's apology coupon, only while the validator would accept it now. Returning a used one
-- would make rides_promo_grant attach it, the validator drop it, and the signup promotion never
-- apply again (rides_signup_promo skips a ride that already names a promotion).
CREATE OR REPLACE FUNCTION public._my_granted_promotion_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT p.id
    FROM public.promotion_grants g
    JOIN public.promotions p ON p.id = g.promotion_id
   WHERE g.user_id = auth.uid()
     AND g.source = 'missed_ride'
     AND p.is_active
     AND (p.valid_from IS NULL OR p.valid_from <= now())
     AND (p.valid_until IS NULL OR p.valid_until > now())
     AND (p.max_uses IS NULL OR p.current_uses < p.max_uses)
     AND NOT EXISTS (SELECT 1 FROM public.promotion_uses pu
                      WHERE pu.promotion_id = p.id AND pu.user_id = auth.uid())
     AND public._reward_claim_status(auth.uid(), 'promo:' || p.id::text) = 'free'
     AND NOT (COALESCE(p.first_ride_only, false) AND EXISTS (
           SELECT 1 FROM public.rides r WHERE r.customer_id = auth.uid() AND r.status = 'completed'));
$function$;
REVOKE ALL ON FUNCTION public._my_granted_promotion_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._my_granted_promotion_id() TO authenticated, service_role;

-- 3. The panel: the list, the coupon header, the contact.

CREATE OR REPLACE FUNCTION public.admin_missed_riders(p_view text DEFAULT 'pending', p_days integer DEFAULT 30)
 RETURNS TABLE (user_id uuid, full_name text, phone text, failed_requests bigint, last_failed_at timestamptz,
                last_failed_ride_id uuid, last_pickup text, last_dropoff text, in_segment boolean,
                contacts bigint, last_contacted_at timestamptz, last_contacted_by text,
                coupon_status text, coupon_code text, phone_already_rewarded boolean, rode_after_contact boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_since timestamptz;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo el equipo de operaciones ve esta lista.', DETAIL = 'forbidden';
  END IF;
  IF p_view IS NULL OR p_view NOT IN ('pending', 'contacted') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Vista desconocida.', DETAIL = 'invalid_view';
  END IF;
  IF p_days IS NOT NULL AND p_days < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Período inválido.', DETAIL = 'invalid_days';
  END IF;
  v_since := CASE WHEN p_days IS NULL THEN NULL ELSE now() - make_interval(days => p_days) END;

  RETURN QUERY
  WITH s AS (
    SELECT * FROM public._missed_rider_summary(NULL)
  ), ct AS (
    SELECT c.user_id, count(*) AS n, min(c.contacted_at) AS first_at, max(c.contacted_at) AS last_at
      FROM public.missed_ride_contacts c GROUP BY c.user_id
  ), lastc AS (
    SELECT DISTINCT ON (c.user_id) c.user_id, c.contacted_by
      FROM public.missed_ride_contacts c ORDER BY c.user_id, c.contacted_at DESC, c.id
  ), picked AS (
    SELECT s.user_id FROM s LEFT JOIN ct ON ct.user_id = s.user_id
     WHERE p_view = 'pending' AND s.eligible AND ct.user_id IS NULL
       AND (v_since IS NULL OR s.last_failed_at >= v_since)
    UNION ALL
    SELECT ct.user_id FROM ct
     WHERE p_view = 'contacted' AND (v_since IS NULL OR ct.last_at >= v_since)
  )
  SELECT pk.user_id,
         u.full_name::text,
         CASE WHEN au.phone_confirmed_at IS NOT NULL AND COALESCE(au.phone, '') <> '' THEN au.phone::text END,
         COALESCE(s.failed_requests, 0)::bigint,
         s.last_failed_at,
         s.last_failed_ride_id,
         s.last_pickup,
         s.last_dropoff,
         COALESCE(s.eligible, false),
         COALESCE(ct.n, 0)::bigint,
         ct.last_at,
         cu.full_name::text,
         CASE
           WHEN g.id IS NULL THEN 'none'
           WHEN EXISTS (SELECT 1 FROM public.promotion_uses pu
                         WHERE pu.promotion_id = g.promotion_id AND pu.user_id = pk.user_id) THEN 'used'
           WHEN NOT (pr.is_active
                     AND (pr.valid_from IS NULL OR pr.valid_from <= now())
                     AND (pr.valid_until IS NULL OR pr.valid_until > now())
                     AND (pr.max_uses IS NULL OR pr.current_uses < pr.max_uses)) THEN 'unusable'
           ELSE 'granted'
         END,
         pr.code::text,
         (g.id IS NULL AND public._reward_claim_status(pk.user_id, 'missed_ride_coupon') = 'taken'),
         (ct.first_at IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.rides r3
             WHERE r3.customer_id = pk.user_id AND r3.status = 'completed' AND r3.created_at > ct.first_at))
    FROM picked pk
    JOIN public.users u ON u.id = pk.user_id
    LEFT JOIN auth.users au ON au.id = pk.user_id
    LEFT JOIN s ON s.user_id = pk.user_id
    LEFT JOIN ct ON ct.user_id = pk.user_id
    LEFT JOIN lastc lc ON lc.user_id = pk.user_id
    LEFT JOIN public.users cu ON cu.id = lc.contacted_by
    LEFT JOIN public.promotion_grants g ON g.user_id = pk.user_id AND g.source = 'missed_ride'
    LEFT JOIN public.promotions pr ON pr.id = g.promotion_id
   ORDER BY CASE WHEN p_view = 'pending' THEN s.last_failed_at ELSE ct.last_at END DESC NULLS LAST, pk.user_id
   LIMIT 500;
END
$function$;
REVOKE ALL ON FUNCTION public.admin_missed_riders(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_missed_riders(text, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_missed_ride_coupon()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_ops_staff() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo el equipo de operaciones ve el cupón de disculpa.', DETAIL = 'forbidden';
  END IF;
  RETURN (SELECT jsonb_build_object('id', p.id, 'code', p.code, 'type', p.type,
                                    'discount_percent', p.discount_percent, 'discount_fixed_cup', p.discount_fixed_cup,
                                    'valid_until', p.valid_until, 'max_uses', p.max_uses, 'current_uses', p.current_uses)
            FROM public.promotions p WHERE p.id = public._missed_ride_current_coupon());
END
$function$;
REVOKE ALL ON FUNCTION public.admin_missed_ride_coupon() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_missed_ride_coupon() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ops_contact_missed_rider(p_user_id uuid, p_expected_last_failed_at timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me      uuid := auth.uid();
  v_sum     record;
  v_phone   text;
  v_name    text;
  v_grant   public.promotion_grants%ROWTYPE;
  v_promo   public.promotions%ROWTYPE;
  v_coupon  uuid;
  v_claim   text;
  v_usable  boolean := false;
  v_reason  text;
  v_contact uuid;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_user_id IS NULL OR p_expected_last_failed_at IS NULL THEN
    RETURN jsonb_build_object('error', 'invalid_request');
  END IF;
  IF p_user_id = v_me THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;

  -- Two people writing at once give one coupon: the second waits here and then finds the grant.
  PERFORM 1 FROM public.users WHERE id = p_user_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;

  SELECT * INTO v_sum FROM public._missed_rider_summary(p_user_id);
  IF NOT FOUND OR NOT v_sum.eligible THEN
    RETURN jsonb_build_object('error', 'not_eligible');
  END IF;
  IF v_sum.last_failed_at IS DISTINCT FROM p_expected_last_failed_at THEN
    RETURN jsonb_build_object('error', 'missed_rider_changed', 'last_failed_at', v_sum.last_failed_at);
  END IF;

  SELECT au.phone INTO v_phone FROM auth.users au
   WHERE au.id = p_user_id AND au.phone_confirmed_at IS NOT NULL AND COALESCE(au.phone, '') <> '';
  IF v_phone IS NULL THEN
    RETURN jsonb_build_object('error', 'no_phone');
  END IF;
  SELECT u.full_name INTO v_name FROM public.users u WHERE u.id = p_user_id;

  SELECT * INTO v_grant FROM public.promotion_grants g
   WHERE g.user_id = p_user_id AND g.source = 'missed_ride';
  IF v_grant.id IS NULL THEN
    v_coupon := public._missed_ride_current_coupon();
    IF v_coupon IS NULL THEN
      v_reason := 'no_coupon_available';
    ELSE
      v_claim := public._claim_reward(p_user_id, 'missed_ride_coupon');
      IF v_claim = 'claimed' THEN
        INSERT INTO public.promotion_grants (promotion_id, user_id, source, granted_by)
        VALUES (v_coupon, p_user_id, 'missed_ride', v_me)
        RETURNING * INTO v_grant;
        v_usable := true;
      ELSIF v_claim = 'taken' THEN
        -- The phone got an apology coupon before, from this or another account.
        v_reason := 'already_given';
      ELSE
        RETURN jsonb_build_object('error', 'no_phone');
      END IF;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.promotion_uses pu
                 WHERE pu.promotion_id = v_grant.promotion_id AND pu.user_id = p_user_id) THEN
    v_reason := 'coupon_used';
  ELSIF NOT EXISTS (SELECT 1 FROM public.promotions p
                     WHERE p.id = v_grant.promotion_id AND p.is_active
                       AND (p.valid_from IS NULL OR p.valid_from <= now())
                       AND (p.valid_until IS NULL OR p.valid_until > now())
                       AND (p.max_uses IS NULL OR p.current_uses < p.max_uses)) THEN
    v_reason := 'coupon_unusable';
  ELSE
    v_usable := true;
  END IF;

  IF v_grant.id IS NOT NULL THEN
    SELECT * INTO v_promo FROM public.promotions WHERE id = v_grant.promotion_id;
  END IF;

  INSERT INTO public.missed_ride_contacts (user_id, contacted_by, last_failed_ride_id, grant_id)
  VALUES (p_user_id, v_me, v_sum.last_failed_ride_id, v_grant.id)
  RETURNING id INTO v_contact;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (v_me, 'missed_rider_contacted', 'user', p_user_id::text,
          jsonb_build_object('contact_id', v_contact, 'grant_id', v_grant.id, 'promotion_code', v_promo.code,
                             'last_failed_ride_id', v_sum.last_failed_ride_id, 'coupon_reason', v_reason));

  RETURN jsonb_build_object(
    'success', true,
    'phone', v_phone,
    'full_name', v_name,
    'last_failed_at', v_sum.last_failed_at,
    'coupon', CASE WHEN v_usable THEN jsonb_build_object(
                'code', v_promo.code, 'type', v_promo.type, 'discount_percent', v_promo.discount_percent,
                'discount_fixed_cup', v_promo.discount_fixed_cup, 'valid_until', v_promo.valid_until) END,
    'coupon_reason', v_reason);
END
$function$;
REVOKE ALL ON FUNCTION public.ops_contact_missed_rider(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_contact_missed_rider(uuid, timestamptz) TO authenticated, service_role;

-- 4. The coupon on the person's next ride.
CREATE OR REPLACE FUNCTION public.tg_rides_promo_grant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_promo uuid;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- Never block the ride: any error here leaves it without the coupon.
  BEGIN
    IF auth.uid() IS NULL
       OR NEW.customer_id IS DISTINCT FROM auth.uid()
       OR NEW.promo_code_id IS NOT NULL
       OR COALESCE(NEW.ride_mode, 'passenger') <> 'passenger'
       OR NEW.corporate_account_id IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_promo := public._my_granted_promotion_id();
    IF v_promo IS NULL OR public.is_admin() THEN
      RETURN NEW;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00674 tg_rides_promo_grant: lookup failed for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  -- The validator, which fires later, applies every rule as for a typed code.
  NEW.promo_code_id := v_promo;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER rides_promo_grant
  BEFORE INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_promo_grant();

-- 5. In-place patches of the live bodies (each text exactly once; skipped when already patched).
DO $patch$
DECLARE
  v_row  record;
  v_src  text;
  v_hits integer;
BEGIN
  FOR v_row IN
    SELECT f.fn::regprocedure AS fn, f.marker,
           replace(f.old_text, chr(13), '') AS old_text, replace(f.new_text, chr(13), '') AS new_text
      FROM (VALUES
        ('public.tg_rides_validate_promo_discount()',
         '00674: a grant-only promotion counts only for the person it was given to.',
         $o1$  IF v_promo IS NULL
     OR NOT v_promo.is_active$o1$,
         $n1$  IF v_promo IS NULL
     -- 00674: a grant-only promotion counts only for the person it was given to.
     OR (COALESCE(v_promo.grant_only, false) AND NOT EXISTS (
           SELECT 1 FROM public.promotion_grants g
            WHERE g.promotion_id = v_promo.id AND g.user_id = NEW.customer_id))
     OR NOT v_promo.is_active$n1$),
        ('public.validate_promo_code(text,uuid,integer)',
         '00674: a grant-only promotion is invalid for anyone it was not given to.',
         $o2$  IF v_promo IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;$o2$,
         $n2$  IF v_promo IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;

  -- 00674: a grant-only promotion is invalid for anyone it was not given to.
  IF COALESCE(v_promo.grant_only, false) AND NOT EXISTS (
    SELECT 1 FROM public.promotion_grants g
     WHERE g.promotion_id = v_promo.id AND g.user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;$n2$),
        ('public.get_my_signup_promotion()',
         '00674: an apology coupon goes first',
         $o3$  -- The rules tg_rides_validate_promo_discount applies when the ride is$o3$,
         $n3$  -- 00674: an apology coupon goes first, as rides_promo_grant applies it before
  -- rides_signup_promo. signup_code carries the coupon's own code.
  RETURN QUERY
  SELECT p.code::text, p.type::text, p.discount_percent::numeric, p.discount_fixed_cup::integer,
         COALESCE(p.first_ride_only, false), p.valid_until::timestamptz, p.code::text
    FROM public.promotions p
   WHERE p.id = public._my_granted_promotion_id();
  IF FOUND THEN
    RETURN;
  END IF;
  -- The rules tg_rides_validate_promo_discount applies when the ride is$n3$)
      ) AS f(fn, marker, old_text, new_text)
  LOOP
    v_src := pg_get_functiondef(v_row.fn);
    CONTINUE WHEN position(v_row.marker IN v_src) > 0;
    v_hits := (length(v_src) - length(replace(v_src, v_row.old_text, ''))) / length(v_row.old_text);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '00674: % has the text to patch % times, not once', v_row.fn, v_hits;
    END IF;
    EXECUTE replace(v_src, v_row.old_text, v_row.new_text);
  END LOOP;
END
$patch$;

-- 6. Pasted from Windows (CRLF), the new bodies carry a carriage return: rewrite them without it.
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._missed_rider_summary(uuid)', 'public._missed_ride_current_coupon()',
    'public._my_granted_promotion_id()', 'public.admin_missed_riders(text,integer)',
    'public.admin_missed_ride_coupon()', 'public.ops_contact_missed_rider(uuid,timestamptz)',
    'public.tg_rides_promo_grant()']::regprocedure[]
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
  v_ours      text;
  v_signup    text;
  v_validator text;
  v_set       text;
  v_row       record;
BEGIN
  -- BEFORE ROW triggers fire in name order (C collation).
  SELECT t.tgname::text INTO v_ours FROM pg_trigger t
   WHERE t.tgrelid = 'public.rides'::regclass AND t.tgfoid = 'public.tg_rides_promo_grant()'::regprocedure
     AND t.tgenabled <> 'D' AND (t.tgtype & 7) = 7;
  SELECT min(t.tgname::text COLLATE "C") INTO v_signup FROM pg_trigger t
   WHERE t.tgrelid = 'public.rides'::regclass AND t.tgfoid = 'public.tg_rides_signup_promo()'::regprocedure
     AND t.tgenabled <> 'D' AND (t.tgtype & 7) = 7;
  SELECT min(t.tgname::text COLLATE "C") INTO v_validator FROM pg_trigger t
   WHERE t.tgrelid = 'public.rides'::regclass AND t.tgfoid = 'public.tg_rides_validate_promo_discount()'::regprocedure
     AND t.tgenabled <> 'D' AND (t.tgtype & 7) = 7;
  IF v_ours IS NULL OR v_signup IS NULL OR v_validator IS NULL
     OR NOT (v_ours COLLATE "C" < v_signup COLLATE "C" AND v_ours COLLATE "C" < v_validator COLLATE "C") THEN
    RAISE EXCEPTION '00674: rides_promo_grant has to fire before rides_signup_promo and the promo validator (ours %, signup %, validator %)',
      v_ours, v_signup, v_validator;
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.tg_rides_promo_grant()'::regprocedure) THEN
    RAISE EXCEPTION '00674: tg_rides_promo_grant() must be SECURITY INVOKER: current_user tells a client insert apart';
  END IF;

  FOR v_row IN
    SELECT f.fn::regprocedure AS fn, f.client
      FROM (VALUES ('public.admin_missed_riders(text,integer)', true), ('public.admin_missed_ride_coupon()', true),
                   ('public.ops_contact_missed_rider(uuid,timestamptz)', true), ('public._my_granted_promotion_id()', true),
                   ('public._missed_rider_summary(uuid)', false), ('public._missed_ride_current_coupon()', false)) AS f(fn, client)
  LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_row.fn) THEN
      RAISE EXCEPTION '00674: % lost SECURITY DEFINER', v_row.fn;
    END IF;
    IF has_function_privilege('anon', v_row.fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_row.fn, 'EXECUTE') IS DISTINCT FROM v_row.client THEN
      RAISE EXCEPTION '00674: the EXECUTE grants of % are not what they must be', v_row.fn;
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT f.fn::regprocedure AS fn, f.marker
      FROM (VALUES ('public.tg_rides_validate_promo_discount()', '00674: a grant-only promotion counts only'),
                   ('public.validate_promo_code(text,uuid,integer)', '00674: a grant-only promotion is invalid'),
                   ('public.get_my_signup_promotion()', '00674: an apology coupon goes first')) AS f(fn, marker)
  LOOP
    IF (SELECT (length(prosrc) - length(replace(prosrc, v_row.marker, ''))) / length(v_row.marker)
          FROM pg_proc WHERE oid = v_row.fn) <> 1 THEN
      RAISE EXCEPTION '00674: % does not carry its patch exactly once', v_row.fn;
    END IF;
  END LOOP;

  FOR v_row IN SELECT unnest(ARRAY['public.promotion_grants', 'public.missed_ride_contacts'])::regclass AS t LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_row.t)
       OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_row.t)
       OR has_table_privilege('anon', v_row.t, 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', v_row.t, 'SELECT,INSERT,UPDATE,DELETE')
       OR NOT (has_table_privilege('service_role', v_row.t, 'SELECT') AND has_table_privilege('service_role', v_row.t, 'INSERT')
               AND has_table_privilege('service_role', v_row.t, 'UPDATE') AND has_table_privilege('service_role', v_row.t, 'DELETE')) THEN
      RAISE EXCEPTION '00674: % is open to a client, or closed to the service role', v_row.t;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.promotions'::regclass
                  AND conname = 'promotions_grant_only_private' AND contype = 'c') THEN
    RAISE EXCEPTION '00674: a grant-only promotion could be public';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.promotion_grants'::regclass AND contype = 'f'
                  AND confrelid = 'public.promotions'::regclass AND confdeltype = 'r') THEN
    RAISE EXCEPTION '00674: promotion_grants.promotion_id has to reference promotions ON DELETE RESTRICT';
  END IF;

  -- Only these functions call the ops helpers or the operator checks: 00668's nineteen, 00671's
  -- eleven, 00672's thirteen, 00673's eighteen and this migration's three.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '
                    ORDER BY p.proname) INTO v_set
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosrc ~ '(is_operator|is_ops_staff|_ops_acting_on|_ops_allow|_ops_target_refusal|_ops_user_push|_ops_notice_push|_ops_is_ride_party)[[:space:]]*[(]'
    AND p.proname NOT IN ('is_operator', 'is_ops_staff', '_ops_acting_on', '_ops_allow',
      -- 00668
      '_panel_driver_churn_risk', 'admin_active_ride_context', 'admin_get_online_fleet',
      'admin_incomplete_driver_signups', 'admin_launch_pulse', 'admin_ride_assist_candidates',
      'admin_ride_assist_context', 'admin_support_waiting_rides', 'get_admin_dashboard_metrics',
      'get_admin_wallet_stats', 'get_corporate_balance', 'get_corporate_employees',
      'get_driver_utilization', 'get_peak_hours', 'get_product_failures', 'get_rides_by_day',
      'get_rides_by_payment_method', 'get_rides_by_service_type', 'get_top_drivers',
      -- 00671
      'enforce_ride_transition', 'enforce_ride_update_columns', 'tg_rides_validate_actuals',
      'complete_ride_and_pay', 'admin_offer_ride_to_driver', 'admin_assign_ride_to_driver',
      'admin_change_ride_service', 'admin_release_active_ride', 'admin_advance_active_ride',
      'admin_complete_active_ride', 'admin_cancel_ride',
      -- 00672
      'tg_driver_profiles_protect_admin_fields', 'tg_users_protect_admin_fields',
      'tg_driver_documents_protect_review', 'tg_corporate_accounts_protect_admin_fields',
      'tg_fleet_members_protect', '_ops_user_push', '_ops_target_refusal', 'ops_set_driver_status',
      'ops_review_driver_document', 'ops_add_driver_document', 'ops_log_driver_outreach',
      'ops_review_fleet_account', 'ops_review_fleet_member',
      -- 00673
      'tg_ride_disputes_protect_columns', 'admin_set_user_active', 'detect_collusion_reviews',
      'apply_collusion_sanction', 'reverse_collusion_sanction', '_ops_notice_push', '_ops_is_ride_party',
      'ops_update_ticket', 'ops_reply_ticket', 'ops_update_incident', 'ops_update_lost_item',
      'ops_update_dispute', 'ops_resolve_dispute_without_refund', 'ops_escalate_dispute',
      'admin_refund_escalated_dispute', 'ops_set_review_visibility', 'ops_resolve_fraud_alert',
      -- 00674
      'admin_missed_riders', 'admin_missed_ride_coupon', 'ops_contact_missed_rider');
  IF v_set IS NOT NULL THEN
    RAISE EXCEPTION '00674: other functions call the ops checks: %', v_set;
  END IF;

  -- Each ops function: SECURITY DEFINER, out of anon's reach, open to authenticated, and it logs.
  FOR v_row IN
    SELECT p.oid::regprocedure AS fn, p.prosecdef, p.prosrc FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND left(p.proname, 4) = 'ops_'
  LOOP
    IF NOT v_row.prosecdef
       OR has_function_privilege('anon', v_row.fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_row.fn, 'EXECUTE')
       OR position('INSERT INTO public.admin_actions' IN v_row.prosrc) = 0 THEN
      RAISE EXCEPTION '00674: % is not a proper ops function', v_row.fn;
    END IF;
  END LOOP;
END
$check$;
```

Note: the allowlist regex uses `[[:space:]]*[(]` instead of `\s*\(` (00673) so the file has no backslash; the two match the same calls.

- [ ] **Step 2: Check the file has no backslash and no CR**

Run: `grep -c '\\' supabase/migrations/00674_missed_ride_apology_coupon.sql; tr -cd '\r' < supabase/migrations/00674_missed_ride_apology_coupon.sql | wc -c`
Expected: `0` and `0`.

- [ ] **Step 3: Run the rehearsal with the migration (GREEN)**

Run: `PGBIN=<bin> PGPORT=<port> bash supabase/tests/00674/run.sh supabase/migrations/00674_missed_ride_apology_coupon.sql`
Expected: every line `PASS`, last line `== result: 53 passed, 0 failed ==`, and the list of bodies printed under "bodies after 00674". Save that list: CLAUDE.md (Task 11) records it.

If a test fails, fix the migration (not the test) unless the test contradicts the spec; re-run until 0 failed.

- [ ] **Step 4: Run the migration-grants check**

Run: `pnpm check:migration-grants`
Expected: passes (both tables have GRANT with `service_role`).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00674_missed_ride_apology_coupon.sql
git commit -m "feat(00674): apology coupon for people whose ride found no driver"
```

---

### Task 3: The apology message (`@tricigo/utils`)

**Files:**
- Create: `packages/utils/src/missedRideOutreach.ts`
- Create: `packages/utils/src/__tests__/missedRideOutreach.test.ts`
- Modify: `packages/utils/src/index.ts` (after the `driverOutreach` exports, line ~196)
- Modify: `packages/utils/package.json` (`exports`, after `"./driverOutreach"`)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { apologyDiscountText, cubaDayMonth, missedRideApologyMessage } from '../missedRideOutreach';

const FIXED = { type: 'fixed_discount', discountPercent: null, discountFixedCup: 500, validUntil: null };
const PERCENT = { type: 'percentage_discount', discountPercent: 25, discountFixedCup: null, validUntil: null };

describe('cubaDayMonth', () => {
  it("writes the day in Cuba's clock", () => {
    // 2026-10-29 02:00 UTC is still the 28th in Havana (UTC-4).
    expect(cubaDayMonth('2026-10-29T02:00:00Z')).toBe('28 de octubre');
  });
});

describe('apologyDiscountText', () => {
  it('formats a fixed amount in CUP', () => {
    expect(apologyDiscountText(FIXED)).toBe('500 CUP');
  });

  it('formats a percentage', () => {
    expect(apologyDiscountText(PERCENT)).toBe('un 25 %');
  });

  it('returns null when the coupon gives nothing', () => {
    expect(apologyDiscountText({ ...FIXED, discountFixedCup: 0 })).toBeNull();
    expect(apologyDiscountText({ ...PERCENT, discountPercent: null })).toBeNull();
  });
});

describe('missedRideApologyMessage', () => {
  it('apologises by first name and offers the coupon', () => {
    expect(missedRideApologyMessage({ fullName: '  Ana María Pérez ', failedAt: '2026-10-28T15:00:00Z', coupon: FIXED })).toBe(
      'Hola, Ana. Te escribimos de TriciGo. El 28 de octubre pediste un viaje y no conseguimos conductor. Lo sentimos mucho. '
        + 'Te dejamos 500 CUP de descuento en tu próximo viaje. Ya está cargado en tu cuenta, no tienes que escribir ningún código.',
    );
  });

  it('says until when the coupon is valid', () => {
    const msg = missedRideApologyMessage({
      fullName: 'Ana', failedAt: '2026-10-28T15:00:00Z', coupon: { ...PERCENT, validUntil: '2026-11-30T12:00:00Z' },
    });
    expect(msg).toContain('Te dejamos un 25 % de descuento');
    expect(msg.endsWith('Vale hasta el 30 de noviembre.')).toBe(true);
  });

  it('only apologises when there is no coupon', () => {
    expect(missedRideApologyMessage({ fullName: null, failedAt: '2026-10-28T15:00:00Z', coupon: null })).toBe(
      'Hola. Te escribimos de TriciGo. El 28 de octubre pediste un viaje y no conseguimos conductor. Lo sentimos mucho. '
        + 'Esperamos verte pronto en TriciGo.',
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/missedRideOutreach.test.ts`
Expected: FAIL, `Failed to resolve import "../missedRideOutreach"`.

- [ ] **Step 3: Write `packages/utils/src/missedRideOutreach.ts`**

```ts
// ============================================================
// TriciGo — writing to people whose ride found no driver (00674)
//
// The panel lists them (/missed-rides, admin_missed_riders) and operators write to each by
// WhatsApp. ops_contact_missed_rider records the contact and returns the apology coupon the
// person now holds, if any; this builds the message. The link is waMeLink (driverOutreach.ts).
// ============================================================

import { formatCUP } from './currency';
import { cubaTimeZone } from './date';

export interface ApologyCoupon {
  type: string;
  discountPercent: number | null;
  discountFixedCup: number | null;
  validUntil: string | null;
}

export interface MissedRideMessageInput {
  fullName: string | null | undefined;
  /** When the request that found no driver was canceled (ISO). */
  failedAt: string;
  coupon: ApologyCoupon | null;
}

/** "28 de octubre", in Cuba's clock. */
export function cubaDayMonth(iso: string): string {
  return new Intl.DateTimeFormat('es', { timeZone: cubaTimeZone(iso), day: 'numeric', month: 'long' }).format(
    new Date(iso),
  );
}

/** "500 CUP" or "un 25 %"; null when the coupon gives nothing. */
export function apologyDiscountText(coupon: ApologyCoupon): string | null {
  if (coupon.type === 'fixed_discount') {
    return coupon.discountFixedCup && coupon.discountFixedCup > 0 ? formatCUP(coupon.discountFixedCup) : null;
  }
  return coupon.discountPercent && coupon.discountPercent > 0 ? `un ${coupon.discountPercent} %` : null;
}

/** The WhatsApp message for someone whose request found no driver. */
export function missedRideApologyMessage({ fullName, failedAt, coupon }: MissedRideMessageInput): string {
  const firstName = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  const parts = [
    firstName ? `Hola, ${firstName}. Te escribimos de TriciGo.` : 'Hola. Te escribimos de TriciGo.',
    `El ${cubaDayMonth(failedAt)} pediste un viaje y no conseguimos conductor. Lo sentimos mucho.`,
  ];
  const discount = coupon ? apologyDiscountText(coupon) : null;
  if (coupon && discount) {
    parts.push(
      `Te dejamos ${discount} de descuento en tu próximo viaje. Ya está cargado en tu cuenta, no tienes que escribir ningún código.`,
    );
    if (coupon.validUntil) parts.push(`Vale hasta el ${cubaDayMonth(coupon.validUntil)}.`);
  } else {
    parts.push('Esperamos verte pronto en TriciGo.');
  }
  return parts.join(' ');
}
```

- [ ] **Step 4: Export it**

In `packages/utils/src/index.ts`, after the two `driverOutreach` lines:

```ts
export { apologyDiscountText, cubaDayMonth, missedRideApologyMessage } from './missedRideOutreach';
export type { ApologyCoupon, MissedRideMessageInput } from './missedRideOutreach';
```

In `packages/utils/package.json` `exports`, after `"./driverOutreach": "./src/driverOutreach.ts",`:

```json
    "./missedRideOutreach": "./src/missedRideOutreach.ts",
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/missedRideOutreach.test.ts src/__tests__/copyTuteo.test.ts`
Expected: PASS (both files).

- [ ] **Step 6: Commit**

```bash
git add packages/utils/src/missedRideOutreach.ts packages/utils/src/__tests__/missedRideOutreach.test.ts packages/utils/src/index.ts packages/utils/package.json
git commit -m "feat(utils): the apology message for people whose ride found no driver"
```

---

### Task 4: Panel access: `riders.outreach` and `/missed-rides`

**Files:**
- Modify: `packages/utils/src/adminPanelAccess.ts`
- Modify: `packages/utils/src/__tests__/adminPanelAccess.test.ts`

- [ ] **Step 1: Update the tests first**

In `adminPanelAccess.test.ts`:

1. `CAPABILITY_SET`: add `'riders.outreach': true,` after `'referrals.rewards': true,`.
2. The route pin test: expected list becomes
   ```ts
   expect(OPERATOR_ROUTES).toEqual([
     '/', '/reports', '/launch-pulse', '/live-map', '/rides', '/support', '/incidents', '/disputes',
     '/lost-found', '/drivers', '/incomplete-drivers', '/businesses', '/users', '/reviews', '/fraud',
     '/cancellations', '/wallet', '/promotions', '/referrals', '/notifications', '/missed-rides',
   ]);
   expect(OPERATOR_ROUTES).toHaveLength(21);
   ```
3. The operator capability test: title "... one-person pushes and missed-ride outreach (deliveries 1 to 4, 00674)" and expected list
   ```ts
   expect(granted).toEqual(['detail.full', 'rides.act', 'tickets.act', 'cases.act', 'drivers.review',
     'fleets.review', 'users.block', 'accounts.delete_pending', 'moderation.act', 'push.one', 'riders.outreach']);
   ```
4. Add:
   ```ts
   it('keeps marketing out of the missed-ride page (it lists phones)', () => {
     expect(canOpenPanelPath('marketing', '/missed-rides')).toBe(false);
     expect(panelCan('marketing', 'riders.outreach')).toBe(false);
     expect(canOpenPanelPath('operator', '/missed-rides')).toBe(true);
   });
   ```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/adminPanelAccess.test.ts`
Expected: FAIL (tsc-style `satisfies` error on the unknown capability, the route list and the operator list).

- [ ] **Step 3: Implement**

In `adminPanelAccess.ts`:

1. In `OPERATOR_ROUTES`, after `'/notifications',`:
   ```ts
     // 00674: people whose ride found no driver.
     '/missed-rides',
   ```
2. In `PanelCapability`, after the `'referrals.rewards'` line:
   ```ts
     /** Write to people whose ride found no driver and give them the apology coupon (00674). */
     | 'riders.outreach'
   ```
3. In `OPERATOR_CAPABILITIES`, after `'push.one',`:
   ```ts
     'riders.outreach',
   ```
   and add to its doc comment: "and writes to people whose ride found no driver (00674)".

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/adminPanelAccess.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/adminPanelAccess.ts packages/utils/src/__tests__/adminPanelAccess.test.ts
git commit -m "feat(panel): riders.outreach capability and the /missed-rides route"
```

---

### Task 5: Services (`@tricigo/api`)

**Files:**
- Create: `packages/api/src/services/missed-ride.service.ts`
- Create: `packages/api/src/services/__tests__/missed-ride.test.ts`
- Modify: `packages/api/src/services/promotion.service.ts` (`Promotion` interface)
- Modify: `packages/api/src/index.ts` (after the `caseOpsService` export, line ~154)

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../errors';

const mockRpc = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc }),
}));

import { MISSED_RIDES_UNAVAILABLE, missedRideService } from '../missed-ride.service';

const ok = (data: unknown) => ({ data, error: null });
const MISSING = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };

beforeEach(() => {
  mockRpc.mockReset();
});

describe('missedRideService.list', () => {
  it('asks for a view and a window and returns numbers as numbers', async () => {
    mockRpc.mockResolvedValueOnce(ok([{ user_id: 'u-1', failed_requests: '2', contacts: '0', coupon_status: 'none' }]));
    const rows = await missedRideService.list('pending', 30);
    expect(mockRpc).toHaveBeenCalledWith('admin_missed_riders', { p_view: 'pending', p_days: 30 });
    expect(rows[0]).toMatchObject({ user_id: 'u-1', failed_requests: 2, contacts: 0 });
  });

  it('passes no window for everything', async () => {
    mockRpc.mockResolvedValueOnce(ok([]));
    await missedRideService.list('contacted', null);
    expect(mockRpc).toHaveBeenCalledWith('admin_missed_riders', { p_view: 'contacted', p_days: null });
  });

  it('says the function is not deployed when the migration is missing', async () => {
    mockRpc.mockResolvedValueOnce(MISSING);
    const err = await missedRideService.list('pending', 30).catch((e: unknown) => e);
    expect((err as AppError).code).toBe(MISSED_RIDES_UNAVAILABLE);
  });

  it('rethrows any other database error', async () => {
    const dbErr = { code: '42501', message: 'Solo el equipo de operaciones ve esta lista.' };
    mockRpc.mockResolvedValueOnce({ data: null, error: dbErr });
    await expect(missedRideService.list('pending', 30)).rejects.toBe(dbErr);
  });
});

describe('missedRideService.currentCoupon', () => {
  it('returns the coupon in use', async () => {
    mockRpc.mockResolvedValueOnce(ok({
      id: 'p-1', code: 'PERDON', type: 'fixed_discount', discount_percent: null, discount_fixed_cup: 500,
      valid_until: null, max_uses: 100, current_uses: 3,
    }));
    await expect(missedRideService.currentCoupon()).resolves.toEqual({
      id: 'p-1', code: 'PERDON', type: 'fixed_discount', discount_percent: null, discount_fixed_cup: 500,
      valid_until: null, max_uses: 100, current_uses: 3,
    });
    expect(mockRpc).toHaveBeenCalledWith('admin_missed_ride_coupon', {});
  });

  it('returns null when there is none', async () => {
    mockRpc.mockResolvedValueOnce(ok(null));
    await expect(missedRideService.currentCoupon()).resolves.toBeNull();
  });
});

describe('missedRideService.contact', () => {
  it('records the contact and returns the phone and the coupon', async () => {
    mockRpc.mockResolvedValueOnce(ok({
      success: true, phone: '5355500001', full_name: 'Ana Pérez', last_failed_at: '2026-10-28T15:00:00+00:00',
      coupon: { code: 'PERDON', type: 'fixed_discount', discount_percent: null, discount_fixed_cup: 500, valid_until: null },
      coupon_reason: null,
    }));
    await expect(missedRideService.contact('u-1', '2026-10-28T15:00:00+00:00')).resolves.toEqual({
      phone: '5355500001',
      fullName: 'Ana Pérez',
      lastFailedAt: '2026-10-28T15:00:00+00:00',
      coupon: { code: 'PERDON', type: 'fixed_discount', discountPercent: null, discountFixedCup: 500, validUntil: null },
      couponReason: null,
    });
    expect(mockRpc).toHaveBeenCalledWith('ops_contact_missed_rider', {
      p_user_id: 'u-1', p_expected_last_failed_at: '2026-10-28T15:00:00+00:00',
    });
  });

  it('returns the reason when there is no coupon', async () => {
    mockRpc.mockResolvedValueOnce(ok({
      success: true, phone: '5355500001', full_name: null, last_failed_at: '2026-10-28T15:00:00+00:00',
      coupon: null, coupon_reason: 'already_given',
    }));
    const r = await missedRideService.contact('u-1', '2026-10-28T15:00:00+00:00');
    expect(r.coupon).toBeNull();
    expect(r.couponReason).toBe('already_given');
  });

  it("throws the server's refusal as an AppError with its code", async () => {
    mockRpc.mockResolvedValueOnce(ok({ error: 'missed_rider_changed' }));
    const err = await missedRideService.contact('u-1', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('missed_rider_changed');
  });

  it('says the function is not deployed when the migration is missing', async () => {
    mockRpc.mockResolvedValueOnce(MISSING);
    const err = await missedRideService.contact('u-1', 'x').catch((e: unknown) => e);
    expect((err as AppError).code).toBe(MISSED_RIDES_UNAVAILABLE);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/missed-ride.test.ts`
Expected: FAIL, cannot resolve `../missed-ride.service`.

- [ ] **Step 3: Write `packages/api/src/services/missed-ride.service.ts`**

```ts
// ============================================================
// TriciGo — people whose ride found no driver (00674)
//
// The panel's /missed-rides page: who to write to (admin_missed_riders), the apology coupon in use
// (admin_missed_ride_coupon) and the contact itself (ops_contact_missed_rider), which records who
// wrote and gives the person the coupon once per confirmed phone. Admins and operators only; the
// server checks. supabase/migrations/00674_missed_ride_apology_coupon.sql
// ============================================================

import { getSupabaseClient } from '../client';
import { AppError } from '../errors';
import { callOpsRpc, isMissingRpc } from './_ops-rpc';
import type { PromotionType } from './promotion.service';

/** A function the database does not have yet (00674 not applied). */
export const MISSED_RIDES_UNAVAILABLE = 'MISSED_RIDES_UNAVAILABLE';

export type MissedRiderView = 'pending' | 'contacted';
export type MissedRiderCouponStatus = 'none' | 'granted' | 'used' | 'unusable';
export type MissedRideCouponReason = 'no_coupon_available' | 'already_given' | 'coupon_used' | 'coupon_unusable';

export interface MissedRider {
  user_id: string;
  full_name: string | null;
  /** The confirmed phone, digits without "+", or null. */
  phone: string | null;
  failed_requests: number;
  last_failed_at: string | null;
  last_failed_ride_id: string | null;
  last_pickup: string | null;
  last_dropoff: string | null;
  /** No completed ride since the last request and an eligible account: still writable. */
  in_segment: boolean;
  contacts: number;
  last_contacted_at: string | null;
  last_contacted_by: string | null;
  coupon_status: MissedRiderCouponStatus;
  coupon_code: string | null;
  /** No coupon on this account, but its phone got one before (from another account). */
  phone_already_rewarded: boolean;
  /** A completed ride after the first contact. */
  rode_after_contact: boolean;
}

export interface MissedRideCoupon {
  id: string;
  code: string;
  type: PromotionType;
  discount_percent: number | null;
  discount_fixed_cup: number | null;
  valid_until: string | null;
  max_uses: number | null;
  current_uses: number;
}

export interface MissedRiderContact {
  phone: string;
  fullName: string | null;
  lastFailedAt: string;
  coupon: {
    code: string;
    type: PromotionType;
    discountPercent: number | null;
    discountFixedCup: number | null;
    validUntil: string | null;
  } | null;
  couponReason: MissedRideCouponReason | null;
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await getSupabaseClient().rpc(name, args);
  if (error) {
    if (isMissingRpc(error)) throw new AppError(`${name} is not deployed yet`, MISSED_RIDES_UNAVAILABLE, 503);
    throw error;
  }
  return data;
}

export const missedRideService = {
  /** `days` null = everything. Pending: the latest failure in the window; contacted: the latest contact. */
  async list(view: MissedRiderView, days: number | null): Promise<MissedRider[]> {
    const rows = ((await rpc('admin_missed_riders', { p_view: view, p_days: days })) ?? []) as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as MissedRider),
      failed_requests: Number(r.failed_requests ?? 0),
      contacts: Number(r.contacts ?? 0),
    }));
  },

  /** The coupon an operator gives now, or null when there is no active one. */
  async currentCoupon(): Promise<MissedRideCoupon | null> {
    const c = (await rpc('admin_missed_ride_coupon', {})) as Record<string, unknown> | null;
    if (!c || typeof c.code !== 'string') return null;
    return {
      id: String(c.id),
      code: c.code,
      type: c.type as PromotionType,
      discount_percent: num(c.discount_percent),
      discount_fixed_cup: num(c.discount_fixed_cup),
      valid_until: (c.valid_until as string | null) ?? null,
      max_uses: num(c.max_uses),
      current_uses: Number(c.current_uses ?? 0),
    };
  },

  /**
   * Record that the caller is writing to this person and give them the coupon if they have none.
   * `expectedLastFailedAt` is the failure the list showed: missed_rider_changed if it moved.
   */
  async contact(userId: string, expectedLastFailedAt: string): Promise<MissedRiderContact> {
    const r = await callOpsRpc('ops_contact_missed_rider',
      { p_user_id: userId, p_expected_last_failed_at: expectedLastFailedAt }, MISSED_RIDES_UNAVAILABLE);
    const c = r.coupon as Record<string, unknown> | null | undefined;
    return {
      phone: String(r.phone),
      fullName: (r.full_name as string | null) ?? null,
      lastFailedAt: String(r.last_failed_at),
      coupon: c && typeof c.code === 'string'
        ? {
            code: c.code,
            type: c.type as PromotionType,
            discountPercent: num(c.discount_percent),
            discountFixedCup: num(c.discount_fixed_cup),
            validUntil: (c.valid_until as string | null) ?? null,
          }
        : null,
      couponReason: (r.coupon_reason as MissedRideCouponReason | null) ?? null,
    };
  },
};
```

- [ ] **Step 4: Add `grant_only` to `Promotion`**

In `packages/api/src/services/promotion.service.ts`, inside `interface Promotion`, after the `is_public` field:

```ts
  /**
   * 00674: an apology coupon. Only the person an operator gave it to can use it (promotion_grants),
   * and it is never public. Chosen when the promotion is created.
   */
  grant_only?: boolean;
```

- [ ] **Step 5: Test that `create` never drops the flag**

`create` retries a failed insert without `is_public` and `first_ride_only` when a column is missing. `grant_only` must never be stripped: an apology coupon saved without it would be an ordinary promotion anyone can type. Append to `packages/api/src/services/__tests__/promotion.test.ts`:

```ts
describe('promotionService.create with an apology coupon (00674)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('never drops grant_only on the column-missing retry', async () => {
    const missing = { message: "Could not find the 'grant_only' column of 'promotions' in the schema cache" };
    const single = vi.fn().mockResolvedValue({ data: null, error: missing });
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn((_body: Record<string, unknown>) => ({ select }));
    mockFrom.mockReturnValue({ insert });
    Object.assign(mockSupabase, {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'admin-1' } } }) },
    });

    const input = { code: 'PERDON', type: 'fixed_discount', grant_only: true, is_public: false };
    await expect(promotionService.create(input as Parameters<typeof promotionService.create>[0])).rejects.toBe(missing);

    expect(insert).toHaveBeenCalled();
    for (const [body] of insert.mock.calls) expect(body).toMatchObject({ grant_only: true });
  });
});
```

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/promotion.test.ts`
Expected: PASS with the current `TOLERATED_COLUMNS` (it protects the rule; it fails if someone adds `grant_only` there).

- [ ] **Step 6: Export the service**

In `packages/api/src/index.ts`, after the two `case-ops.service` lines:

```ts
export { missedRideService, MISSED_RIDES_UNAVAILABLE } from './services/missed-ride.service';
export type {
  MissedRider, MissedRideCoupon, MissedRiderContact, MissedRiderView, MissedRiderCouponStatus, MissedRideCouponReason,
} from './services/missed-ride.service';
```

- [ ] **Step 7: Run the tests and the types**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/missed-ride.test.ts src/services/__tests__/promotion.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit -p packages/api/tsconfig.json 2>&1 | grep -v "__tests__" | head`
Expected: no errors outside `__tests__/` (CLAUDE.md: 28 preexisting ones in tests).

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/services/missed-ride.service.ts packages/api/src/services/__tests__/missed-ride.test.ts packages/api/src/services/__tests__/promotion.test.ts packages/api/src/services/promotion.service.ts packages/api/src/index.ts
git commit -m "feat(api): missedRideService and Promotion.grant_only"
```

---

### Task 6: Refusal codes and texts

**Files:**
- Modify: `apps/admin/src/lib/opsErrors.ts`
- Modify: `packages/i18n/src/locales/es/admin.json`, `en/admin.json`, `pt/admin.json`

- [ ] **Step 1: Add the codes**

In `opsErrors.ts`, update the doc comment to mention "and missed-ride outreach (00674)" and add before the closing `]);` of `CODES`:

```ts
  // 00674
  'user_not_found',
  'not_eligible',
  'missed_rider_changed',
  'no_phone',
  'MISSED_RIDES_UNAVAILABLE',
```

and add `'missed_rider_changed'` to `STALE_CODES`.

- [ ] **Step 2: Add the texts (Spanish)**

In `es/admin.json`:

1. Inside `"sidebar"`, after `"incomplete_drivers": "Choferes sin terminar",`: `"missed_rides": "Sin chofer",`
2. Inside `"promotions"`, add:
   ```json
   "field_grant_only": "Cupón de disculpa",
   "grant_only_help": "Solo lo usa quien lo recibe de soporte desde Sin chofer. No se publica.",
   "grant_only_locked": "Se elige al crear la promoción",
   "badge_grant_only": "Disculpa",
   ```
3. Inside `"ops_errors"`, after `"CASES_UNAVAILABLE"` (add a comma to that line):
   ```json
   "user_not_found": "No encontramos a esa persona.",
   "not_eligible": "Esta persona ya no está en la lista: volvió a viajar o su cuenta cambió.",
   "missed_rider_changed": "Esta persona pidió otro viaje mientras mirabas la lista. La recargamos.",
   "no_phone": "Esta persona no tiene un teléfono confirmado.",
   "MISSED_RIDES_UNAVAILABLE": "Esta función todavía no está disponible en el servidor. Avisa al equipo técnico."
   ```
4. A new top-level object right before `"ops_errors"`:
   ```json
   "missed_rides": {
     "intro": "Personas que pidieron un viaje, no consiguieron conductor y no volvieron a viajar. Escríbeles por WhatsApp: el cupón de disculpa se les aplica solo en el próximo viaje.",
     "tab_pending": "Por contactar",
     "tab_contacted": "Contactados",
     "days_label": "Período",
     "days_n": "Últimos {{n}} días",
     "days_all": "Todo",
     "coupon_title": "Cupón de disculpa",
     "coupon_discount": "{{discount}} de descuento",
     "coupon_valid_until": "Vale hasta {{date}}",
     "coupon_uses": "{{used}} de {{max}} usos",
     "coupon_none": "No hay cupón de disculpa activo: los mensajes salen sin descuento.",
     "coupon_link": "Crearlo en Promociones",
     "col_person": "Persona",
     "col_last_failure": "Último pedido sin chofer",
     "col_requests": "Pedidos",
     "col_status": "Estado",
     "col_actions": "Acciones",
     "no_name": "Sin nombre",
     "no_phone": "Sin teléfono confirmado",
     "status_pending": "Sin contactar",
     "status_contacted": "Contactado por {{name}} · {{date}}",
     "coupon_status_none": "Sin cupón",
     "coupon_status_granted": "Cupón dado ({{code}})",
     "coupon_status_used": "Cupón usado",
     "coupon_status_unusable": "Cupón sin efecto",
     "phone_already_rewarded": "Este teléfono ya recibió un cupón",
     "rode_again": "Volvió a viajar",
     "action_write": "Escribir por WhatsApp",
     "action_write_again": "Volver a escribir",
     "writing": "Preparando…",
     "write_no_phone": "Sin teléfono confirmado no se le puede escribir",
     "write_not_in_segment": "Ya volvió a viajar o su cuenta cambió",
     "no_whatsapp": "Este teléfono no sirve para WhatsApp",
     "toast_sent_coupon": "Mensaje listo en WhatsApp, con el cupón {{code}}",
     "toast_sent": "Mensaje listo en WhatsApp",
     "reason_no_coupon_available": "No hay cupón activo: el mensaje sale sin descuento",
     "reason_already_given": "Este teléfono ya recibió un cupón: el mensaje sale sin descuento",
     "reason_coupon_used": "Ya usó su cupón: el mensaje sale sin descuento",
     "reason_coupon_unusable": "Su cupón ya no tiene efecto: el mensaje sale sin descuento",
     "popup_blocked": "El navegador no abrió la pestaña de WhatsApp.",
     "popup_open": "Abrir WhatsApp",
     "empty_pending": "Nadie por contactar en este período",
     "empty_contacted": "Todavía no se le escribió a nadie en este período"
   },
   ```

- [ ] **Step 3: The same keys in English (`en/admin.json`)**

```json
"missed_rides": "No driver",
```
```json
"field_grant_only": "Apology coupon",
"grant_only_help": "Only the person support gives it to from No driver can use it. It is never published.",
"grant_only_locked": "Chosen when the promotion is created",
"badge_grant_only": "Apology",
```
```json
"user_not_found": "We couldn't find that person.",
"not_eligible": "This person is no longer on the list: they rode again or their account changed.",
"missed_rider_changed": "This person made another request while you were looking at the list. We reloaded it.",
"no_phone": "This person has no confirmed phone.",
"MISSED_RIDES_UNAVAILABLE": "This isn't available on the server yet. Tell the tech team."
```
```json
"missed_rides": {
  "intro": "People who requested a ride, found no driver and haven't ridden since. Write to them on WhatsApp: the apology coupon applies on its own on their next ride.",
  "tab_pending": "To contact",
  "tab_contacted": "Contacted",
  "days_label": "Period",
  "days_n": "Last {{n}} days",
  "days_all": "All",
  "coupon_title": "Apology coupon",
  "coupon_discount": "{{discount}} off",
  "coupon_valid_until": "Valid until {{date}}",
  "coupon_uses": "{{used}} of {{max}} uses",
  "coupon_none": "No active apology coupon: messages go out without a discount.",
  "coupon_link": "Create it in Promotions",
  "col_person": "Person",
  "col_last_failure": "Last request with no driver",
  "col_requests": "Requests",
  "col_status": "Status",
  "col_actions": "Actions",
  "no_name": "No name",
  "no_phone": "No confirmed phone",
  "status_pending": "Not contacted",
  "status_contacted": "Contacted by {{name}} · {{date}}",
  "coupon_status_none": "No coupon",
  "coupon_status_granted": "Coupon given ({{code}})",
  "coupon_status_used": "Coupon used",
  "coupon_status_unusable": "Coupon no longer valid",
  "phone_already_rewarded": "This phone already got a coupon",
  "rode_again": "Rode again",
  "action_write": "Write on WhatsApp",
  "action_write_again": "Write again",
  "writing": "Preparing…",
  "write_no_phone": "Without a confirmed phone they can't be contacted",
  "write_not_in_segment": "They rode again or their account changed",
  "no_whatsapp": "This phone can't be used for WhatsApp",
  "toast_sent_coupon": "Message ready in WhatsApp, with coupon {{code}}",
  "toast_sent": "Message ready in WhatsApp",
  "reason_no_coupon_available": "No active coupon: the message goes out without a discount",
  "reason_already_given": "This phone already got a coupon: the message goes out without a discount",
  "reason_coupon_used": "They already used their coupon: the message goes out without a discount",
  "reason_coupon_unusable": "Their coupon is no longer valid: the message goes out without a discount",
  "popup_blocked": "The browser didn't open the WhatsApp tab.",
  "popup_open": "Open WhatsApp",
  "empty_pending": "Nobody to contact in this period",
  "empty_contacted": "Nobody has been written to in this period yet"
},
```

- [ ] **Step 4: The same keys in Portuguese (`pt/admin.json`)**

```json
"missed_rides": "Sem motorista",
```
```json
"field_grant_only": "Cupom de desculpas",
"grant_only_help": "Só quem o recebe do suporte em Sem motorista pode usá-lo. Nunca é publicado.",
"grant_only_locked": "Escolhido ao criar a promoção",
"badge_grant_only": "Desculpas",
```
```json
"user_not_found": "Não encontramos essa pessoa.",
"not_eligible": "Esta pessoa não está mais na lista: voltou a viajar ou a conta mudou.",
"missed_rider_changed": "Esta pessoa fez outro pedido enquanto você via a lista. Recarregamos.",
"no_phone": "Esta pessoa não tem telefone confirmado.",
"MISSED_RIDES_UNAVAILABLE": "Isto ainda não está disponível no servidor. Avise a equipe técnica."
```
```json
"missed_rides": {
  "intro": "Pessoas que pediram uma viagem, não conseguiram motorista e não voltaram a viajar. Escreva para elas no WhatsApp: o cupom de desculpas se aplica sozinho na próxima viagem.",
  "tab_pending": "Para contatar",
  "tab_contacted": "Contatados",
  "days_label": "Período",
  "days_n": "Últimos {{n}} dias",
  "days_all": "Tudo",
  "coupon_title": "Cupom de desculpas",
  "coupon_discount": "{{discount}} de desconto",
  "coupon_valid_until": "Vale até {{date}}",
  "coupon_uses": "{{used}} de {{max}} usos",
  "coupon_none": "Nenhum cupom de desculpas ativo: as mensagens saem sem desconto.",
  "coupon_link": "Criar em Promoções",
  "col_person": "Pessoa",
  "col_last_failure": "Último pedido sem motorista",
  "col_requests": "Pedidos",
  "col_status": "Status",
  "col_actions": "Ações",
  "no_name": "Sem nome",
  "no_phone": "Sem telefone confirmado",
  "status_pending": "Não contatado",
  "status_contacted": "Contatado por {{name}} · {{date}}",
  "coupon_status_none": "Sem cupom",
  "coupon_status_granted": "Cupom dado ({{code}})",
  "coupon_status_used": "Cupom usado",
  "coupon_status_unusable": "Cupom sem efeito",
  "phone_already_rewarded": "Este telefone já recebeu um cupom",
  "rode_again": "Voltou a viajar",
  "action_write": "Escrever no WhatsApp",
  "action_write_again": "Escrever de novo",
  "writing": "Preparando…",
  "write_no_phone": "Sem telefone confirmado não dá para escrever",
  "write_not_in_segment": "Voltou a viajar ou a conta mudou",
  "no_whatsapp": "Este telefone não serve para WhatsApp",
  "toast_sent_coupon": "Mensagem pronta no WhatsApp, com o cupom {{code}}",
  "toast_sent": "Mensagem pronta no WhatsApp",
  "reason_no_coupon_available": "Nenhum cupom ativo: a mensagem sai sem desconto",
  "reason_already_given": "Este telefone já recebeu um cupom: a mensagem sai sem desconto",
  "reason_coupon_used": "Já usou o cupom: a mensagem sai sem desconto",
  "reason_coupon_unusable": "O cupom não tem mais efeito: a mensagem sai sem desconto",
  "popup_blocked": "O navegador não abriu a aba do WhatsApp.",
  "popup_open": "Abrir WhatsApp",
  "empty_pending": "Ninguém para contatar neste período",
  "empty_contacted": "Ainda não se escreveu para ninguém neste período"
},
```

- [ ] **Step 5: Validate the JSON and the tuteo guard**

Run: `node -e "for (const l of ['es','en','pt']) JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/'+l+'/admin.json','utf8')); console.log('ok')"`
Expected: `ok`.
Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/copyTuteo.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/lib/opsErrors.ts packages/i18n/src/locales/es/admin.json packages/i18n/src/locales/en/admin.json packages/i18n/src/locales/pt/admin.json
git commit -m "feat(panel): texts and refusal codes for missed-ride outreach"
```

---

### Task 7: Promociones: "Cupón de disculpa"

**Files:**
- Modify: `apps/admin/src/app/promotions/page.tsx`

- [ ] **Step 1: Form state**

In `type FormState`, after `is_public: boolean;` add `grant_only: boolean;`. In `emptyForm`, after `is_public: true,` add `grant_only: false,`.

- [ ] **Step 2: Saving**

In the save handler's `base` object, replace

```ts
        notify_on_publish: form.is_public ? form.notify_on_publish : false,
        first_ride_only: form.first_ride_only,
        is_public: form.is_public,
```

with

```ts
        // A private code is never broadcast, so the publish push is forced off. An apology
        // coupon (00674) is always private: the database refuses one that is public.
        notify_on_publish: form.is_public && !form.grant_only ? form.notify_on_publish : false,
        first_ride_only: form.first_ride_only,
        is_public: form.grant_only ? false : form.is_public,
```

and the create call

```ts
        const created = await promotionService.create({ ...payload, notified_at: null });
```

with

```ts
        // grant_only is chosen once, at creation, and sent only when set: an update never
        // carries it, and a plain promotion saves even before 00674 adds the column.
        const created = await promotionService.create({
          ...payload,
          ...(form.grant_only ? { grant_only: true } : {}),
          notified_at: null,
        });
```

Do not add `grant_only` to `TOLERATED_COLUMNS` in `promotion.service.ts`: stripping it on a retry would save an apology coupon as an ordinary promotion. Without the column, creating one fails with the database's error, which is what has to happen.

- [ ] **Step 3: Editing an existing promotion**

In the function that fills the form from `p` (the block with `is_public: p.is_public ?? true,`), add after it:

```ts
      grant_only: p.grant_only ?? false,
```

- [ ] **Step 4: The checkbox**

Right before the `field_visibility` `<Field>`, add:

```tsx
            <Field label={t('promotions.field_grant_only', { defaultValue: 'Cupón de disculpa' })}>
              <label className={`inline-flex items-center gap-2 text-[13px] ${editingId ? 'text-ink-subtle' : 'text-ink'}`}>
                <input
                  type="checkbox"
                  checked={form.grant_only}
                  disabled={!!editingId}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      grant_only: e.target.checked,
                      is_public: e.target.checked ? false : form.is_public,
                      notify_on_publish: e.target.checked ? false : form.notify_on_publish,
                    })
                  }
                  className="h-4 w-4 rounded border-line disabled:opacity-50"
                />
                {editingId
                  ? t('promotions.grant_only_locked', { defaultValue: 'Se elige al crear la promoción' })
                  : t('promotions.grant_only_help', {
                      defaultValue: 'Solo lo usa quien lo recibe de soporte desde Sin chofer. No se publica.',
                    })}
              </label>
            </Field>
```

In the `field_visibility` checkbox `<input>`, add `disabled={form.grant_only}` and `className="h-4 w-4 rounded border-line disabled:opacity-50"`.

- [ ] **Step 5: The badge in the list**

In the `code` column cell, after the `p.is_public === false && (...)` badge, add:

```tsx
              {p.grant_only && (
                <span className="shrink-0 rounded-full bg-primary-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary-700 dark:text-primary-400">
                  {t('promotions.badge_grant_only', { defaultValue: 'Disculpa' })}
                </span>
              )}
```

(`text-primary-700` on a `/10` tint: CLAUDE.md's AA rule for chips.)

- [ ] **Step 6: Types and lint**

Run: `npx tsc --noEmit -p apps/admin/tsconfig.json`
Expected: no errors.
Run: `pnpm --filter @tricigo/admin exec eslint src/app/promotions/page.tsx`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/app/promotions/page.tsx
git commit -m "feat(panel): mark a promotion as an apology coupon"
```

---

### Task 8: The `/missed-rides` page

**Files:**
- Create: `apps/admin/src/app/missed-rides/page.tsx`
- Modify: `apps/admin/src/components/layout/Sidebar.tsx`
- Modify: `apps/admin/src/components/layout/Header.tsx`

- [ ] **Step 1: Write the page**

```tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { MessageCircle, PhoneMissed, Ticket } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import {
  missedRideService,
  type MissedRider,
  type MissedRideCoupon,
  type MissedRideCouponReason,
  type MissedRiderView,
} from '@tricigo/api';
import { apologyDiscountText, missedRideApologyMessage, waMeLink } from '@tricigo/utils';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { useToast } from '@/components/ui/AdminToast';
import { formatAdminDate } from '@/lib/formatDate';
import { usePanelCan } from '@/lib/usePanelCan';
import { isOpsStaleError, opsErrorMessage } from '@/lib/opsErrors';

// People whose request found no driver and who have not ridden since (00674). Operators write to
// each one by WhatsApp; the server records the contact and gives them the apology coupon, which
// applies on its own on their next ride. Data: admin_missed_riders, admin_missed_ride_coupon and
// ops_contact_missed_rider.

type Days = '30' | '90' | 'all';
const DAYS: Days[] = ['30', '90', 'all'];

function daysParam(d: Days): number | null {
  return d === 'all' ? null : Number(d);
}

export default function MissedRidesPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const { can } = usePanelCan();
  const canWrite = can('riders.outreach');

  const [view, setView] = useState<MissedRiderView>('pending');
  const [days, setDays] = useState<Days>('30');
  const [rows, setRows] = useState<MissedRider[]>([]);
  const [coupon, setCoupon] = useState<MissedRideCoupon | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [blockedLink, setBlockedLink] = useState<string | null>(null);
  const request = useRef(0);

  /** `silent` keeps the table on screen (the reload after a contact). */
  const load = useCallback(async (silent = false) => {
    const id = ++request.current;
    if (!silent) setLoading(true);
    try {
      const [list, current] = await Promise.all([
        missedRideService.list(view, daysParam(days)),
        missedRideService.currentCoupon(),
      ]);
      if (id !== request.current) return;
      setRows(list);
      setCoupon(current);
      setError(null);
    } catch (err) {
      if (id !== request.current) return;
      if (!silent) setRows([]);
      setError(opsErrorMessage(err, t));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [view, days, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const reasonText = useCallback((reason: MissedRideCouponReason): string => {
    switch (reason) {
      case 'no_coupon_available':
        return t('missed_rides.reason_no_coupon_available', { defaultValue: 'No hay cupón activo: el mensaje sale sin descuento' });
      case 'already_given':
        return t('missed_rides.reason_already_given', { defaultValue: 'Este teléfono ya recibió un cupón: el mensaje sale sin descuento' });
      case 'coupon_used':
        return t('missed_rides.reason_coupon_used', { defaultValue: 'Ya usó su cupón: el mensaje sale sin descuento' });
      default:
        return t('missed_rides.reason_coupon_unusable', { defaultValue: 'Su cupón ya no tiene efecto: el mensaje sale sin descuento' });
    }
  }, [t]);

  const write = useCallback(async (r: MissedRider) => {
    if (!r.phone || !r.last_failed_at || busy) return;
    // Open the tab on the click itself: once the server has answered, the browser blocks it.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    setBusy(r.user_id);
    setBlockedLink(null);
    try {
      const res = await missedRideService.contact(r.user_id, r.last_failed_at);
      const href = waMeLink(
        res.phone,
        missedRideApologyMessage({ fullName: res.fullName, failedAt: res.lastFailedAt, coupon: res.coupon }),
      );
      if (!href) throw new Error(t('missed_rides.no_whatsapp', { defaultValue: 'Este teléfono no sirve para WhatsApp' }));
      if (tab) tab.location.href = href;
      else setBlockedLink(href);
      if (res.couponReason) {
        showToast('warning', reasonText(res.couponReason));
      } else if (res.coupon) {
        showToast('success', t('missed_rides.toast_sent_coupon', {
          code: res.coupon.code, defaultValue: 'Mensaje listo en WhatsApp, con el cupón {{code}}',
        }));
      } else {
        showToast('success', t('missed_rides.toast_sent', { defaultValue: 'Mensaje listo en WhatsApp' }));
      }
      void load(true);
    } catch (err) {
      tab?.close();
      showToast('error', opsErrorMessage(err, t));
      if (isOpsStaleError(err)) void load(true);
    } finally {
      setBusy(null);
    }
  }, [busy, load, reasonText, showToast, t]);

  const tabs: StatusTab<MissedRiderView>[] = useMemo(() => [
    { id: 'pending', label: t('missed_rides.tab_pending', { defaultValue: 'Por contactar' }) },
    { id: 'contacted', label: t('missed_rides.tab_contacted', { defaultValue: 'Contactados' }) },
  ], [t]);

  const couponText = useCallback((r: MissedRider): string => {
    switch (r.coupon_status) {
      case 'granted':
        return t('missed_rides.coupon_status_granted', { code: r.coupon_code ?? '', defaultValue: 'Cupón dado ({{code}})' });
      case 'used':
        return t('missed_rides.coupon_status_used', { defaultValue: 'Cupón usado' });
      case 'unusable':
        return t('missed_rides.coupon_status_unusable', { defaultValue: 'Cupón sin efecto' });
      default:
        return t('missed_rides.coupon_status_none', { defaultValue: 'Sin cupón' });
    }
  }, [t]);

  const columns: DataColumn<MissedRider>[] = useMemo(() => [
    {
      id: 'person',
      header: t('missed_rides.col_person', { defaultValue: 'Persona' }),
      primary: true,
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-ink">
            {r.full_name?.trim() || t('missed_rides.no_name', { defaultValue: 'Sin nombre' })}
          </span>
          <span className="font-mono text-[11px] text-ink-muted" data-tabular>
            {r.phone ? `+${r.phone}` : t('missed_rides.no_phone', { defaultValue: 'Sin teléfono confirmado' })}
          </span>
        </span>
      ),
    },
    {
      id: 'last_failure',
      header: t('missed_rides.col_last_failure', { defaultValue: 'Último pedido sin chofer' }),
      cell: (r) => r.last_failed_at ? (
        <span className="flex min-w-0 flex-col">
          <span className="text-ink">{formatAdminDate(r.last_failed_at)}</span>
          <span className="truncate text-[11px] text-ink-muted">
            {[r.last_pickup, r.last_dropoff].filter(Boolean).join(' → ')}
          </span>
        </span>
      ) : '—',
    },
    {
      id: 'requests',
      header: t('missed_rides.col_requests', { defaultValue: 'Pedidos' }),
      align: 'right',
      hideBelow: 'md',
      cell: (r) => <span data-tabular>{r.failed_requests}</span>,
    },
    {
      id: 'status',
      header: t('missed_rides.col_status', { defaultValue: 'Estado' }),
      cell: (r) => (
        <span className="flex flex-col gap-0.5 text-[12px]">
          <span className="text-ink">
            {r.contacts > 0 && r.last_contacted_at
              ? t('missed_rides.status_contacted', {
                  name: r.last_contacted_by ?? '—',
                  date: formatAdminDate(r.last_contacted_at),
                  defaultValue: 'Contactado por {{name}} · {{date}}',
                })
              : t('missed_rides.status_pending', { defaultValue: 'Sin contactar' })}
          </span>
          <span className="text-ink-muted">{couponText(r)}</span>
          {r.phone_already_rewarded && (
            <span className="text-amber-800 dark:text-amber-400">
              {t('missed_rides.phone_already_rewarded', { defaultValue: 'Este teléfono ya recibió un cupón' })}
            </span>
          )}
          {r.rode_after_contact && (
            <span className="text-emerald-700 dark:text-emerald-400">
              {t('missed_rides.rode_again', { defaultValue: 'Volvió a viajar' })}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'actions',
      header: t('missed_rides.col_actions', { defaultValue: 'Acciones' }),
      align: 'right',
      cell: (r) => {
        const title = !r.phone
          ? t('missed_rides.write_no_phone', { defaultValue: 'Sin teléfono confirmado no se le puede escribir' })
          : !r.in_segment
            ? t('missed_rides.write_not_in_segment', { defaultValue: 'Ya volvió a viajar o su cuenta cambió' })
            : undefined;
        return (
          <button
            type="button"
            onClick={() => void write(r)}
            disabled={!canWrite || !r.phone || !r.in_segment || busy !== null}
            title={title}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-700 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            {busy === r.user_id
              ? t('missed_rides.writing', { defaultValue: 'Preparando…' })
              : r.contacts > 0
                ? t('missed_rides.action_write_again', { defaultValue: 'Volver a escribir' })
                : t('missed_rides.action_write', { defaultValue: 'Escribir por WhatsApp' })}
          </button>
        );
      },
    },
  ], [busy, canWrite, couponText, t, write]);

  const discount = coupon
    ? apologyDiscountText({
        type: coupon.type,
        discountPercent: coupon.discount_percent,
        discountFixedCup: coupon.discount_fixed_cup,
        validUntil: coupon.valid_until,
      })
    : null;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[13px] text-ink-muted">
        {t('missed_rides.intro', {
          defaultValue:
            'Personas que pidieron un viaje, no consiguieron conductor y no volvieron a viajar. Escríbeles por WhatsApp: el cupón de disculpa se les aplica solo en el próximo viaje.',
        })}
      </p>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-start gap-3">
          <Ticket className="mt-0.5 h-4 w-4 shrink-0 text-primary-700 dark:text-primary-400" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
              {t('missed_rides.coupon_title', { defaultValue: 'Cupón de disculpa' })}
            </p>
            {coupon ? (
              <>
                <p className="mt-1 text-[14px] text-ink">
                  <span className="font-mono font-medium">{coupon.code}</span>
                  {discount && (
                    <> · {t('missed_rides.coupon_discount', { discount, defaultValue: '{{discount}} de descuento' })}</>
                  )}
                </p>
                <p className="mt-0.5 text-[12px] text-ink-muted">
                  {[
                    coupon.valid_until
                      ? t('missed_rides.coupon_valid_until', { date: formatAdminDate(coupon.valid_until), defaultValue: 'Vale hasta {{date}}' })
                      : null,
                    coupon.max_uses != null
                      ? t('missed_rides.coupon_uses', { used: coupon.current_uses, max: coupon.max_uses, defaultValue: '{{used}} de {{max}} usos' })
                      : null,
                  ].filter(Boolean).join(' · ')}
                </p>
              </>
            ) : (
              <p className="mt-1 text-[13px] text-ink">
                {t('missed_rides.coupon_none', { defaultValue: 'No hay cupón de disculpa activo: los mensajes salen sin descuento.' })}{' '}
                <Link href="/promotions" className="font-medium text-primary-700 underline dark:text-primary-400">
                  {t('missed_rides.coupon_link', { defaultValue: 'Crearlo en Promociones' })}
                </Link>
              </p>
            )}
          </div>
        </div>
      </section>

      {blockedLink && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-400"
        >
          <span>{t('missed_rides.popup_blocked', { defaultValue: 'El navegador no abrió la pestaña de WhatsApp.' })}</span>
          <a href={blockedLink} target="_blank" rel="noopener noreferrer" onClick={() => setBlockedLink(null)} className="font-medium underline">
            {t('missed_rides.popup_open', { defaultValue: 'Abrir WhatsApp' })}
          </a>
        </div>
      )}

      <FilterBar
        tabs={tabs}
        activeTab={view}
        onTabChange={setView}
        actions={
          <select
            value={days}
            onChange={(e) => setDays(e.target.value as Days)}
            aria-label={t('missed_rides.days_label', { defaultValue: 'Período' })}
            className="h-8 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink"
          >
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {d === 'all'
                  ? t('missed_rides.days_all', { defaultValue: 'Todo' })
                  : t('missed_rides.days_n', { n: d, defaultValue: 'Últimos {{n}} días' })}
              </option>
            ))}
          </select>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        keyField="user_id"
        loading={loading}
        error={error}
        onRetry={() => void load()}
        empty={{
          icon: PhoneMissed,
          title: view === 'pending'
            ? t('missed_rides.empty_pending', { defaultValue: 'Nadie por contactar en este período' })
            : t('missed_rides.empty_contacted', { defaultValue: 'Todavía no se le escribió a nadie en este período' }),
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Menu and title**

In `Sidebar.tsx`: add `PhoneMissed` to the `lucide-react` import, and in the `people` group, right after the `/incomplete-drivers` item:

```tsx
      { href: '/missed-rides', labelKey: 'sidebar.missed_rides', defaultLabel: 'Sin chofer', icon: PhoneMissed },
```

The menu already filters items with `canOpenPanelPath`, so marketing does not see it.

In `Header.tsx`, in the titles map after `'incomplete-drivers': 'Choferes sin terminar',`:

```ts
  'missed-rides': 'Sin chofer',
```

- [ ] **Step 3: Types and lint**

Run: `npx tsc --noEmit -p apps/admin/tsconfig.json`
Expected: no errors. If `DataTable`'s `empty.icon` or `FilterBar`'s `actions`/`onTabChange` types differ, adjust to the props in `apps/admin/src/components/data/DataTable.tsx` and `FilterBar.tsx`.
Run: `pnpm --filter @tricigo/admin exec eslint src/app/missed-rides/page.tsx src/components/layout/Sidebar.tsx src/components/layout/Header.tsx`
Expected: 0 errors.

- [ ] **Step 4: Build the panel**

Run: `pnpm --filter @tricigo/admin build`
Expected: the build lists `/missed-rides` and `ƒ Middleware`.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/app/missed-rides/page.tsx apps/admin/src/components/layout/Sidebar.tsx apps/admin/src/components/layout/Header.tsx
git commit -m "feat(panel): /missed-rides page to write to people who got no driver"
```

---

### Task 9: Full verification

- [ ] **Step 1: Tests**

Run: `pnpm exec turbo run test --force --filter=@tricigo/utils --filter=@tricigo/api`
Expected: all pass (`--force`: turbo can replay a cached green).

- [ ] **Step 2: Types**

Run: `pnpm check-types`
Expected: passes in every app.

- [ ] **Step 3: Rehearsal once more from a clean database**

Run: `PGBIN=<bin> PGPORT=<port> bash supabase/tests/00674/run.sh supabase/migrations/00674_missed_ride_apology_coupon.sql`
Expected: `0 failed`.

- [ ] **Step 4: Grants and taxonomy checks**

Run: `pnpm check:migration-grants`
Expected: passes.

---

### Task 10: Prod rehearsal (rolled back) — needs the owner's OK

Ask the owner before pushing the branch (the rehearsal reads the migration from GitHub at the commit).

- [ ] **Step 1: Push and get the file's md5**

```bash
git push -u origin claude/missed-ride-apology-coupon
git rev-parse HEAD
md5sum supabase/migrations/00674_missed_ride_apology_coupon.sql
```

- [ ] **Step 2: Fetch it from prod (`execute_sql`)**

```sql
SELECT net.http_get(
  url := 'https://raw.githubusercontent.com/AgenciaSeniors/TriciGo/<SHA>/supabase/migrations/00674_missed_ride_apology_coupon.sql',
  timeout_milliseconds := 20000) AS request_id;
```

Then confirm: `SELECT status_code, md5(content) FROM net._http_response WHERE id = <request_id>;` → `200` and the md5 of Step 1.

- [ ] **Step 3: Run the block (`execute_sql`). It ends with an exception, so nothing stays**

```sql
DO $probe$
DECLARE
  v_mig    text;
  v_ops    uuid;
  v_pax    uuid;
  v_mark   uuid;
  v_promo  uuid := gen_random_uuid();
  v_ride   uuid := gen_random_uuid();
  v_next   uuid := gen_random_uuid();
  v_failed timestamptz;
  r        jsonb := '{}'::jsonb;
BEGIN
  SELECT content INTO v_mig FROM net._http_response WHERE id = <request_id>;
  IF md5(v_mig) <> '<md5 of Step 1>' THEN
    RAISE EXCEPTION 'PROBE the fetched migration is not the file (md5 %)', md5(v_mig);
  END IF;
  EXECUTE v_mig;

  SELECT id INTO v_pax FROM auth.users WHERE phone = '5355550100';                 -- demo passenger
  SELECT id INTO v_ops FROM public.users WHERE id::text LIKE 'b2c3d4e5%' LIMIT 1;   -- test passenger as operator
  SELECT id INTO v_mark FROM public.users WHERE role = 'marketing' LIMIT 1;
  UPDATE public.users SET role = 'operator' WHERE id = v_ops;
  UPDATE public.users SET is_test = false WHERE id = v_pax;

  -- A request that found no driver 10 minutes ago, after 3 minutes. Scheduled first so nothing
  -- dispatches it; every push it queues dies with the rollback.
  INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, pickup_address,
                            dropoff_address, estimated_fare_cup, scheduled_at)
  VALUES (v_ride, v_pax, 'triciclo_basico',
          ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography,
          ST_SetSRID(ST_MakePoint(-82.3666, 23.1384), 4326)::geography,
          'Capitolio', 'Hotel Nacional', 3000, now() + interval '1 hour');
  UPDATE public.rides SET status = 'canceled', scheduled_at = NULL, is_scheduled = false,
         created_at = now() - interval '10 minutes', canceled_at = now() - interval '7 minutes'
   WHERE id = v_ride;
  SELECT canceled_at INTO v_failed FROM public.rides WHERE id = v_ride;

  INSERT INTO public.promotions (id, code, type, discount_fixed_cup, is_active, is_public, grant_only, max_uses)
  VALUES (v_promo, 'PRUEBA674', 'fixed_discount', 500, true, false, true, 10);

  -- as the operator
  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  SET LOCAL ROLE authenticated;
  r := r || jsonb_build_object('listed', (SELECT count(*) FROM public.admin_missed_riders('pending', 1) WHERE user_id = v_pax));
  r := r || jsonb_build_object('header', public.admin_missed_ride_coupon() ->> 'code');
  r := r || jsonb_build_object('contact', public.ops_contact_missed_rider(v_pax, v_failed));
  RESET ROLE;

  -- as the passenger: the prefill, the preview and a scheduled ride (no dispatch)
  PERFORM set_config('request.jwt.claim.sub', v_pax::text, true);
  SET LOCAL ROLE authenticated;
  r := r || jsonb_build_object('prefill', (SELECT code FROM public.get_my_signup_promotion()));
  r := r || jsonb_build_object('preview', public.validate_promo_code('PRUEBA674', v_pax, 3000));
  INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, pickup_address,
                            dropoff_address, estimated_fare_cup, scheduled_at)
  VALUES (v_next, v_pax, 'triciclo_basico',
          ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography,
          ST_SetSRID(ST_MakePoint(-82.3666, 23.1384), 4326)::geography,
          'Capitolio', 'Hotel Nacional', 3000, now() + interval '1 day');
  RESET ROLE;
  r := r || jsonb_build_object('ride', (SELECT jsonb_build_object('promo', promo_code_id = v_promo, 'discount', discount_amount_cup)
                                          FROM public.rides WHERE id = v_next));

  -- the operator again (the coupon is used now) and marketing
  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  SET LOCAL ROLE authenticated;
  r := r || jsonb_build_object('again', public.ops_contact_missed_rider(v_pax, v_failed));
  RESET ROLE;
  IF v_mark IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', v_mark::text, true);
    SET LOCAL ROLE authenticated;
    r := r || jsonb_build_object('marketing', public.ops_contact_missed_rider(v_pax, v_failed) ->> 'error');
    RESET ROLE;
  END IF;

  RAISE EXCEPTION 'PROBE %', r;
END
$probe$;
```

Expected in the error text: `listed` 1, `header` "PRUEBA674", `contact.coupon.code` "PRUEBA674", `prefill` "PRUEBA674", `preview.valid` true with `discount_amount` 500, `ride.promo` true and `ride.discount` 500, `again.coupon_reason` "coupon_used", `marketing` "forbidden". If the block fails for any other reason, read the error, fix, push, and repeat Steps 2-3.

- [ ] **Step 4: Confirm prod is unchanged**

```sql
SELECT to_regclass('public.promotion_grants') IS NULL AS no_table,
       md5(prosrc) = 'cad4cf62d95e5055950b67564c6da7f4' AS validator_unchanged
  FROM pg_proc WHERE proname = 'tg_rides_validate_promo_discount';
```

Expected: `true | true`.

---

### Task 11: CLAUDE.md and the PR

**Files:**
- Modify: `CLAUDE.md` (a new subsection after "Marketing maneja promociones y montos de referidos…", before "Canales de Realtime")

- [ ] **Step 1: Write the section**

```markdown
### Cupón de disculpa a quien no consiguió chofer (00674)

Desde `/missed-rides` ("Sin chofer"), operadores y admins le escriben por WhatsApp a quien pidió un viaje, no consiguió conductor y no volvió a viajar, y el servidor le da un cupón que se aplica solo en su próximo viaje. Diseño: `docs/superpowers/specs/2026-11-02-missed-ride-apology-coupon-design.md`. Ensayo: `supabase/tests/00674/run.sh` (reutiliza el andamio de la 00665 y le suma `extra.sql`).

- **Quién entra en la lista:** un viaje de pasajero cancelado sin conductor después de esperar `support_alert_after_s` (60 s), sin un viaje completado creado después, en una cuenta activa, que no es de prueba, del equipo ni de sistema (`_missed_rider_summary`).
- **El cupón** es una promoción con `grant_only` (casilla "Cupón de disculpa" en Promociones, solo al crearla). Nunca es pública (CHECK `promotions_grant_only_private`), y si alguien la tiene no se puede borrar (`ON DELETE RESTRICT`): se retira pausándola. Se da el activo más nuevo (`_missed_ride_current_coupon`).
- **Uno por teléfono confirmado, para siempre:** `_claim_reward(user, 'missed_ride_coupon')`, la regla de 00658. Una cuenta nueva con el mismo teléfono recibe `already_given`.
- **Se aplica solo:** `rides_promo_grant` (BEFORE INSERT, SECURITY INVOKER, antes que `rides_signup_promo` y el validador) pone el cupón cuando la persona no escribió un código, en un viaje de pasajero que paga ella. `_my_granted_promotion_id()` lo devuelve solo mientras el validador lo aceptaría: si devolviera uno usado, la promoción del código de origen no se aplicaría nunca más.
- **Nadie más lo usa:** el validador y `validate_promo_code` rechazan una promoción `grant_only` a quien no tiene el cupón (`invalid`).
- **Las apps instaladas lo muestran** sin build: `get_my_signup_promotion` lo devuelve primero, con su propio código en `signup_code` ("Descuento de tu código PERDON: 500 CUP").
- **Escribir** (`ops_contact_missed_rider`): atado a la última falla que mostró la lista (`missed_rider_changed`), nunca a uno mismo, sin teléfono confirmado `no_phone`; registra el contacto en `missed_ride_contacts` y una fila en `admin_actions`. Las dos tablas son tablas-candado. La pestaña de WhatsApp se abre en el mismo clic (si no, el navegador la bloquea).
- **El autochequeo de 00674 lleva la lista entera** de funciones que pueden llamar a los chequeos del operador (00668, 00671, 00672, 00673 y las tres de 00674). Re-correr la 00673 ahora aborta.
- **Parcheó tres funciones vivas:** el validador (`cad4cf62…` →), `validate_promo_code` (`95280581…` →) y `get_my_signup_promotion` (`b4209984…` →). Una migración que las redefina tiene que partir de estos cuerpos. Cuerpos tras 00674 (md5/largo): <pegar la lista que imprimió run.sh en Task 2 Step 3>.
- **Estado:** <aplicada / no aplicada>.
```

Replace the two `<…>` with the real values before committing: the md5 list printed by the rehearsal, and the state after Task 12.

- [ ] **Step 2: Commit and open the PR (ask the owner first)**

```bash
git add CLAUDE.md
git commit -m "docs: missed-ride apology coupon in CLAUDE.md"
git push
gh pr create --base master --head claude/missed-ride-apology-coupon --title "feat: apology coupon for people whose ride found no driver (00674)" --body-file .pr-body-temp.md
```

The PR body (write it to `.pr-body-temp.md` with the Write tool, delete it after) covers: why, what (migration, panel, services), verification (rehearsal counts, prod rehearsal results, tests, types), deploy order (apply 00674, then merge; no app build or OTA), and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

### Task 12: Rollout (each step with the owner's OK)

- [ ] Apply 00674 in prod by MCP with the `net.http_get` + md5 `DO` block (as 00671–00673). Verify by object: the bodies' md5 = the rehearsal's, the trigger order, the two tables locked, `promotions.grant_only` present.
- [ ] Merge the PR (deploys the panel). Check the deploy of the admin finished.
- [ ] Tell the owner: create the coupon in Promociones (fixed amount, `max_uses` as budget).
- [ ] Update CLAUDE.md's state line and the operator guide (Claude Docs `ecb6f3ab…`).
