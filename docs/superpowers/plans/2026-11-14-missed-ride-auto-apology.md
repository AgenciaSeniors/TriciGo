# Automatic Apology for Rides With No Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a passenger's ride ends with no driver, a server job gives them the 10 % apology coupon
(once per phone), opens a support ticket with an apology and sends a push, with no one on the team
doing anything.

**Architecture:** Migration 00681 adds:
- the `PERDON10` grant-only promotion;
- a lock table `missed_ride_auto_apologies`;
- `grant_missed_ride_apologies()`, a SECURITY DEFINER job run by pg_cron every minute;
- a helper that writes the discount text.

The job reuses everything from 00674: the segment (`_missed_rider_summary`), the coupon picker
(`_missed_ride_current_coupon`), the one-per-phone claim (`_claim_reward`) and the coupon on the next
ride (`rides_promo_grant`). The admin gets one new config key. No app changes.

**Tech Stack:** Postgres 17 (Supabase) plpgsql, pg_cron, `cron_http_post` → `send-push`; bash
rehearsal against local Postgres 16; Next.js admin (one `KNOWN_KEYS` entry + i18n).

Spec: `docs/superpowers/specs/2026-11-14-missed-ride-auto-apology-design.md`.

**Ground rules (CLAUDE.md):**
- Every push, prod apply, PR comment and merge needs the owner's OK, per action. Local commits do not.
- The migration number is 00681. Master ends at 00680; the open PRs hold 00569 and 00662.
  Re-check right before the prod apply:
  `git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3`, and
  `gh pr view <n> --json files` for every open PR.
- Local cluster: the Docker `pg673` container (`PGBIN=/usr/local/bin PGPORT=5432`, user `pgtest`), or
  the CLAUDE.md setup. On Windows, prefix with `MSYS_NO_PATHCONV=1`.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/tests/00681/extra.sql` (create) | What the rehearsal needs beyond the 00674 base: support tables, `rpc_attempt_log`, live helper bodies, stubs for `cron_http_post`, `get_service_role_key` and the `cron` schema |
| `supabase/tests/00681/run.sh` (create) | RED/GREEN rehearsal, negative proofs, body md5s for CLAUDE.md |
| `supabase/migrations/00681_missed_ride_auto_apology.sql` (create) | Settings, promotion, table, index, functions, cron job, self-checks |
| `apps/admin/src/app/settings/platform-config/page.tsx` (modify) | `KNOWN_KEYS` entries for the two new settings |
| `packages/i18n/src/locales/{es,en,pt}/admin.json` (modify) | Labels and help for the two settings |
| `CLAUDE.md` (modify) | Section "Disculpa automática cuando no hay chofer (00681)" |

---

### Task 1: Rehearsal scaffold

**Files:**
- Create: `supabase/tests/00681/extra.sql`

- [ ] **Step 1: Write `extra.sql`**

```sql
-- What the 00681 rehearsal needs beyond the 00674 base (00665 scaffold, migration 00665,
-- tests/00674/extra.sql, migration 00674), as in prod on 2026-11-14: the support tables,
-- rpc_attempt_log, the LIVE bodies of log_rpc_attempt() and _third_party_person_name() (run.sh S0
-- checks their md5), and stubs for get_service_role_key(), cron_http_post() and pg_cron.
-- Run by the test superuser.

CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY,
  jobname text UNIQUE,
  schedule text NOT NULL,
  command text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid
$$;
CREATE FUNCTION cron.alter_job(job_id bigint, active boolean) RETURNS void
LANGUAGE sql AS $$ UPDATE cron.job SET active = $2 WHERE jobid = $1 $$;
GRANT USAGE ON SCHEMA cron TO tricigo_owner;
GRANT SELECT, INSERT, UPDATE ON cron.job TO tricigo_owner;
GRANT USAGE ON SEQUENCE cron.job_jobid_seq TO tricigo_owner;

SET ROLE tricigo_owner;

ALTER TABLE public.promotions
  ADD COLUMN notify_on_publish boolean NOT NULL DEFAULT true,
  ADD COLUMN title_es text;

CREATE TABLE public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  ride_id uuid REFERENCES public.rides(id),
  category text NOT NULL,
  subject text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open',
  priority text DEFAULT 'normal',
  assigned_to uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  resolved_at timestamptz
);
CREATE TABLE public.ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.users(id),
  message text NOT NULL,
  is_admin boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.rpc_attempt_log (
  id bigserial PRIMARY KEY,
  rpc_name text NOT NULL,
  caller_uid uuid,
  target_id uuid,
  outcome text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- What cron_http_post was asked to send (prod: pg_net + cron_http_calls).
CREATE TABLE public.test_http_calls (jobname text, url text, body jsonb);
CREATE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb,
                                      body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO public.test_http_calls (jobname, url, body) VALUES (p_jobname, url, body) RETURNING 1::bigint
$$;
CREATE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'test-service-key' $$;

-- LIVE bodies (prod, 2026-11-14).
CREATE OR REPLACE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid, p_outcome text, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO rpc_attempt_log (rpc_name, caller_uid, target_id, outcome, metadata)
  VALUES (p_rpc_name, p_caller_uid, p_target_id, p_outcome, p_metadata);
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public._third_party_person_name(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH w AS (
    SELECT t.word, row_number() OVER (ORDER BY t.ord) AS n
    FROM (
      SELECT regexp_replace(s.word, '[^A-Za-zÀ-ÖØ-öø-ÿ''-]', '', 'g') AS word, s.ord
      FROM regexp_split_to_table(coalesce(p_name, ''), '\s+') WITH ORDINALITY AS s(word, ord)
    ) t
    WHERE t.word ~ '[A-Za-zÀ-ÖØ-öø-ÿ]'
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM w WHERE n = 2) THEN (SELECT left(word, 20) FROM w WHERE n = 1)
    ELSE (SELECT left(word, 20) FROM w WHERE n = 1) || ' ' || (SELECT upper(left(word, 1)) FROM w WHERE n = 2) || '.'
  END;
$function$;

RESET ROLE;
```

Write the file with the Write tool, not a shell heredoc: the Bash tool collapses `\\` (memory
`reference_bash_tool_backslash_collapse`), and `'\s+'` has to stay one backslash.

- [ ] **Step 2: Commit**

```bash
git add supabase/tests/00681/extra.sql
git commit -m "test(00681): scaffold for the automatic apology rehearsal"
```

---

### Task 2: Rehearsal runner (RED)

**Files:**
- Create: `supabase/tests/00681/run.sh`

- [ ] **Step 1: Write `run.sh`**

```bash
#!/usr/bin/env bash
# Rehearsal runner for migration 00681 (local Postgres 16, no PostGIS needed).
#   supabase/tests/00681/run.sh none
#       -> base (00665 scaffold, migration 00665, tests/00674/extra.sql, migration 00674, extra.sql) + tests (RED)
#   supabase/tests/00681/run.sh supabase/migrations/00681_missed_ride_auto_apology.sql
#       -> the same + migration x2 + tests + CRLF copy + negative proofs (GREEN)
# The migrations are applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> ...   Another database name: PGDB=<name> ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB="${PGDB:-pr681}"
NEG="${DB}n"
M665="$REPO/supabase/migrations/00665_signup_code_promotion.sql"
M674="$REPO/supabase/migrations/00674_missed_ride_apology_coupon.sql"
FRESHLOG="$(mktemp)"; trap 'rm -f "$FRESHLOG"' EXIT
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }
apply_err(){ local out; if out=$("$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

PLAT=00000000-0000-0000-0000-000000000001   # the platform account (grants and support messages)
ANA=a1000000-0000-4000-8000-000000000001    # "Ana Pérez", confirmed phone
ANA2=a1000000-0000-4000-8000-000000000011   # gets ANA's phone in B2
BETO=a1000000-0000-4000-8000-000000000002   # no name, confirmed phone
NORA=a1000000-0000-4000-8000-000000000004   # phone never confirmed
TINA=a1000000-0000-4000-8000-000000000005   # test account
MARK=a1000000-0000-4000-8000-000000000006   # marketing (team)
COMP=a1000000-0000-4000-8000-000000000007   # takes a ride after the failure
DIEGO=d1000000-0000-4000-8000-000000000001; DP=dd100000-0000-4000-8000-000000000001
PICK="'POINT(-82.3666 23.1357)'"
DROP="'POINT(-82.3666 23.1384)'"
R1=33333333-0000-4000-8000-000000000001

tx(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
client(){ printf "SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; SET LOCAL request.jwt.claim.sub = '';" "$1" "$2"; }
ride(){ echo "INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup)
        VALUES ('$1', '$2', 'auto_standard', $PICK, $DROP, 4000);"; }
# missed USER AGO WAIT [MODE] [DRIVER]: a request USER made AGO, canceled after WAIT
missed(){ local drv="NULL"; [ -n "${5:-}" ] && drv="'$5'"
  echo "INSERT INTO public.rides (customer_id, driver_id, service_type, status, ride_mode, pickup_location, dropoff_location, estimated_fare_cup, created_at, canceled_at)
        VALUES ('$1', $drv, 'auto_standard', 'canceled', '${4:-passenger}', $PICK, $DROP, 4000, now() - interval '$2', now() - interval '$2' + interval '$3');"; }
JOB="DO \$j\$ BEGIN PERFORM public.grant_missed_ride_apologies(); END \$j\$;"
# out USER: the outcomes recorded for USER's rides, oldest failure first
out(){ echo "SELECT coalesce(string_agg(a.outcome, ',' ORDER BY r.canceled_at), '') FROM public.missed_ride_auto_apologies a
             JOIN public.rides r ON r.id = a.ride_id WHERE a.user_id = '$1';"; }
COUNTS="SELECT (SELECT count(*) FROM public.missed_ride_auto_apologies) || '|' || (SELECT count(*) FROM public.support_tickets)
        || '|' || (SELECT count(*) FROM public.test_http_calls);"
PUSH="SELECT string_agg(jobname || '|' || (body ->> 'user_id') || '|' || (body ->> 'category') || '|' || (body ->> 'title') || '|'
        || (body ->> 'body') || '|' || (body -> 'data' ->> 'event'), ';') FROM public.test_http_calls;"
NEWFNS="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ('grant_missed_ride_apologies', '_apology_discount_text')"
LIVE="SELECT string_agg(proname || '=' || left(md5(replace(prosrc, chr(13), '')), 8), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname IN ('_missed_rider_summary', '_missed_ride_current_coupon',
        '_third_party_person_name', 'log_rpc_attempt')"
LIVE_MD5="_missed_ride_current_coupon=02b7b414,_missed_rider_summary=000c363a,_third_party_person_name=5cf39558,log_rpc_attempt=0a902c34"

# fresh DB [no674]: the base and the seed. On a failure it prints what psql said and returns 1.
fresh(){ : > "$FRESHLOG"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- create database failed:"; cat "$FRESHLOG"; return 1; }
  (cd "$REPO/supabase/tests/00665" && "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f scaffold.sql >/dev/null 2>>"$FRESHLOG") \
    || { echo "-- the 00665 scaffold failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M665" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- migration 00665 failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/00674/extra.sql" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- tests/00674/extra.sql failed:"; cat "$FRESHLOG"; return 1; }
  if [ "${2:-}" != no674 ]; then
    "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M674" >/dev/null 2>>"$FRESHLOG" \
      || { echo "-- migration 00674 failed:"; cat "$FRESHLOG"; return 1; }
  fi
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/extra.sql" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- extra.sql failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name, is_test) VALUES
    ('$PLAT', 'customer', 'TriciGo', false), ('$ANA', 'customer', 'Ana Pérez', false), ('$ANA2', 'customer', 'Ana otra vez', false),
    ('$BETO', 'customer', NULL, false), ('$NORA', 'customer', 'Nora', false), ('$TINA', 'customer', 'Tina', true),
    ('$MARK', 'marketing', 'Mark', false), ('$COMP', 'customer', 'Coco', false), ('$DIEGO', 'driver', 'Diego', false);
  INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
    ('$ANA', '5355510001', now()), ('$BETO', '5355510002', now()), ('$NORA', '5355510004', NULL),
    ('$TINA', '5355510005', now()), ('$MARK', '5355510006', now()), ('$COMP', '5355510007', now()),
    ('$DIEGO', '5355510008', now());
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP', '$DIEGO');
  INSERT INTO public.platform_config (key, value) VALUES ('support_alert_after_s', '60');" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- seed failed:"; cat "$FRESHLOG"; return 1; }; }

echo "== reset database =="
fresh $DB || { echo "base failed"; exit 1; }
val "S0 the base carries prod's live bodies" "$LIVE" "$LIVE_MD5"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  run $DB "UPDATE cron.job SET active = false WHERE jobname = 'grant-missed-ride-apologies';
           UPDATE public.promotions SET discount_percent = 15 WHERE code = 'PERDON10';" >/dev/null
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1 || { echo "migration NOT idempotent"; exit 1; }
  val "M1 a paused job is switched back on" "SELECT active FROM cron.job WHERE jobname = 'grant-missed-ride-apologies';" "t"
  val "M2 the second run leaves an edited promotion alone" "SELECT discount_percent FROM public.promotions WHERE code = 'PERDON10';" "15"
  # Back to 10 %, and rides from the last day count (the migration sets the start to its own run).
  run $DB "UPDATE public.promotions SET discount_percent = 10 WHERE code = 'PERDON10';
           UPDATE public.platform_config SET value = to_jsonb(now() - interval '1 day') WHERE key = 'missed_ride_auto_apology_since';" >/dev/null
fi

echo "== 1. the apology goes out =="
val "A1 a ride with no driver after 2 min gives the coupon" "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB $(out $ANA)")" "granted"
val "A2 the grant is PERDON10, given by the platform" \
  "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB SELECT p.code || '|' || g.granted_by FROM public.promotion_grants g JOIN public.promotions p ON p.id = g.promotion_id WHERE g.user_id = '$ANA';")" \
  "PERDON10|$PLAT"
val "A3 a support ticket with the apology" \
  "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB SELECT t.status || '|' || t.category || '|' || t.priority || '|' || (t.ride_id IS NOT NULL) || '|' || m.is_admin || '|' || m.sender_id || '|' || m.message FROM public.support_tickets t JOIN public.ticket_messages m ON m.ticket_id = t.id WHERE t.user_id = '$ANA';")" \
  "waiting_user|ride_issue|low|true|true|$PLAT|Hola Ana, sentimos que no encontraras chofer para tu viaje. Para agradecerte la paciencia, tu próximo viaje tiene 10 % de descuento: se aplica solo cuando lo pidas. Si necesitas algo más, respóndenos aquí."
val "A4 a push to the person" "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB $PUSH")" \
  "missed-ride-apology|$ANA|system|Perdón, no encontramos chofer|Te regalamos 10 % de descuento en tu próximo viaje. Se aplica solo cuando lo pidas.|missed_ride_apology"
val "A5 a second run sends nothing new" "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB $JOB $COUNTS")" "1|1|1"
val "A6 the next ride carries the coupon" \
  "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB $(client $ANA "$(ride $R1 $ANA)") SELECT coalesce(p.code, 'none') FROM public.rides r LEFT JOIN public.promotions p ON p.id = r.promo_code_id WHERE r.id = '$R1';")" \
  "PERDON10"
val "A7 without a name it starts with Hola," \
  "$(tx "$(missed $BETO '10 minutes' '2 minutes') $JOB SELECT left(m.message, 15) FROM public.ticket_messages m JOIN public.support_tickets t ON t.id = m.ticket_id WHERE t.user_id = '$BETO';")" \
  "Hola, sentimos "

echo "== 2. once per phone, and who is left out =="
val "B1 a second failure of the same person" "$(tx "$(missed $ANA '20 minutes' '2 minutes') $(missed $ANA '10 minutes' '2 minutes') $JOB $(out $ANA)")" "granted,already_given"
val "B2 the same phone on another account" \
  "$(tx "$(missed $ANA '20 minutes' '2 minutes') $JOB UPDATE auth.users SET phone = NULL WHERE id = '$ANA'; INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$ANA2', '5355510001', now()); $(missed $ANA2 '10 minutes' '2 minutes') $JOB $(out $ANA2)")" \
  "already_given"
val "B3 a coupon given by WhatsApp first" \
  "$(tx "INSERT INTO public.promotion_grants (promotion_id, user_id, source, granted_by) SELECT id, '$ANA', 'missed_ride', '$PLAT' FROM public.promotions WHERE code = 'PERDON10'; $(missed $ANA '10 minutes' '2 minutes') $JOB $(out $ANA)")" \
  "already_given"
val "B4 no confirmed phone" "$(tx "$(missed $NORA '10 minutes' '2 minutes') $JOB $(out $NORA)")" "no_phone"
val "B5 a test account" "$(tx "$(missed $TINA '10 minutes' '2 minutes') $JOB $(out $TINA)")" "not_eligible"
val "B6 a team account" "$(tx "$(missed $MARK '10 minutes' '2 minutes') $JOB $(out $MARK)")" "not_eligible"
val "B7 took a ride since" \
  "$(tx "$(missed $COMP '30 minutes' '2 minutes') INSERT INTO public.rides (customer_id, driver_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at) VALUES ('$COMP', '$DP', 'auto_standard', 'completed', $PICK, $DROP, 4000, now() - interval '5 minutes'); $JOB $(out $COMP)")" \
  "not_eligible"
val "B8 waited 20 s" "$(tx "$(missed $ANA '10 minutes' '20 seconds') $JOB $(out $ANA)")" ""
val "B9 the ride had a driver" "$(tx "$(missed $ANA '10 minutes' '2 minutes' passenger $DP) $JOB $(out $ANA)")" ""
val "B10 a delivery" "$(tx "$(missed $ANA '10 minutes' '2 minutes' cargo) $JOB $(out $ANA)")" ""
val "B11 canceled more than 2 hours ago" "$(tx "$(missed $ANA '3 hours' '2 minutes') $JOB $(out $ANA)")" ""
val "B12 canceled before the start date" \
  "$(tx "UPDATE public.platform_config SET value = to_jsonb(now()) WHERE key = 'missed_ride_auto_apology_since'; $(missed $ANA '10 minutes' '2 minutes') $JOB $(out $ANA)")" ""
val "B13 the off switch" \
  "$(tx "UPDATE public.platform_config SET value = '\"false\"' WHERE key = 'missed_ride_auto_apology_enabled'; $(missed $ANA '10 minutes' '2 minutes') $JOB $(out $ANA)")" ""
val "B14 no usable promotion: recorded, nothing sent" \
  "$(tx "UPDATE public.promotions SET is_active = false WHERE grant_only; $(missed $ANA '10 minutes' '2 minutes') $JOB SELECT ($(out $ANA | sed 's/;$//')) || '|' || (SELECT count(*) FROM public.support_tickets) || '|' || (SELECT count(*) FROM public.test_http_calls);")" \
  "no_coupon|0|0"
val "B15 a fixed-amount coupon says so" \
  "$(tx "INSERT INTO public.promotions (code, type, discount_fixed_cup, is_public, grant_only, created_at) VALUES ('PERDON500', 'fixed_discount', 500, false, true, now() + interval '1 second'); $(missed $ANA '10 minutes' '2 minutes') $JOB SELECT body ->> 'body' FROM public.test_http_calls;")" \
  "Te regalamos 500 CUP de descuento en tu próximo viaje. Se aplica solo cuando lo pidas."
val "B16 the discount text" \
  "$(tx "INSERT INTO public.promotions (id, code, type, discount_percent, is_public, grant_only) VALUES ('$R1', 'P125', 'percentage_discount', 12.5, false, true); SELECT coalesce(public._apology_discount_text('$R1'), 'null');")" \
  "12,5 % de descuento"

echo "== 3. errors =="
FAILBETO="CREATE FUNCTION public.zz_fail() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN IF NEW.user_id = '$BETO' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END \$f\$;
          CREATE TRIGGER zz_fail BEFORE INSERT ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.zz_fail();"
FAILALL="CREATE FUNCTION public.zz_fail() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RAISE EXCEPTION 'boom'; END \$f\$;
         CREATE TRIGGER zz_fail BEFORE INSERT ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.zz_fail();"
NOKEY="CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';"
val "C1 one failing ride does not stop the others, and leaves nothing behind" \
  "$(tx "$FAILBETO $(missed $ANA '10 minutes' '2 minutes') $(missed $BETO '9 minutes' '2 minutes') $JOB SELECT (SELECT string_agg(outcome, ',') FROM public.missed_ride_auto_apologies) || '|' || (SELECT count(*) FROM public.rpc_attempt_log WHERE rpc_name = 'grant_missed_ride_apologies' AND outcome = 'failed') || '|' || (SELECT count(*) FROM public.promotion_grants WHERE user_id = '$BETO');")" \
  "granted|1|0"
err "C2 when every ride fails, the run fails" "$(tx "$FAILALL $(missed $ANA '10 minutes' '2 minutes') $JOB")" "none processed"
err "C3 no service key fails the run" "$(tx "$NOKEY $(missed $ANA '10 minutes' '2 minutes') $JOB")" "no service role key"
val "C4 nothing to do needs no key" "$(tx "$NOKEY $JOB")" ""

echo "== 4. shape =="
val "D1 the apology promotion" \
  "SELECT count(*) || '|' || string_agg(code || ',' || discount_percent || ',' || is_public || ',' || first_ride_only || ',' || notify_on_publish || ',' || is_active, ';') FROM public.promotions WHERE grant_only;" \
  "1|PERDON10,10,false,false,false,true"
val "D2 the job runs every minute" \
  "SELECT schedule || '|' || command || '|' || active FROM cron.job WHERE jobname = 'grant-missed-ride-apologies';" \
  "* * * * *|SELECT public.grant_missed_ride_apologies();|true"
val "D3 no client can call the functions" \
  "SELECT string_agg(has_function_privilege('anon', u.f, 'EXECUTE') || '/' || has_function_privilege('authenticated', u.f, 'EXECUTE'), ',' ORDER BY u.i)
     FROM unnest(ARRAY['public.grant_missed_ride_apologies()', 'public._apology_discount_text(uuid)']) WITH ORDINALITY AS u(f, i);" \
  "false/false,false/false"
val "D4 no client can read or write the tracking table" \
  "SELECT has_table_privilege('anon', 'public.missed_ride_auto_apologies', 'SELECT,INSERT,UPDATE,DELETE') || '/' || has_table_privilege('authenticated', 'public.missed_ride_auto_apologies', 'SELECT,INSERT,UPDATE,DELETE');" \
  "false/false"
val "D5 switched on by default" "SELECT value #>> '{}' FROM public.platform_config WHERE key = 'missed_ride_auto_apology_enabled';" "true"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  fresh_neg(){ fresh $NEG ${1:-} || { echo "negative-proof database failed"; exit 1; }; }
  mutant(){ sed -e "$2" "$MIG" > "$1"; ! cmp -s "$MIG" "$1"; }
  neg_mutant(){ local id="$1" label="$2" script="$3" want="$4" f r; f="$(mktemp)"
    if ! mutant "$f" "$script"; then ko "$id $label" "setup did not change the migration copy"; rm -f "$f"; return; fi
    fresh_neg; r=$(apply_err $NEG "$f"); rm -f "$f"
    echo "$r" | grep -q "$want" && ok "$id $label" || ko "$id $label" "got [$r]"; }
  neg_mutant N1 "a job open to the apps aborts it" \
    's/^REVOKE ALL ON FUNCTION public.grant_missed_ride_apologies() FROM PUBLIC, anon, authenticated;$/GRANT EXECUTE ON FUNCTION public.grant_missed_ride_apologies() TO authenticated;/' \
    "is open to a client"
  neg_mutant N2 "a tracking table open to the apps aborts it" \
    's/^REVOKE ALL ON public.missed_ride_auto_apologies FROM PUBLIC, anon, authenticated;$/GRANT SELECT ON public.missed_ride_auto_apologies TO authenticated;/' \
    "missed_ride_auto_apologies is open to a client"
  fresh_neg
  run $NEG "INSERT INTO public.promotions (code, type, discount_fixed_cup, is_public, grant_only) VALUES ('PERDON', 'fixed_discount', 500, false, true);" >/dev/null
  r=$(apply_err $NEG "$MIG")
  [ "$r" = applied ] && [ "$(run $NEG "SELECT string_agg(code, ',') FROM public.promotions WHERE grant_only;")" = "PERDON" ] \
    && ok "N3 an existing apology promotion is kept, not doubled" || ko "N3 an existing apology promotion is kept, not doubled" "apply [$r]"
  fresh_neg no674
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "needs 00674" \
    && ok "N4 without 00674 it aborts" || ko "N4 without 00674 it aborts" "got [$r]"
  fresh_neg
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $NEG "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ] && [ "$(run $NEG "$NEWFNS")" = "$(run $DB "$NEWFNS")" ]; then
    ok "N5 pasted with CRLF line ends, the bodies match the LF ones"
  else ko "N5 pasted with CRLF line ends, the bodies match the LF ones" "apply [$r], bodies [$(run $NEG "$NEWFNS")]"; fi
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1
  echo "== bodies after 00681 (copy into CLAUDE.md) =="
  "$BIN/psql" $CONN -d "$DB" -qAt -c "SELECT string_agg(proname || ' ' || md5(prosrc) || '/' || length(prosrc), E'\n' ORDER BY proname COLLATE \"C\") FROM pg_proc
           WHERE pronamespace = 'public'::regnamespace AND proname IN ('grant_missed_ride_apologies', '_apology_discount_text')" | tr -d '\r'
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
```

Write it with the Write tool, then `git update-index --chmod=+x supabase/tests/00681/run.sh`.

- [ ] **Step 2: Run it without the migration (RED)**

Run: `MSYS_NO_PATHCONV=1 PGBIN=/usr/local/bin PGPORT=5432 bash supabase/tests/00681/run.sh none` (inside or
against the `pg673` container; the CLAUDE.md cluster uses the defaults).

Expected: `S0` PASS, every other check FAIL with `function public.grant_missed_ride_apologies() does
not exist`, `relation "public.missed_ride_auto_apologies" does not exist` or an empty value. If S0
fails, the base is not prod: fix `extra.sql` before going on.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/00681/run.sh
git commit -m "test(00681): rehearsal for the automatic apology (red)"
```

---

### Task 3: Migration 00681 (GREEN)

**Files:**
- Create: `supabase/migrations/00681_missed_ride_auto_apology.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00681: automatic apology when a ride finds no driver.
-- Spec: docs/superpowers/specs/2026-11-14-missed-ride-auto-apology-design.md. Builds on 00674.
--
-- Every minute, grant_missed_ride_apologies() looks at the passenger rides canceled with no driver
-- after waiting support_alert_after_s (the "Sin chofer" rule) in the last two hours. Each person in
-- 00674's segment who has a confirmed phone and never got the apology coupon (the WhatsApp path
-- shares the once-per-phone claim) gets:
--   - the coupon on their next ride (00674's grant),
--   - a support ticket "waiting_user" with an apology from support,
--   - a push (category system, so a marketing opt-out does not silence it).
-- Every ride it looks at is recorded in missed_ride_auto_apologies with the outcome, so it is never
-- looked at twice. A ride whose block fails is logged in rpc_attempt_log and retried next minute;
-- when every ride of a run fails, the run fails and check_cron_sql_failures reports it.
-- The migration also creates the 10 % grant-only promotion PERDON10 when no grant-only promotion
-- exists. Marketing can edit or pause it in Promociones.

DO $need$
BEGIN
  IF to_regclass('public.promotion_grants') IS NULL
     OR to_regprocedure('public._missed_rider_summary(uuid)') IS NULL
     OR to_regprocedure('public._missed_ride_current_coupon()') IS NULL THEN
    RAISE EXCEPTION '00681 needs 00674 (the apology coupon) applied first';
  END IF;
END
$need$;

-- 1. Settings. The start date keeps the job from writing to people who failed before it existed.
INSERT INTO public.platform_config (key, value) VALUES
  ('missed_ride_auto_apology_enabled', '"true"'::jsonb),
  ('missed_ride_auto_apology_since', to_jsonb(now()))
ON CONFLICT (key) DO NOTHING;

-- 2. The apology promotion, unless one exists (a paused one is a decision: leave it).
INSERT INTO public.promotions (code, type, discount_percent, is_active, is_public, first_ride_only,
                               grant_only, notify_on_publish, title_es)
SELECT 'PERDON10', 'percentage_discount'::public.promotion_type, 10, true, false, false, true, false, 'Cupón de disculpa'
 WHERE NOT EXISTS (SELECT 1 FROM public.promotions WHERE grant_only OR code = 'PERDON10');

-- 3. What the job did with each ride (lock table).
CREATE TABLE IF NOT EXISTS public.missed_ride_auto_apologies (
  ride_id uuid PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  outcome text NOT NULL
    CHECK (outcome IN ('granted', 'already_given', 'no_phone', 'no_coupon', 'not_eligible')),
  grant_id uuid REFERENCES public.promotion_grants(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES public.support_tickets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS missed_ride_auto_apologies_user_idx ON public.missed_ride_auto_apologies (user_id);
ALTER TABLE public.missed_ride_auto_apologies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.missed_ride_auto_apologies FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.missed_ride_auto_apologies TO service_role;

-- The job's scan, every minute.
SET lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS rides_canceled_no_driver_idx ON public.rides (canceled_at)
  WHERE status = 'canceled' AND driver_id IS NULL;
RESET lock_timeout;

-- 4. The discount, as the apology says it: "10 % de descuento", "12,5 % de descuento",
-- "500 CUP de descuento". NULL when the promotion gives nothing a text can promise.
CREATE OR REPLACE FUNCTION public._apology_discount_text(p_promotion_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
           WHEN p.type = 'fixed_discount' AND p.discount_fixed_cup > 0
             THEN p.discount_fixed_cup::text || ' CUP de descuento'
           WHEN p.type = 'percentage_discount' AND p.discount_percent > 0
             THEN replace(trim_scale(p.discount_percent)::text, '.', ',') || ' % de descuento'
         END
    FROM public.promotions p
   WHERE p.id = p_promotion_id;
$function$;
REVOKE ALL ON FUNCTION public._apology_discount_text(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._apology_discount_text(uuid) TO service_role;

-- 5. The job.
CREATE OR REPLACE FUNCTION public.grant_missed_ride_apologies()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_platform constant uuid := '00000000-0000-0000-0000-000000000001';
  c_push_url constant text := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push';
  v_enabled text;
  v_since timestamptz;
  v_wait interval;
  v_key text;
  v_ride record;
  v_eligible boolean;
  v_coupon uuid;
  v_discount text;
  v_claim text;
  v_grant_id uuid;
  v_ticket_id uuid;
  v_outcome text;
  v_name text;
  v_done integer := 0;
  v_failed integer := 0;
BEGIN
  -- One run at a time: two overlapping runs would race for the same rides.
  IF NOT pg_try_advisory_xact_lock(hashtext('grant_missed_ride_apologies')) THEN
    RETURN 0;
  END IF;

  SELECT value #>> '{}' INTO v_enabled FROM platform_config WHERE key = 'missed_ride_auto_apology_enabled';
  IF lower(coalesce(v_enabled, 'true')) IN ('false', '0', 'off') THEN
    RETURN 0;
  END IF;
  SELECT (value #>> '{}')::timestamptz INTO v_since FROM platform_config WHERE key = 'missed_ride_auto_apology_since';
  IF v_since IS NULL THEN
    RAISE EXCEPTION 'grant_missed_ride_apologies: platform_config.missed_ride_auto_apology_since is missing'
      USING DETAIL = 'missed_ride_apology_no_since';
  END IF;
  v_wait := make_interval(secs => get_platform_config_numeric('support_alert_after_s', 60)::double precision);

  FOR v_ride IN
    SELECT r.id, r.customer_id
      FROM rides r
     WHERE r.status = 'canceled'
       AND r.driver_id IS NULL
       AND COALESCE(r.ride_mode, 'passenger') = 'passenger'
       AND r.canceled_at > GREATEST(v_since, now() - interval '2 hours')
       AND r.canceled_at - GREATEST(r.created_at, COALESCE(r.scheduled_at, r.created_at)) >= v_wait
       AND NOT EXISTS (SELECT 1 FROM missed_ride_auto_apologies a WHERE a.ride_id = r.id)
     ORDER BY r.canceled_at, r.id
     LIMIT 50
  LOOP
    IF v_key IS NULL THEN
      v_key := get_service_role_key();
      IF coalesce(v_key, '') = '' THEN
        RAISE EXCEPTION 'grant_missed_ride_apologies: no service role key in the vault'
          USING DETAIL = 'missed_ride_apology_no_service_key';
      END IF;
    END IF;

    BEGIN
      v_outcome := NULL; v_grant_id := NULL; v_ticket_id := NULL;

      SELECT s.eligible INTO v_eligible FROM _missed_rider_summary(v_ride.customer_id) s;
      IF NOT coalesce(v_eligible, false) THEN
        v_outcome := 'not_eligible';
      ELSIF NOT EXISTS (SELECT 1 FROM auth.users au
                         WHERE au.id = v_ride.customer_id AND au.phone_confirmed_at IS NOT NULL
                           AND coalesce(au.phone, '') <> '') THEN
        v_outcome := 'no_phone';
      ELSIF EXISTS (SELECT 1 FROM promotion_grants g
                     WHERE g.user_id = v_ride.customer_id AND g.source = 'missed_ride') THEN
        v_outcome := 'already_given';
      ELSE
        v_coupon := _missed_ride_current_coupon();
        v_discount := CASE WHEN v_coupon IS NOT NULL THEN _apology_discount_text(v_coupon) END;
        IF v_discount IS NULL THEN
          v_outcome := 'no_coupon';
        ELSE
          v_claim := _claim_reward(v_ride.customer_id, 'missed_ride_coupon');
          IF v_claim = 'taken' THEN
            -- The phone got the apology coupon before, on this or another account.
            v_outcome := 'already_given';
          ELSIF v_claim IS DISTINCT FROM 'claimed' THEN
            v_outcome := 'no_phone';
          ELSE
            INSERT INTO promotion_grants (promotion_id, user_id, source, granted_by)
            VALUES (v_coupon, v_ride.customer_id, 'missed_ride', c_platform)
            RETURNING id INTO v_grant_id;

            SELECT coalesce(split_part(_third_party_person_name(u.full_name), ' ', 1), '')
              INTO v_name FROM users u WHERE u.id = v_ride.customer_id;

            INSERT INTO support_tickets (user_id, ride_id, category, subject, status, priority)
            VALUES (v_ride.customer_id, v_ride.id, 'ride_issue', 'Disculpa por tu viaje sin chofer',
                    'waiting_user', 'low')
            RETURNING id INTO v_ticket_id;
            INSERT INTO ticket_messages (ticket_id, sender_id, message, is_admin)
            VALUES (v_ticket_id, c_platform,
                    CASE WHEN coalesce(v_name, '') <> '' THEN 'Hola ' || v_name || ', ' ELSE 'Hola, ' END
                    || 'sentimos que no encontraras chofer para tu viaje. Para agradecerte la paciencia, '
                    || 'tu próximo viaje tiene ' || v_discount
                    || ': se aplica solo cuando lo pidas. Si necesitas algo más, respóndenos aquí.',
                    true);

            PERFORM cron_http_post('missed-ride-apology',
              url     := c_push_url,
              headers := jsonb_build_object('Content-Type', 'application/json',
                                            'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
              body    := jsonb_build_object(
                           'user_id', v_ride.customer_id::text,
                           'title', 'Perdón, no encontramos chofer',
                           'body', 'Te regalamos ' || v_discount
                                   || ' en tu próximo viaje. Se aplica solo cuando lo pidas.',
                           'category', 'system',
                           'data', jsonb_build_object('event', 'missed_ride_apology',
                                                      'ticket_id', v_ticket_id::text)));
            v_outcome := 'granted';
          END IF;
        END IF;
      END IF;

      INSERT INTO missed_ride_auto_apologies (ride_id, user_id, outcome, grant_id, ticket_id)
      VALUES (v_ride.id, v_ride.customer_id, v_outcome, v_grant_id, v_ticket_id);
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      -- This ride only: its claim, grant, ticket and push are undone, and the next run retries it.
      v_failed := v_failed + 1;
      PERFORM log_rpc_attempt('grant_missed_ride_apologies', NULL, v_ride.id, 'failed',
                              jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
    END;
  END LOOP;

  IF v_failed > 0 AND v_done = 0 THEN
    RAISE EXCEPTION 'grant_missed_ride_apologies: % ride(s) failed, none processed', v_failed
      USING DETAIL = 'missed_ride_apology_all_failed';
  END IF;
  RETURN v_done;
END;
$function$;
REVOKE ALL ON FUNCTION public.grant_missed_ride_apologies() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_missed_ride_apologies() TO service_role;

-- 6. Every minute. cron.schedule keeps a paused job paused: switch it back on.
DO $cron$
DECLARE
  v_job bigint;
BEGIN
  v_job := cron.schedule('grant-missed-ride-apologies', '* * * * *', 'SELECT public.grant_missed_ride_apologies();');
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_job AND NOT active) THEN
    PERFORM cron.alter_job(v_job, active := true);
  END IF;
END
$cron$;

-- 7. Self-checks.
DO $check$
DECLARE
  v_f text;
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p
           WHERE p.oid = 'public.grant_missed_ride_apologies()'::regprocedure) THEN
    RAISE EXCEPTION '00681: grant_missed_ride_apologies() must be SECURITY DEFINER';
  END IF;
  FOREACH v_f IN ARRAY ARRAY['public.grant_missed_ride_apologies()', 'public._apology_discount_text(uuid)'] LOOP
    IF pg_catalog.has_function_privilege('anon', v_f, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_f, 'EXECUTE') THEN
      RAISE EXCEPTION '00681: % is open to a client', v_f;
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege('anon', 'public.missed_ride_auto_apologies', 'SELECT,INSERT,UPDATE,DELETE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.missed_ride_auto_apologies', 'SELECT,INSERT,UPDATE,DELETE')
     OR NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
              WHERE c.oid = 'public.missed_ride_auto_apologies'::regclass) THEN
    RAISE EXCEPTION '00681: missed_ride_auto_apologies is open to a client';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'grant-missed-ride-apologies' AND active) THEN
    RAISE EXCEPTION '00681: the grant-missed-ride-apologies job is not scheduled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.promotions WHERE grant_only) THEN
    RAISE EXCEPTION '00681: no apology promotion exists';
  END IF;
END
$check$;
```

Write it with the Write tool.

- [ ] **Step 2: Run the rehearsal with the migration (GREEN)**

Run: `MSYS_NO_PATHCONV=1 PGBIN=/usr/local/bin PGPORT=5432 bash supabase/tests/00681/run.sh supabase/migrations/00681_missed_ride_auto_apology.sql`

Expected: every check PASS (`S0`, `M1`–`M2`, `A1`–`A7`, `B1`–`B16`, `C1`–`C4`, `D1`–`D5`,
`N1`–`N5`), then the two body md5s, then `0 failed`.

If a value differs, find out why before touching the test. For example, if `A6` gives `none`, check
`_my_granted_promotion_id` and the validator, not the expectation.

- [ ] **Step 3: Check the copy guards**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/copyTuteo.test.ts`
Expected: PASS. The guard reads migrations from 00639 on; the new texts are in tuteo.

Run: `pnpm check:migration-grants`
Expected: PASS. The new table has its GRANT, with `service_role`, in the same migration.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00681_missed_ride_auto_apology.sql
git commit -m "feat(00681): automatic apology for rides that found no driver"
```

---

### Task 4: Admin settings

**Files:**
- Modify: `apps/admin/src/app/settings/platform-config/page.tsx` (after `support_alert_enabled`, ~line 144)
- Modify: `packages/i18n/src/locales/es/admin.json`, `en/admin.json`, `pt/admin.json` (`platform_config` block, after `support_alert_enabled_help`)

- [ ] **Step 1: Add the two keys to `KNOWN_KEYS`**

After the `support_alert_enabled` line:

```tsx
  missed_ride_auto_apology_enabled: { type: 'select', helpKey: 'platform_config.missed_ride_auto_apology_enabled_help', options: [{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }] },
  missed_ride_auto_apology_since: { type: 'text', helpKey: 'platform_config.missed_ride_auto_apology_since_help' },
```

- [ ] **Step 2: Add the texts**

es (`platform_config`):
```json
    "missed_ride_auto_apology_enabled": "Disculpa automática sin chofer",
    "missed_ride_auto_apology_enabled_help": "true/false: cuando un viaje se cancela sin conductor después de esperar el tiempo de abajo, le da al pasajero el cupón de disculpa (una vez por teléfono), le escribe desde soporte y le manda un push.",
    "missed_ride_auto_apology_since": "Disculpa automática desde",
    "missed_ride_auto_apology_since_help": "Fecha y hora (UTC) desde la que se mandan disculpas automáticas. La puso la migración 00681; los viajes anteriores no reciben nada.",
```
en:
```json
    "missed_ride_auto_apology_enabled": "Automatic apology for rides with no driver",
    "missed_ride_auto_apology_enabled_help": "true/false: when a ride is canceled with no driver after waiting the time below, gives the rider the apology coupon (once per phone), writes to them from support and sends a push.",
    "missed_ride_auto_apology_since": "Automatic apology since",
    "missed_ride_auto_apology_since_help": "Date and time (UTC) from which automatic apologies are sent. Set by migration 00681; earlier rides get nothing.",
```
pt:
```json
    "missed_ride_auto_apology_enabled": "Desculpa automática sem motorista",
    "missed_ride_auto_apology_enabled_help": "true/false: quando uma viagem é cancelada sem motorista depois de esperar o tempo abaixo, dá ao passageiro o cupom de desculpas (uma vez por telefone), escreve para ele pelo suporte e envia um push.",
    "missed_ride_auto_apology_since": "Desculpa automática desde",
    "missed_ride_auto_apology_since_help": "Data e hora (UTC) a partir das quais as desculpas automáticas são enviadas. Definida pela migração 00681; viagens anteriores não recebem nada.",
```

- [ ] **Step 3: Verify**

Run: `node -e "for (const l of ['es','en','pt']) { const j = require('./packages/i18n/src/locales/' + l + '/admin.json'); if (!j.platform_config.missed_ride_auto_apology_enabled_help || !j.platform_config.missed_ride_auto_apology_since_help) throw new Error(l); } console.log('ok')"`
Expected: `ok`

Run: `pnpm --filter @tricigo/admin check-types`
Expected: exit 0

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/copyTuteo.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/app/settings/platform-config/page.tsx packages/i18n/src/locales/*/admin.json
git commit -m "feat(admin): settings for the automatic apology"
```

---

### Task 5: CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`: a new section right after "### Cupón de disculpa a quien no consiguió chofer (00674)"

- [ ] **Step 1: Add the section**

Use the md5s printed by Task 3 Step 2 for `<md5/len>`:

```markdown
### Disculpa automática cuando no hay chofer (00681)

Desde la 00681, nadie del equipo tiene que hacer nada para disculparse con quien se quedó sin chofer. Diseño: `docs/superpowers/specs/2026-11-14-missed-ride-auto-apology-design.md`. Ensayo: `supabase/tests/00681/run.sh` (con `none` pasa solo S0; con la migración, todo).

- **La tarea `grant-missed-ride-apologies`** corre cada minuto `grant_missed_ride_apologies()`. Toma los viajes de pasajero cancelados sin conductor después de esperar `support_alert_after_s`, que es la regla de "Sin chofer". Mira solo los de las últimas 2 horas y los posteriores a `missed_ride_auto_apology_since`, que fijó la migración, así que no le escribe a gente de antes. A cada persona del segmento de 00674 con teléfono confirmado:
  - le da el cupón de disculpa, una vez por teléfono y compartido con el de WhatsApp;
  - le abre un ticket `waiting_user` con la disculpa, firmado por la cuenta de plataforma;
  - le manda un push `system` por `cron_http_post`, con la etiqueta `missed-ride-apology`.
- **El cupón** es `PERDON10` (10 %), creado por la migración. Usa el más nuevo que esté activo, igual que WhatsApp. El texto sale de la promoción: si marketing la cambia, el texto cambia con ella.
- **Cada viaje queda en `missed_ride_auto_apologies`** con su resultado (`granted`, `already_given`, `no_phone`, `no_coupon`, `not_eligible`), así no se mira dos veces. Un viaje que falla queda en `rpc_attempt_log` (`grant_missed_ride_apologies`, `failed`) y se reintenta al minuto siguiente. Si fallan todos, falla la corrida y avisa `check_cron_sql_failures`.
- **Se apaga** con `missed_ride_auto_apology_enabled` = `false` en Configuración.
- **Diagnóstico:**
  ```sql
  SELECT outcome, count(*) FROM missed_ride_auto_apologies WHERE created_at > now() - interval '7 days' GROUP BY 1;
  SELECT c.called_at, r.status_code FROM cron_http_calls c LEFT JOIN net._http_response r ON r.id = c.request_id
  WHERE c.jobname = 'missed-ride-apology' ORDER BY c.called_at DESC LIMIT 10;
  ```
- Cuerpos tras 00681 (md5/largo): `_apology_discount_text` `<md5/len>`, `grant_missed_ride_apologies` `<md5/len>`.
- **Estado:** escrita y ensayada; no aplicada.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: automatic apology in CLAUDE.md"
```

---

### Task 6: Prod rehearsal (rolled back): needs the owner's OK to push the branch

- [ ] **Step 1: Push the branch (owner's OK) and open the PR (owner's OK)**

```bash
git push -u origin claude/missed-ride-auto-apology
```

The PR is in Brazilian Portuguese per the owner's rules, with the body from a file
(`gh pr create --body-file`).

- [ ] **Step 2: Rehearse in prod inside a rolled-back block**

Through MCP `execute_sql`, one statement:
- fetch `raw.githubusercontent.com/AgenciaSeniors/TriciGo/<sha>/supabase/migrations/00681_missed_ride_auto_apology.sql`
  with `net.http_get`;
- in a `DO` block, read the content from `net._http_response`, check its md5 against
  `md5sum` of the local file, `EXECUTE` it, and set `missed_ride_auto_apology_since` to `now() - interval '1 day'`;
- insert a canceled ride for the demo passenger (`+5355550100`, id from `auth.users`) created 10 min
  ago, canceled 2 min later, with no driver;
- run `grant_missed_ride_apologies()` and collect: the outcome, the ticket status and message, the
  `cron_http_calls` row for `missed-ride-apology`, and the promotion code;
- end with `RAISE EXCEPTION 'PROBE %', <collected>`.

`net.http_post` only queues inside the transaction, so the rollback cancels the push. Expected: `granted`
(or `already_given` if the demo phone ever got the coupon), a `waiting_user` ticket, one queued
call, and `PERDON10`.

Then confirm that nothing stayed: no `missed_ride_auto_apologies` table, no `PERDON10`.

---

### Task 7: Apply and merge: each needs the owner's OK

- [ ] **Step 1: Apply in prod** (owner's OK). Use the same `DO` as the rehearsal, without the probe and
  the `RAISE`. If MCP stays waiting for an approval that never comes, the owner pastes the file in
  the SQL Editor (CLAUDE.md § "Aplicar migraciones pesadas por MCP").
- [ ] **Step 2: Verify by object.** Check:
  - the two md5s from CLAUDE.md, with no `\r`;
  - `PERDON10` active, private, not first-ride-only, `notify_on_publish = false`;
  - the job active;
  - the table locked (no privileges for `anon` or `authenticated`);
  - the next two minutes of `cron.job_run_details` for the job: `succeeded`.
- [ ] **Step 3: Update CLAUDE.md "Estado"** with the apply timestamp, commit, push.
- [ ] **Step 4: Merge the PR** (owner's OK): `gh pr merge <n> --squash`, then
  `git push origin --delete claude/missed-ride-auto-apology` (memory `reference_gh_merge_worktree_master`).
