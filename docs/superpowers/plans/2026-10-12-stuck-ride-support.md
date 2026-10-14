# Stuck-Ride Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support can help a ride that already has a driver. From the assist page it can send the ride back to search, advance its status one step, or complete it and charge the agreed price plus the recorded wait. Every action needs a reason, leaves an audit row and pushes both parties.

**Architecture:** One migration (00660) adds:
- four `SECURITY DEFINER` RPCs gated by `is_admin()`;
- a pure wait-charge helper that `calculate_wait_charge` now calls;
- a GPS-departure helper and a charge preview;
- one admin-only FSM transition.

The admin assist page gets an "active ride" view. The driver app's 5 s trip poll applies a status that is further along than the one on screen. Spec: `docs/superpowers/specs/2026-10-12-stuck-ride-support-design.md`.

**Tech Stack:** PostgreSQL 16/17 + PostGIS (Supabase), plpgsql; Next.js 15 admin (React 19, Tailwind); Expo/React Native driver app; vitest; bash + psql rehearsal (CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod").

**Conventions that apply to every task:**
- Copy in Spanish uses tuteo. Code, comments and commits are in English.
- Commit footer:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki
  ```
- Branch `claude/pensive-archimedes-41vkeh`. Before each commit, check `git branch --show-current`.
- Nothing touches prod until Task 13, and only after explicit authorization.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/00660_stuck_ride_support.sql` (create) | Transition row, helpers, the `calculate_wait_charge` rewrite, 4 RPCs, grants, CRLF rebuild, self-checks |
| `supabase/tests/00660/scaffold-extra.sql` (create) | Adds to the 00659 scaffold whatever 00660 touches: columns, tables, prod's live function bodies and stubs |
| `supabase/tests/00660/run.sh` (create) | Rehearsal: 00659 scaffold → 00659 migration → extra → (00660 ×2) → tests → negative proofs |
| `packages/api/src/services/ride-assist.service.ts` (modify) | `ActiveRideContext` type + `getActiveContext`, `releaseActiveRide`, `advanceActiveRide`, `completeActiveRide` |
| `packages/api/src/services/__tests__/ride-assist.test.ts` (modify) | Tests for the 4 methods |
| `apps/admin/src/components/support/AssistActiveRide.tsx` (create) | Active-ride view: facts, contacts, charge preview, the 3 actions with confirm + reason |
| `apps/admin/src/app/rides/[id]/assist/page.tsx` (modify) | Render `AssistActiveRide` for the 5 active statuses |
| `apps/admin/src/app/rides/[id]/page.tsx` (modify) | "Asistir" also for active statuses |
| `apps/admin/src/components/dashboard/StuckRideBanner.tsx` (modify) | One alert links to `/rides/[id]/assist` |
| `apps/admin/src/components/support/assistErrors.ts` (modify) | New refusal codes |
| `packages/i18n/src/locales/{es,en,pt}/admin.json` (modify) | `ride_assist.active_*` and the new `error_*` keys |
| `apps/driver/src/utils/tripStatusOrder.ts` (create) | `isStatusAhead(server, local)` |
| `apps/driver/src/utils/__tests__/tripStatusOrder.test.ts` (create) | Unit tests |
| `apps/driver/src/hooks/useDriverRide.ts` (modify) | The poll applies a status that is further along, with a toast |
| `packages/i18n/src/locales/{es,en,pt}/driver.json` (modify) | `trip.trip_updated_title` / `trip.trip_updated_msg` |
| `docs/superpowers/specs/2026-10-12-stuck-ride-support-design.md` (modify) | Two refinements found while planning (Task 1) |
| `CLAUDE.md` (modify) | Section on stuck-ride support |

---

### Task 1: Confirm the migration number and refine the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-stuck-ride-support-design.md`

- [ ] **Step 1: Check that 00660 is free on master and in every open PR**

```bash
cd /home/user/TriciGo && git fetch -q origin master
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3
```
Expected: the newest is `00659_ride_trail_guards.sql`.

Then list the open PRs with the GitHub MCP (`mcp__github__list_pull_requests`, owner `agenciaseniors`, repo `tricigo`, state `open`), and for each one `mcp__github__pull_request_read` with method `get_files`. No file may match `supabase/migrations/00660_*`. If 00660 is taken, use the next free number. Replace `00660` everywhere in this plan's paths and in the migration's error messages.

- [ ] **Step 2: Apply two refinements found while planning**

In the spec, the bullet under "### Driver", **App change**, says "with a toast "Soporte actualizó tu viaje"". Replace it with: "with a neutral toast "Tu viaje se actualizó — Te mostramos el estado actual del viaje." (the poll cannot tell support's change from the driver's own tap whose answer was lost; the support push says who did it)".

In the "### Helpers" table, append this to the `_active_ride_charge_preview` row: "On a corporate ride with a commission below the default, `complete_ride_and_pay` lowers the final fare. The preview returns `is_corporate` and the panel says the final amount can be lower. `amount_changed` still compares the same preview."

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-12-stuck-ride-support-design.md
git commit -q -m "docs(support): refine the stuck-ride design (neutral driver toast, corporate preview)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 2: Capture the live function bodies for the rehearsal

**Files:**
- Create: `supabase/tests/00660/live-bodies.sql` (generated, committed)

The rehearsal needs prod's exact bodies of 7 functions. `get_driver_user_id`, `is_admin` and `current_user_role` already come from the 00659 scaffold.

- [ ] **Step 1: Read them from prod in one call, padded so the tool writes the answer to a file**

Run with `mcp__Supabase__execute_sql` (project `lqaufszburqvlslpcuac`):

```sql
SELECT json_build_object(
  'functions', (SELECT json_agg(json_build_object('name', p.proname, 'md5', md5(p.prosrc), 'def', pg_get_functiondef(p.oid)) ORDER BY p.proname)
                FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN
                ('calculate_wait_charge','enforce_ride_transition','notify_ride_status_change',
                 'get_platform_config_numeric','log_rpc_attempt','_ride_short_code','tg_ride_location_events_guard')),
  'pad', repeat('#', 150000)) AS j;
```

- [ ] **Step 2: Write them to `live-bodies.sql`, checking each md5**

Expected md5 values:

| Function | md5 |
|---|---|
| `calculate_wait_charge` | `2c0679d1ce8600da188e4ff101ddd2ca` |
| `enforce_ride_transition` | `f806997fab31c18e7b369e69f5321c30` |
| `notify_ride_status_change` | `b99d013d5585771cfd2be51788ae1fa4` |
| `get_platform_config_numeric` | `13d2587037eca74854cf2394ba42a90c` |
| `log_rpc_attempt` | `0a902c34a1148dac5686403a7c941bc0` |
| `_ride_short_code` | `7dae14319bfae57a2ac8b4317e928513` |
| `tg_ride_location_events_guard` | `a6af4796e5d96697a993127b819def6d` |

```bash
python3 - "<path of the saved tool-result file>" supabase/tests/00660/live-bodies.sql <<'PY'
import json, re, sys, hashlib
raw = open(sys.argv[1], encoding='utf-8').read()
outer = json.loads(raw) if raw.lstrip().startswith(('{', '[')) else {'result': raw}
text = outer.get('result', raw) if isinstance(outer, dict) else raw
inner = re.search(r'<untrusted-data-[^>]+>\s*(.*?)\s*</untrusted-data', text, re.S).group(1)
row = json.loads(inner)[0]['j']
row = json.loads(row) if isinstance(row, str) else row
want = {'calculate_wait_charge':'2c0679d1ce8600da188e4ff101ddd2ca','enforce_ride_transition':'f806997fab31c18e7b369e69f5321c30',
        'notify_ride_status_change':'b99d013d5585771cfd2be51788ae1fa4','get_platform_config_numeric':'13d2587037eca74854cf2394ba42a90c',
        'log_rpc_attempt':'0a902c34a1148dac5686403a7c941bc0','_ride_short_code':'7dae14319bfae57a2ac8b4317e928513',
        'tg_ride_location_events_guard':'a6af4796e5d96697a993127b819def6d'}
out = ['-- Live bodies read from prod on 2026-10-12 (pg_get_functiondef). Do not edit by hand.']
for f in row['functions']:
    assert f['md5'] == want[f['name']], (f['name'], f['md5'])
    body = f['def'].rstrip()
    out.append(f"-- live {f['name']}: md5 {f['md5']}")
    out.append(body + ';\n')
assert len(row['functions']) == 7
open(sys.argv[2], 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
print('ok', len(row['functions']))
PY
```
Expected: `ok 7`. The body of `tg_ride_location_events_guard` is already installed by the 00659 migration in the rehearsal, so `scaffold-extra.sql` (Task 3) loads every function from this file except that one. It is kept here for its md5 check.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/00660/live-bodies.sql
git commit -q -m "test(00660): capture prod bodies the stuck-ride rehearsal needs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 3: Rehearsal scaffold additions

**Files:**
- Create: `supabase/tests/00660/scaffold-extra.sql`

The base is `supabase/tests/00659/scaffold.sql` followed by the 00659 migration (prod's state today). This file adds what 00660 touches. Like the 00659 scaffold, it runs as a superuser and switches to `tricigo_owner`.

- [ ] **Step 1: Write the file**

```sql
-- Additions to the 00659 scaffold (+ the 00659 migration) for the 00660 rehearsal.
-- Columns, tables and seed rows mirror prod (2026-10-12). Live bodies come from
-- live-bodies.sql (md5-checked); complete_ride_and_pay, dispatch_ride and
-- cron_http_post are stubs that record their calls.
SET ROLE tricigo_owner;

ALTER TABLE public.users ADD COLUMN phone text, ADD COLUMN is_test boolean NOT NULL DEFAULT false;
ALTER TABLE public.driver_profiles
  ADD COLUMN status text NOT NULL DEFAULT 'approved',
  ADD COLUMN is_online boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_offline_at timestamptz,
  ADD COLUMN last_heartbeat_at timestamptz;
ALTER TABLE public.rides
  ADD COLUMN service_type text NOT NULL DEFAULT 'triciclo_basico',
  ADD COLUMN payment_method text NOT NULL DEFAULT 'cash',
  ADD COLUMN estimated_fare_cup integer NOT NULL DEFAULT 3000,
  ADD COLUMN discount_amount_cup integer NOT NULL DEFAULT 0,
  ADD COLUMN estimated_distance_m integer NOT NULL DEFAULT 4000,
  ADD COLUMN estimated_duration_s integer NOT NULL DEFAULT 900,
  ADD COLUMN insurance_selected boolean NOT NULL DEFAULT false,
  ADD COLUMN insurance_premium_cup integer NOT NULL DEFAULT 0,
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN searching_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_dispatched_at timestamptz,
  ADD COLUMN driver_custom_rate_cup integer,
  ADD COLUMN driver_gps_unavailable_at timestamptz,
  ADD COLUMN wait_time_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN wait_time_charge_cup integer NOT NULL DEFAULT 0,
  ADD COLUMN final_fare_cup integer,
  ADD COLUMN corporate_account_id uuid,
  ADD COLUMN canceled_by uuid,
  ADD COLUMN pickup_address text NOT NULL DEFAULT 'Capitolio',
  ADD COLUMN dropoff_address text NOT NULL DEFAULT 'Hotel Nacional';

CREATE TABLE public.service_type_configs (
  slug text PRIMARY KEY, free_wait_minutes integer, per_wait_minute_rate_cup integer);
INSERT INTO public.service_type_configs VALUES ('triciclo_basico', 5, 94);

CREATE TABLE public.pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_type text NOT NULL, is_active boolean NOT NULL DEFAULT true,
  per_wait_minute_rate_cup integer, time_window_start time, time_window_end time, day_of_week integer[]);
-- prod's triciclo bands (the afternoon has no wait rate and falls back to the config's 94)
INSERT INTO public.pricing_rules (service_type, per_wait_minute_rate_cup, time_window_start, time_window_end) VALUES
  ('triciclo_basico', 314, '00:00', '06:00'), ('triciclo_basico', 79, '06:00', '12:00'),
  ('triciclo_basico', NULL, '12:00', '18:00'), ('triciclo_basico', 94, '18:00', '00:00');

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
INSERT INTO public.platform_config VALUES ('max_billable_wait_minutes', '20');

CREATE TABLE public.ride_pricing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ride_id uuid NOT NULL REFERENCES public.rides(id),
  snapshot_type text NOT NULL, total integer NOT NULL);

CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ride_id uuid NOT NULL REFERENCES public.rides(id),
  driver_profile_id uuid NOT NULL REFERENCES public.driver_profiles(id), status text NOT NULL DEFAULT 'pending',
  offered_at timestamptz DEFAULT now(), expires_at timestamptz, responded_at timestamptz);

CREATE TABLE public.stuck_ride_alerts (
  ride_id uuid PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('complete_blocked', 'stationary_chat', 'dead_driver_app')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb, detected_at timestamptz NOT NULL DEFAULT now(),
  emailed_at timestamptz, resolved_at timestamptz);

CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid REFERENCES public.users(id), action text NOT NULL,
  target_type text, target_id text, old_values jsonb, new_values jsonb, reason text, created_at timestamptz DEFAULT now());

CREATE TABLE public.rpc_attempt_log (
  id bigserial PRIMARY KEY, rpc_name text, caller_uid uuid, target_id uuid, outcome text, metadata jsonb,
  created_at timestamptz DEFAULT now());

CREATE TABLE public.ride_assist (
  ride_id uuid PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE, help_requested_at timestamptz,
  help_alert_sent_at timestamptz, wait_alert_sent_at timestamptz, help_email_sent_at timestamptz,
  wait_email_sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid REFERENCES public.driver_profiles(id),
  is_active boolean NOT NULL DEFAULT true, make text, model text, color text, plate_number text);

CREATE TABLE public.valid_transitions (
  from_status public.ride_status NOT NULL, to_status public.ride_status NOT NULL,
  allowed_roles public.user_role[] NOT NULL, PRIMARY KEY (from_status, to_status));
-- prod's 19 rows (2026-10-12)
INSERT INTO public.valid_transitions VALUES
  ('accepted','canceled','{customer,driver,admin,super_admin}'), ('accepted','driver_en_route','{driver,admin,super_admin}'),
  ('accepted','searching','{admin,super_admin}'), ('arrived_at_destination','canceled','{admin,super_admin}'),
  ('arrived_at_destination','completed','{driver,admin,super_admin}'), ('arrived_at_destination','disputed','{customer,driver,admin,super_admin}'),
  ('arrived_at_pickup','canceled','{customer,driver,admin,super_admin}'), ('arrived_at_pickup','in_progress','{driver,admin,super_admin}'),
  ('completed','disputed','{customer,driver,admin,super_admin}'), ('disputed','completed','{admin,super_admin}'),
  ('driver_en_route','arrived_at_pickup','{driver,admin,super_admin}'), ('driver_en_route','canceled','{customer,driver,admin,super_admin}'),
  ('driver_en_route','searching','{admin,super_admin}'), ('in_progress','arrived_at_destination','{driver,admin,super_admin}'),
  ('in_progress','canceled','{admin,driver,customer,super_admin}'), ('in_progress','completed','{driver,admin,super_admin}'),
  ('in_progress','disputed','{customer,driver,admin,super_admin}'), ('searching','accepted','{driver,admin,super_admin}'),
  ('searching','canceled','{customer,admin,super_admin}');

CREATE TABLE public.ride_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ride_id uuid, from_status public.ride_status,
  to_status public.ride_status, actor_id uuid, actor_role public.user_role, reason text, metadata jsonb,
  created_at timestamptz DEFAULT now());

GRANT SELECT ON public.ride_pricing_snapshots, public.stuck_ride_alerts, public.vehicles TO authenticated;
GRANT SELECT, UPDATE ON public.rides TO authenticated;

-- Stubs ---------------------------------------------------------------------
-- Every push that goes through cron_http_post lands in net.calls with its job label first.
CREATE OR REPLACE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
 RETURNS bigint LANGUAGE sql AS $f$ INSERT INTO net.calls (url, body) VALUES (p_jobname || ' ' || url, body) RETURNING id $f$;
REVOKE ALL ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, integer) FROM PUBLIC;

CREATE TABLE public.dispatch_calls (ride_id uuid, at timestamptz DEFAULT clock_timestamp());
CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog
AS $f$ INSERT INTO public.dispatch_calls (ride_id) VALUES (p_ride_id) RETURNING jsonb_build_object('ok', true) $f$;
REVOKE ALL ON FUNCTION public.dispatch_ride(uuid, integer) FROM PUBLIC;

-- complete_ride_and_pay: prod's guards copied, the money part reduced to the fare it charges.
CREATE TABLE public.complete_calls (ride_id uuid, driver_id uuid, distance_m integer, duration_s integer, caller uuid);
CREATE OR REPLACE FUNCTION public.complete_ride_and_pay(p_ride_id uuid, p_driver_id uuid,
  p_actual_distance_m integer, p_actual_duration_s integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $f$
DECLARE v_ride public.rides%ROWTYPE; v_total integer; v_wait integer; v_driver_user_id uuid;
BEGIN
  PERFORM set_config('app.trusted_driver_update', '1', true);
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF v_ride IS NULL THEN RAISE EXCEPTION 'Ride not found: %', p_ride_id; END IF;
  IF v_ride.status NOT IN ('in_progress', 'arrived_at_destination') THEN
    RAISE EXCEPTION 'Ride % cannot be completed (current: %)', p_ride_id, v_ride.status;
  END IF;
  IF v_ride.driver_id != p_driver_id THEN
    RAISE EXCEPTION 'Driver % is not assigned to ride %', p_driver_id, p_ride_id;
  END IF;
  SELECT user_id INTO v_driver_user_id FROM public.driver_profiles WHERE id = p_driver_id;
  IF NOT public.is_admin() AND auth.uid() <> v_driver_user_id THEN
    RAISE EXCEPTION 'Forbidden: only the assigned driver can complete this ride';
  END IF;
  INSERT INTO public.complete_calls VALUES (p_ride_id, p_driver_id, p_actual_distance_m, p_actual_duration_s, auth.uid());
  PERFORM public.calculate_wait_charge(p_ride_id);
  SELECT wait_time_charge_cup INTO v_wait FROM public.rides WHERE id = p_ride_id;
  SELECT total INTO v_total FROM public.ride_pricing_snapshots WHERE ride_id = p_ride_id AND snapshot_type = 'estimate' LIMIT 1;
  UPDATE public.rides SET status = 'completed',
         final_fare_cup = GREATEST(v_total - COALESCE(v_ride.discount_amount_cup, 0), 0) + COALESCE(v_wait, 0)
   WHERE id = p_ride_id;
  RETURN jsonb_build_object('success', true, 'final_fare_cup', (SELECT final_fare_cup FROM public.rides WHERE id = p_ride_id));
END $f$;
REVOKE ALL ON FUNCTION public.complete_ride_and_pay(uuid, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_ride_and_pay(uuid, uuid, integer, integer) TO authenticated, service_role;

RESET ROLE;
```

- [ ] **Step 2: Append the live bodies and their triggers**

Add to the end of `scaffold-extra.sql`:

```sql
SET ROLE tricigo_owner;
\ir live-bodies-load.sql
CREATE TRIGGER trg_enforce_ride_transition BEFORE UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION public.enforce_ride_transition();
CREATE TRIGGER trg_push_ride_status AFTER UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION public.notify_ride_status_change();
REVOKE ALL ON FUNCTION public.calculate_wait_charge(uuid), public.get_platform_config_numeric(text, numeric),
  public.log_rpc_attempt(text, uuid, uuid, text, jsonb), public._ride_short_code(uuid) FROM PUBLIC;
RESET ROLE;
```

Create `supabase/tests/00660/live-bodies-load.sql`. It is `live-bodies.sql` without the `tg_ride_location_events_guard` block, generated so that it never drifts:

```bash
python3 - <<'PY'
src = open('supabase/tests/00660/live-bodies.sql', encoding='utf-8').read()
parts = src.split('\n-- live ')
keep = [parts[0]] + ['-- live ' + p for p in parts[1:] if not p.startswith('tg_ride_location_events_guard:')]
open('supabase/tests/00660/live-bodies-load.sql', 'w', encoding='utf-8', newline='\n').write('\n'.join(keep))
print(len(keep) - 1)
PY
```
Expected: `6`.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/00660/scaffold-extra.sql supabase/tests/00660/live-bodies-load.sql
git commit -q -m "test(00660): scaffold for the stuck-ride rehearsal" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 4: Rehearsal runner and tests (RED)

**Files:**
- Create: `supabase/tests/00660/run.sh`

- [ ] **Step 1: Write `run.sh`**

```bash
#!/usr/bin/env bash
# Rehearsal runner for migration 00660 (local Postgres 16 + PostGIS).
#   supabase/tests/00660/run.sh none                                         -> RED
#   supabase/tests/00660/run.sh supabase/migrations/00660_stuck_ride_support.sql -> GREEN (+ x2, CRLF, negatives)
# Base: the 00659 scaffold + the 00659 migration (prod today), then scaffold-extra.sql.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr660
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

RIDER=a0000000-0000-4000-8000-000000000001
DIEGO=d0000000-0000-4000-8000-000000000001
ANA=d0000000-0000-4000-8000-000000000002
ADMIN=e0000000-0000-4000-8000-000000000001
MKT=e0000000-0000-4000-8000-000000000002
DP_DIEGO=dd000000-0000-4000-8000-000000000001
DP_ANA=dd000000-0000-4000-8000-000000000002
R_ACC=22222222-0000-4000-8000-000000000001     # accepted
R_ENR=22222222-0000-4000-8000-000000000002     # driver_en_route
R_PICK=22222222-0000-4000-8000-000000000003    # arrived_at_pickup, arrived 15 min ago (06:xx Havana is not assumed)
R_IP=22222222-0000-4000-8000-000000000004      # in_progress, waited 10 min, discount 500
R_DEST=22222222-0000-4000-8000-000000000005    # arrived_at_destination
R_NOSNAP=22222222-0000-4000-8000-000000000006  # in_progress without an estimate snapshot
R_SCHED=22222222-0000-4000-8000-000000000007   # accepted, scheduled 2 h ahead
R_GRID=22222222-0000-4000-8000-000000000008    # completed; used for the wait-charge grid
PT_A="ST_SetSRID(ST_MakePoint(-82.3666,23.1357),4326)::geography"   # pickup (Capitolio)
PT_B="ST_SetSRID(ST_MakePoint(-82.3816,23.1418),4326)::geography"   # dropoff (Hotel Nacional)
PT_NEAR="ST_SetSRID(ST_MakePoint(-82.3670,23.1358),4326)::geography" # ~40 m from pickup
PT_FAR="ST_SetSRID(ST_MakePoint(-82.3690,23.1360),4326)::geography"  # ~250 m from pickup

as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
PT(){ echo "INSERT INTO public.ride_location_events (ride_id, driver_id, location, recorded_at) VALUES ('$1', '$2', $3, $4);"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
  $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/00659/scaffold.sql" >/dev/null 2>&1 || return 1
  $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$ROOT/supabase/migrations/00659_ride_trail_guards.sql" >/dev/null 2>&1 || return 1
  (cd "$DIR" && $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f scaffold-extra.sql >/dev/null 2>&1) || return 1
  $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name, phone) VALUES
    ('$RIDER','customer','Rider','+5355550001'), ('$DIEGO','driver','Diego','+5355550002'),
    ('$ANA','driver','Ana','+5355550003'), ('$ADMIN','admin','Sofi','+5355550004'), ('$MKT','marketing','Mara',NULL);
  INSERT INTO public.driver_profiles (id, user_id, is_online, last_heartbeat_at) VALUES
    ('$DP_DIEGO','$DIEGO', true, now() - interval '20 minutes'), ('$DP_ANA','$ANA', true, now());
  INSERT INTO public.vehicles (driver_id, make, model, color, plate_number) VALUES ('$DP_DIEGO','Triciclo','',NULL,'T123');
  INSERT INTO public.rides (id, customer_id, driver_id, status, pickup_location, dropoff_location,
                            accepted_at, driver_arrived_at, pickup_at, discount_amount_cup, scheduled_at) VALUES
    ('$R_ACC','$RIDER','$DP_DIEGO','accepted',$PT_A,$PT_B, now()-interval '10 minutes', NULL, NULL, 0, NULL),
    ('$R_ENR','$RIDER','$DP_DIEGO','driver_en_route',$PT_A,$PT_B, now()-interval '10 minutes', NULL, NULL, 0, NULL),
    ('$R_PICK','$RIDER','$DP_DIEGO','arrived_at_pickup',$PT_A,$PT_B, now()-interval '30 minutes', now()-interval '15 minutes', NULL, 0, NULL),
    ('$R_IP','$RIDER','$DP_DIEGO','in_progress',$PT_A,$PT_B, now()-interval '40 minutes', now()-interval '30 minutes', now()-interval '20 minutes', 500, NULL),
    ('$R_DEST','$RIDER','$DP_DIEGO','arrived_at_destination',$PT_A,$PT_B, now()-interval '40 minutes', now()-interval '30 minutes', now()-interval '29 minutes', 0, NULL),
    ('$R_NOSNAP','$RIDER','$DP_ANA','in_progress',$PT_A,$PT_B, now()-interval '40 minutes', NULL, now()-interval '20 minutes', 0, NULL),
    ('$R_SCHED','$RIDER','$DP_ANA','accepted',$PT_A,$PT_B, now(), NULL, NULL, 0, now()+interval '2 hours'),
    ('$R_GRID','$RIDER','$DP_ANA','completed',$PT_A,$PT_B, NULL, NULL, NULL, 0, NULL);
  INSERT INTO public.ride_pricing_snapshots (ride_id, snapshot_type, total)
    SELECT id, 'estimate', 3000 FROM public.rides WHERE id <> '$R_NOSNAP';
  INSERT INTO public.ride_offers (ride_id, driver_profile_id, status) VALUES
    ('$R_ACC','$DP_DIEGO','accepted'), ('$R_ENR','$DP_DIEGO','accepted');
  INSERT INTO public.stuck_ride_alerts (ride_id, reason) VALUES ('$R_IP','dead_driver_app');" >/dev/null 2>&1 || return 1; }

# The old calculate_wait_charge's answers on a grid, kept to compare the new code against.
grid(){ run "$1" "
  CREATE TABLE public.wait_grid (arrived timestamptz, waited integer, wait_minutes integer, billable integer, charge integer);
  DO \$g\$ DECLARE h integer; w integer; r record; BEGIN
    FOR h IN 0..23 LOOP FOREACH w IN ARRAY ARRAY[0,4,5,6,12,25,40] LOOP
      UPDATE public.rides SET driver_arrived_at = (date '2026-10-12' + make_interval(hours => h)) AT TIME ZONE 'America/Havana',
                              pickup_at = (date '2026-10-12' + make_interval(hours => h, mins => w)) AT TIME ZONE 'America/Havana'
       WHERE id = '$R_GRID';
      SELECT * INTO r FROM public.calculate_wait_charge('$R_GRID') AS (wait_minutes integer, billable_minutes integer, charge integer);
      INSERT INTO public.wait_grid SELECT driver_arrived_at, w, r.wait_minutes, r.billable_minutes, r.charge FROM public.rides WHERE id = '$R_GRID';
    END LOOP; END LOOP;
    UPDATE public.rides SET driver_arrived_at = NULL, pickup_at = NULL WHERE id = '$R_GRID';
  END \$g\$; SELECT count(*) FROM public.wait_grid;"; }

fresh $DB || { echo "scaffold failed"; exit 1; }
[ "$(grid $DB)" = "168" ] || { echo "grid failed"; exit 1; }

apply(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1 | tr -d '\r' | grep -v '^$'; return ${PIPESTATUS[0]}; }
if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner) =="
  apply $DB "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency) =="
  apply $DB "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

RPC(){ echo "SELECT public.$1;"; }
PUSHES="RESET ROLE; SELECT count(*) FROM net.calls WHERE url LIKE 'support-ride-resolved%';"
STATUS_PUSHES="RESET ROLE; SELECT count(*) FROM net.calls WHERE url NOT LIKE 'support-ride-resolved%';"

echo "== the wait charge keeps its rules =="
val "W1 _wait_charge_for equals the old calculate_wait_charge on 168 waits (24 hours x 7 lengths)" \
  "SELECT count(*) FROM public.wait_grid g, public._wait_charge_for('triciclo_basico', g.arrived, g.arrived + make_interval(mins => g.waited)) n
   WHERE (n.wait_minutes, n.billable_minutes, n.charge) IS DISTINCT FROM (g.wait_minutes, g.billable, g.charge);" "0"
val "W2 the new calculate_wait_charge gives the same 168 answers and writes the same columns" \
  "BEGIN; DO \$g\$ DECLARE g record; r record; BEGIN
     FOR g IN SELECT * FROM public.wait_grid LOOP
       UPDATE public.rides SET driver_arrived_at = g.arrived, pickup_at = g.arrived + make_interval(mins => g.waited) WHERE id = '$R_GRID';
       SELECT * INTO r FROM public.calculate_wait_charge('$R_GRID') AS (wait_minutes integer, billable_minutes integer, charge integer);
       IF (r.wait_minutes, r.billable_minutes, r.charge) IS DISTINCT FROM (g.wait_minutes, g.billable, g.charge)
          OR (SELECT (wait_time_minutes, wait_time_charge_cup) FROM public.rides WHERE id = '$R_GRID') IS DISTINCT FROM (g.wait_minutes, g.charge) THEN
         RAISE EXCEPTION 'differs at % +%', g.arrived, g.waited; END IF;
     END LOOP; END \$g\$; SELECT 'same'; ROLLBACK;" "same"
val "W3 no times, no charge" "SELECT (n).* FROM (SELECT public._wait_charge_for('triciclo_basico', NULL, now()) n) s;" "0|0|0"

echo "== GPS departure =="
val "D1 the first point beyond 100 m after arrival" \
  "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_NEAR" "now() - interval '14 minutes'") $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '9 minutes'") $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '8 minutes'")
   SELECT round(extract(epoch FROM now() - public._ride_gps_departure_at('$R_PICK', now() - interval '15 minutes')) / 60); ROLLBACK;" "9"
val "D2 a far point from before the arrival is ignored" \
  "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '20 minutes'")
   SELECT public._ride_gps_departure_at('$R_PICK', now() - interval '15 minutes') IS NULL; ROLLBACK;" "t"
val "D3 never later than the server received it (a phone time in the future is capped)" \
  "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() + interval '30 minutes'")
   SELECT public._ride_gps_departure_at('$R_PICK', now() - interval '15 minutes') = now(); ROLLBACK;" "t"
val "D4 no point: NULL" "SELECT public._ride_gps_departure_at('$R_PICK', now() - interval '15 minutes') IS NULL;" "t"
val "D5 no arrival time: NULL" "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '9 minutes'") SELECT public._ride_gps_departure_at('$R_PICK', NULL) IS NULL; ROLLBACK;" "t"

echo "== who may act =="
for fn in "admin_active_ride_context('$R_IP')" "admin_release_active_ride('$R_ACC','accepted','no responde')" \
          "admin_advance_active_ride('$R_PICK','arrived_at_pickup','sin gps')" "admin_complete_active_ride('$R_IP','in_progress',3065,'app caida')"; do
  val "G1 marketing is refused: ${fn%%(*}" "$(as $MKT "SELECT (public.$fn)->>'error';")" "forbidden"
  val "G2 a rider is refused: ${fn%%(*}" "$(as $RIDER "SELECT (public.$fn)->>'error';")" "forbidden"
done
err "G3 anon cannot call them" "BEGIN; SET LOCAL ROLE anon; SELECT public.admin_active_ride_context('$R_IP'); ROLLBACK;" "permission denied"
val "G4 the four helpers exist and are not executable by clients" \
  "SELECT count(*) || '|' || count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')
                                          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('_wait_charge_for','_ride_gps_departure_at','_active_ride_charge_preview','_support_ride_push');" "4|0"

echo "== context =="
val "C1 allowed actions per status" \
  "$(as $ADMIN "SELECT string_agg(s || ':' || (public.admin_active_ride_context(id)->'allowed_actions')::text, ' ' ORDER BY s)
     FROM (VALUES ('$R_ACC'::uuid,'a'),('$R_ENR','b'),('$R_PICK','c'),('$R_IP','d'),('$R_DEST','e')) v(id, s);")" \
  'a:["release", "advance"] b:["release", "advance"] c:["advance"] d:["advance", "complete"] e:["complete"]'
val "C2 in_progress preview: agreed 3000, discount 500, waited 10 -> 5 billable" \
  "$(as $ADMIN "SELECT (p->>'agreed_cup') || '|' || (p->>'discount_cup') || '|' || (p->>'billable_minutes') || '|' ||
     ((p->>'total_cup')::int = 2500 + (p->>'wait_cup')::int)::text
     FROM (SELECT public.admin_active_ride_context('$R_IP')->'preview' p) s;")" "3000|500|5|true"
val "C3 arrived_at_pickup: start time from the GPS departure" \
  "$(as $ADMIN "RESET ROLE; $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '9 minutes'") SET LOCAL ROLE authenticated;
     SELECT (c->>'start_pickup_source') || '|' || round(extract(epoch FROM now() - (c->>'start_pickup_at')::timestamptz) / 60)
     FROM (SELECT public.admin_active_ride_context('$R_PICK') c) s;")" "gps|9"
val "C4 driver, vehicle label without blank fields, alert" \
  "$(as $ADMIN "SELECT (c->'driver'->>'full_name') || '|' || (c->'driver'->>'vehicle_label') || '|' || (c->'alert'->>'reason')
     FROM (SELECT public.admin_active_ride_context('$R_IP') c) s;")" "Diego|Triciclo · T123|dead_driver_app"
val "C5 no snapshot, no preview" "$(as $ADMIN "SELECT public.admin_active_ride_context('$R_NOSNAP')->'preview' = 'null'::jsonb;")" "t"

echo "== release =="
val "R1 releases an accepted ride like the automatic release, plus the GPS reset" \
  "$(as $ADMIN "RESET ROLE; UPDATE public.rides SET gps_override_confirmed_at = now(), driver_gps_status = 'rider_consented' WHERE id = '$R_ACC';
     SET LOCAL ROLE authenticated; SELECT public.admin_release_active_ride('$R_ACC', 'accepted', 'no responde')->>'success';
     RESET ROLE; SELECT status || '|' || (driver_id IS NULL) || '|' || (accepted_at IS NULL) || '|' || (last_dispatched_at IS NULL) || '|' ||
       driver_gps_status || '|' || (gps_override_confirmed_at IS NULL) FROM public.rides WHERE id = '$R_ACC';")" \
  "true;searching|true|true|true|healthy|true"
val "R2 the driver goes offline, the accepted offer stays accepted, dispatch is called" \
  "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ENR', 'driver_en_route', 'no responde')->>'success';
     RESET ROLE; SELECT (SELECT is_online FROM public.driver_profiles WHERE id = '$DP_DIEGO') || '|' ||
       (SELECT status FROM public.ride_offers WHERE ride_id = '$R_ENR') || '|' || (SELECT count(*) FROM public.dispatch_calls WHERE ride_id = '$R_ENR');")" \
  "true;false|accepted|1"
val "R3 two pushes (rider + driver), an audit row with the reason, the wait alert stamped" \
  "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ACC', 'accepted', 'no responde')->>'success'; $PUSHES
     SELECT (SELECT reason FROM public.admin_actions WHERE action = 'support_release_ride') || '|' ||
       (SELECT wait_alert_sent_at IS NOT NULL FROM public.ride_assist WHERE ride_id = '$R_ACC');")" \
  "true;2;no responde|true"
val "R4 refused when the status changed" "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ACC', 'driver_en_route', 'x y z')->>'error';")" "ride_changed"
val "R5 refused after pickup" "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_PICK', 'arrived_at_pickup', 'x y z')->>'error';")" "ride_not_releasable"
val "R6 refused for a ride scheduled later" "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_SCHED', 'accepted', 'x y z')->>'error';")" "scheduled_not_due"
val "R7 refused without a reason" "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '  ')->>'error';")" "reason_required"
val "R8 a failing dispatch keeps the release and logs dispatch_failed" \
  "$(as $ADMIN "RESET ROLE; CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000) RETURNS jsonb
       LANGUAGE plpgsql AS \$f\$ BEGIN RAISE EXCEPTION 'boom'; END \$f\$; SET LOCAL ROLE authenticated;
     SELECT public.admin_release_active_ride('$R_ACC', 'accepted', 'no responde')->>'success';
     RESET ROLE; SELECT (SELECT status FROM public.rides WHERE id = '$R_ACC') || '|' || (SELECT outcome FROM public.rpc_attempt_log WHERE rpc_name = 'admin_release_active_ride');")" \
  "true;searching|dispatch_failed"

echo "== advance =="
val "A1 accepted -> arrived_at_pickup in one transition, one status push, arrival = now" \
  "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_ACC', 'accepted', 'sin gps')->>'status';
     RESET ROLE; SELECT (SELECT count(*) FROM public.ride_transitions WHERE ride_id = '$R_ACC') || '|' ||
       (SELECT count(*) FROM net.calls WHERE body->>'title' = 'Conductor llegó') || '|' ||
       (SELECT driver_arrived_at = now() FROM public.rides WHERE id = '$R_ACC');")" "arrived_at_pickup;1|1|true"
val "A2 arrived_at_pickup -> in_progress with pickup at the GPS departure" \
  "$(as $ADMIN "RESET ROLE; $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '9 minutes'") SET LOCAL ROLE authenticated;
     SELECT public.admin_advance_active_ride('$R_PICK', 'arrived_at_pickup', 'sin gps')->>'status';
     RESET ROLE; SELECT round(extract(epoch FROM now() - pickup_at) / 60) FROM public.rides WHERE id = '$R_PICK';")" "in_progress;9"
val "A3 no departure point: pickup = arrival, so no wait" \
  "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_PICK', 'arrived_at_pickup', 'sin gps')->>'success';
     RESET ROLE; SELECT pickup_at = driver_arrived_at FROM public.rides WHERE id = '$R_PICK';")" \
  "true;true"
val "A4 in_progress -> arrived_at_destination, the driver gets the support push" \
  "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_IP', 'in_progress', 'sin gps')->>'status'; $PUSHES")" "arrived_at_destination;1"
val "A5 refused at the destination" "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_DEST', 'arrived_at_destination', 'x y z')->>'error';")" "ride_not_advanceable"
val "A6 refused when the status changed" "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_PICK', 'accepted', 'x y z')->>'error';")" "ride_changed"
val "A7 the new transition is admin-only" \
  "SELECT allowed_roles::text FROM public.valid_transitions WHERE from_status = 'accepted' AND to_status = 'arrived_at_pickup';" "{admin,super_admin}"

echo "== complete =="
val "C6 charges agreed - discount + recorded wait, through complete_ride_and_pay" \
  "$(as $ADMIN "SELECT set_config('t.total', public.admin_active_ride_context('$R_IP')->'preview'->>'total_cup', true) IS NOT NULL;
     SELECT (public.admin_complete_active_ride('$R_IP', 'in_progress', current_setting('t.total')::int, 'app caida'))->>'success';
     RESET ROLE; SELECT (SELECT status FROM public.rides WHERE id = '$R_IP') || '|' ||
       (SELECT final_fare_cup = current_setting('t.total')::int FROM public.rides WHERE id = '$R_IP') || '|' || (SELECT distance_m FROM public.complete_calls) || '|' ||
       (SELECT resolved_at IS NOT NULL FROM public.stuck_ride_alerts WHERE ride_id = '$R_IP') || '|' ||
       (SELECT count(*) FROM public.admin_actions WHERE action = 'support_complete_ride');")" \
  "t;true;completed|true|4000|true|1"
val "C7 refused when the amount changed" "$(as $ADMIN "SELECT public.admin_complete_active_ride('$R_IP', 'in_progress', 1, 'app caida')->>'error';")" "amount_changed"
val "C8 refused without an agreed price" "$(as $ADMIN "SELECT public.admin_complete_active_ride('$R_NOSNAP', 'in_progress', 3000, 'app caida')->>'error';")" "no_agreed_price"
val "C9 refused before pickup" "$(as $ADMIN "SELECT public.admin_complete_active_ride('$R_PICK', 'arrived_at_pickup', 3000, 'x y z')->>'error';")" "ride_not_completable"
val "C10 refused when the status changed" "$(as $ADMIN "SELECT public.admin_complete_active_ride('$R_DEST', 'in_progress', 3000, 'x y z')->>'error';")" "ride_changed"
val "C11 completion sends no support push (the status trigger already pushes both)" \
  "$(as $ADMIN "SELECT public.admin_complete_active_ride('$R_DEST', 'arrived_at_destination',
       (public.admin_active_ride_context('$R_DEST')->'preview'->>'total_cup')::int, 'app caida')->>'success'; $PUSHES $STATUS_PUSHES")" "true;0;2"

echo "== pushes =="
val "P1 a push without a service key keeps the action and logs push_failed" \
  "$(as $ADMIN "RESET ROLE; CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS \$f\$ SELECT NULL::text \$f\$; SET LOCAL ROLE authenticated;
     SELECT public.admin_advance_active_ride('$R_IP', 'in_progress', 'sin gps')->>'status';
     RESET ROLE; SELECT outcome FROM public.rpc_attempt_log WHERE rpc_name = 'admin_advance_active_ride';")" "arrived_at_destination;push_failed"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Start the local cluster and run it without the migration**

Follow CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod": user `pgtest`, port 5433, PostGIS installed (`apt-get install -y postgresql-16-postgis-3` if missing).

Run: `bash supabase/tests/00660/run.sh none`
Expected: the scaffold and grid load (no "scaffold failed"/"grid failed"), and every test FAILs except W2: the functions do not exist yet. W2 checks that the live `calculate_wait_charge` still gives the grid's answers, so it passes before and after the migration. The last line reads `passed 1, failed 44`.

- [ ] **Step 3: Commit**

```bash
chmod +x supabase/tests/00660/run.sh
git add supabase/tests/00660/run.sh
git commit -q -m "test(00660): stuck-ride support rehearsal (RED)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 5: Migration — transition, wait helper, `calculate_wait_charge`

**Files:**
- Create: `supabase/migrations/00660_stuck_ride_support.sql`

- [ ] **Step 1: Write the header and the first three parts**

```sql
-- 00660: support helps a ride that already has a driver (design:
-- docs/superpowers/specs/2026-10-12-stuck-ride-support-design.md).
--
-- Today the panel can only cancel an accepted ride. Measured on 2026-10-12: the
-- automatic release returns a ride to search after 12 minutes of driver silence
-- but only before pickup; after pickup it only raises a stuck_ride_alerts row;
-- a driver without GPS cannot mark arrival (gps_required). Support had no tool.
--
-- What this adds (all for admin and super_admin; marketing is refused):
--   admin_active_ride_context   what the assist page shows for an active ride
--   admin_release_active_ride   back to search now (accepted, driver_en_route)
--   admin_advance_active_ride   one step: arrived / started / at destination
--   admin_complete_active_ride  complete and charge (agreed price + recorded wait)
-- Each one locks the ride, refuses when the status is not the one support saw
-- (ride_changed), needs a reason, logs to admin_actions and pushes through
-- cron_http_post ('support-ride-resolved').
--
-- calculate_wait_charge now calls _wait_charge_for, a pure function with the
-- same rules, so the panel can preview the charge the completion will make.
-- It is replaced only when the live body is the one this migration was written
-- for (md5 2c0679d1...). The rehearsal checks the two bodies give the same
-- answers on 168 waits, and the prod check on every ride with both times.

SET lock_timeout = '5s';

-- 1. Support marks arrival from 'accepted' in one step: one status push and one
--    SMS for the rider instead of two. Drivers keep the step-by-step path.
INSERT INTO public.valid_transitions (from_status, to_status, allowed_roles)
VALUES ('accepted', 'arrived_at_pickup', ARRAY['admin', 'super_admin']::public.user_role[])
ON CONFLICT (from_status, to_status) DO NOTHING;

-- 2. The wait charge as a pure function: calculate_wait_charge's rules, no writes.
CREATE OR REPLACE FUNCTION public._wait_charge_for(
  p_service_type text, p_arrived_at timestamptz, p_pickup_at timestamptz,
  OUT wait_minutes integer, OUT billable_minutes integer, OUT charge integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_svc public.service_type_configs%ROWTYPE;
  v_wait_seconds numeric;
  v_max_billable integer;
  v_band_rate integer;
  v_at_t time;
  v_at_dow int;
BEGIN
  IF p_arrived_at IS NULL OR p_pickup_at IS NULL THEN
    wait_minutes := 0; billable_minutes := 0; charge := 0;
    RETURN;
  END IF;
  SELECT * INTO v_svc FROM public.service_type_configs WHERE slug = p_service_type;
  v_wait_seconds := EXTRACT(EPOCH FROM (p_pickup_at - p_arrived_at));
  wait_minutes := GREATEST(0, FLOOR(v_wait_seconds / 60)::integer);
  billable_minutes := GREATEST(0, wait_minutes - COALESCE(v_svc.free_wait_minutes, 5));
  v_max_billable := GREATEST(0, public.get_platform_config_numeric('max_billable_wait_minutes', 20)::integer);
  billable_minutes := LEAST(billable_minutes, v_max_billable);

  -- 00502: the rate of the band the wait STARTED in (Havana time).
  BEGIN
    v_at_t   := (p_arrived_at AT TIME ZONE 'America/Havana')::time;
    v_at_dow := EXTRACT(dow FROM (p_arrived_at AT TIME ZONE 'America/Havana'))::int;
    SELECT pr.per_wait_minute_rate_cup INTO v_band_rate
    FROM public.pricing_rules pr
    WHERE pr.service_type = p_service_type
      AND pr.is_active = true
      AND pr.per_wait_minute_rate_cup IS NOT NULL
      AND (pr.time_window_start IS NULL OR pr.time_window_end IS NULL OR
           CASE WHEN pr.time_window_start <= pr.time_window_end
                THEN v_at_t >= pr.time_window_start AND v_at_t < pr.time_window_end
                ELSE v_at_t >= pr.time_window_start OR v_at_t < pr.time_window_end END)
      AND (pr.day_of_week IS NULL OR array_length(pr.day_of_week, 1) IS NULL
           OR v_at_dow = ANY(pr.day_of_week))
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_band_rate := NULL;
  END;

  charge := billable_minutes * COALESCE(v_band_rate, v_svc.per_wait_minute_rate_cup, 0);
END;
$function$;
REVOKE ALL ON FUNCTION public._wait_charge_for(text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- 3. calculate_wait_charge keeps its signature, its writes and its answers.
DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.calculate_wait_charge(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '2c0679d1ce8600da188e4ff101ddd2ca' AND v_md5 IS DISTINCT FROM 'NEW_CWC_MD5' THEN
    RAISE EXCEPTION '00660: calculate_wait_charge is not the body this migration replaces (md5 %)', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.calculate_wait_charge(p_ride_id uuid)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride rides%ROWTYPE;
  v_w record;
  result RECORD;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  -- 00660: the rules live in _wait_charge_for, which the support preview also uses.
  SELECT * INTO v_w FROM _wait_charge_for(v_ride.service_type, v_ride.driver_arrived_at, v_ride.pickup_at);
  UPDATE rides SET wait_time_minutes = v_w.wait_minutes, wait_time_charge_cup = v_w.charge WHERE id = p_ride_id;
  SELECT v_w.wait_minutes AS wait_minutes, v_w.billable_minutes AS billable_minutes, v_w.charge AS charge INTO result;
  RETURN result;
END;
$function$;
```

`NEW_CWC_MD5` is filled in by Task 9, Step 2, with the md5 the new body gets.

- [ ] **Step 2: Run the wait tests**

Run: `bash supabase/tests/00660/run.sh supabase/migrations/00660_stuck_ride_support.sql 2>&1 | grep -E '^(PASS|FAIL)  W'`
Expected: W1, W2 and W3 PASS. The other tests still fail.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00660_stuck_ride_support.sql
git commit -q -m "feat(db): pure wait-charge helper behind calculate_wait_charge (00660)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 6: Migration — departure, preview, push helper, context RPC

**Files:**
- Modify: `supabase/migrations/00660_stuck_ride_support.sql` (append)

- [ ] **Step 1: Append parts 4–7**

```sql
-- 4. When the GPS trail shows the driver leaving the pickup: the first point more
--    than 100 m from it at or after p_since. Per point, the earlier of the phone's
--    time and the server's receipt: a later departure means more wait for the
--    rider, so it is never later than the server saw the point (00659 uses the
--    later one for arrival, for the same reason). Only the ride's driver's points.
CREATE OR REPLACE FUNCTION public._ride_gps_departure_at(p_ride_id uuid, p_since timestamptz)
 RETURNS timestamptz
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT CASE WHEN s.m IS NULL THEN NULL ELSE LEAST(s.m, now()) END
  FROM (
    SELECT min(LEAST(le.recorded_at, le.received_at)) AS m
    FROM public.ride_location_events le
    JOIN public.rides r ON r.id = le.ride_id
    WHERE le.ride_id = p_ride_id
      AND p_since IS NOT NULL
      AND le.driver_id = r.driver_id
      AND LEAST(le.recorded_at, le.received_at) >= p_since
      AND ST_Distance(le.location, r.pickup_location) > 100
  ) s;
$function$;
REVOKE ALL ON FUNCTION public._ride_gps_departure_at(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- 5. What completing the ride would charge, for a given pickup time. NULL when the
--    ride has no estimate snapshot (none in the last 90 days). Same formula as
--    complete_ride_and_pay's strict-parity path. A corporate ride whose commission
--    is below the default ends lower; is_corporate tells the panel.
CREATE OR REPLACE FUNCTION public._active_ride_charge_preview(p_ride public.rides, p_pickup_at timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_total integer;
  v_w record;
BEGIN
  SELECT s.total INTO v_total FROM public.ride_pricing_snapshots s
   WHERE s.ride_id = p_ride.id AND s.snapshot_type = 'estimate' LIMIT 1;
  IF v_total IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_w FROM public._wait_charge_for(p_ride.service_type, p_ride.driver_arrived_at, p_pickup_at);
  RETURN jsonb_build_object(
    'agreed_cup', v_total,
    'discount_cup', COALESCE(p_ride.discount_amount_cup, 0),
    'wait_minutes', v_w.wait_minutes,
    'billable_minutes', v_w.billable_minutes,
    'wait_cup', v_w.charge,
    'insurance_cup', CASE WHEN p_ride.insurance_selected AND p_ride.insurance_premium_cup > 0
                          THEN p_ride.insurance_premium_cup ELSE 0 END,
    'is_corporate', p_ride.corporate_account_id IS NOT NULL,
    'total_cup', GREATEST(v_total - COALESCE(p_ride.discount_amount_cup, 0), 0) + v_w.charge);
END;
$function$;
REVOKE ALL ON FUNCTION public._active_ride_charge_preview(public.rides, timestamptz) FROM PUBLIC, anon, authenticated;

-- 6. A support push. In a block of its own, like 00628's: a failing push never
--    takes back the action; it leaves a WARNING and an rpc_attempt_log row.
CREATE OR REPLACE FUNCTION public._support_ride_push(p_rpc text, p_ride_id uuid, p_user_id uuid,
  p_title text, p_body text, p_category text, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_key := public.get_service_role_key();
    IF v_key IS NULL OR v_key = '' THEN
      RAISE WARNING '%: no service role key, no push for ride %', p_rpc, p_ride_id;
      PERFORM public.log_rpc_attempt(p_rpc, auth.uid(), p_ride_id, 'push_failed',
        jsonb_build_object('user_id', p_user_id, 'error', 'no service role key'));
    ELSE
      PERFORM public.cron_http_post('support-ride-resolved',
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
        body    := jsonb_build_object('user_id', p_user_id::text, 'title', p_title, 'body', p_body,
                                      'category', p_category,
                                      'data', COALESCE(p_data, '{}'::jsonb) || jsonb_build_object('ride_id', p_ride_id::text)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%: the push for ride % failed: % %', p_rpc, p_ride_id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt(p_rpc, auth.uid(), p_ride_id, 'push_failed',
      jsonb_build_object('user_id', p_user_id, 'error', SQLERRM));
  END;
END;
$function$;
REVOKE ALL ON FUNCTION public._support_ride_push(text, uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- 7. Everything the active view shows, in one call.
CREATE OR REPLACE FUNCTION public.admin_active_ride_context(p_ride_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_ride public.rides%ROWTYPE;
  v_actions text[];
  v_dep timestamptz;
  v_start timestamptz;
  v_source text;
  v_preview jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;

  v_actions := CASE v_ride.status
    WHEN 'accepted' THEN ARRAY['release', 'advance']
    WHEN 'driver_en_route' THEN ARRAY['release', 'advance']
    WHEN 'arrived_at_pickup' THEN ARRAY['advance']
    WHEN 'in_progress' THEN ARRAY['advance', 'complete']
    WHEN 'arrived_at_destination' THEN ARRAY['complete']
    ELSE ARRAY[]::text[] END;

  IF v_ride.status = 'arrived_at_pickup' THEN
    v_dep := public._ride_gps_departure_at(v_ride.id, v_ride.driver_arrived_at);
    v_start := COALESCE(v_ride.pickup_at, v_dep, v_ride.driver_arrived_at, now());
    v_source := CASE WHEN v_ride.pickup_at IS NOT NULL THEN 'recorded'
                     WHEN v_dep IS NOT NULL THEN 'gps'
                     WHEN v_ride.driver_arrived_at IS NOT NULL THEN 'arrival'
                     ELSE 'now' END;
    v_preview := public._active_ride_charge_preview(v_ride, v_start);
  ELSIF v_ride.status IN ('in_progress', 'arrived_at_destination') THEN
    v_preview := public._active_ride_charge_preview(v_ride, v_ride.pickup_at);
  ELSE
    v_preview := public._active_ride_charge_preview(v_ride, NULL);
  END IF;

  RETURN jsonb_build_object(
    'ride', (SELECT jsonb_build_object(
        'id', v_ride.id, 'code', public._ride_short_code(v_ride.id), 'status', v_ride.status,
        'service_type', v_ride.service_type, 'payment_method', v_ride.payment_method,
        'is_corporate', v_ride.corporate_account_id IS NOT NULL,
        'pickup_address', v_ride.pickup_address, 'dropoff_address', v_ride.dropoff_address,
        'created_at', v_ride.created_at, 'accepted_at', v_ride.accepted_at,
        'driver_arrived_at', v_ride.driver_arrived_at, 'pickup_at', v_ride.pickup_at,
        'scheduled_at', v_ride.scheduled_at, 'estimated_fare_cup', v_ride.estimated_fare_cup,
        'customer_id', v_ride.customer_id, 'customer_name', c.full_name,
        'customer_phone', c.phone, 'customer_is_test', c.is_test)
      FROM public.users c WHERE c.id = v_ride.customer_id),
    'driver', (SELECT jsonb_build_object(
        'driver_profile_id', dp.id, 'full_name', u.full_name, 'phone', u.phone,
        'is_online', dp.is_online, 'last_heartbeat_at', dp.last_heartbeat_at,
        'vehicle_label', (SELECT concat_ws(' · ',
             NULLIF(concat_ws(' ', NULLIF(btrim(v.make), ''), NULLIF(btrim(v.model), '')), ''),
             NULLIF(btrim(v.color), ''), NULLIF(btrim(v.plate_number), ''))
           FROM public.vehicles v WHERE v.driver_id = dp.id AND v.is_active LIMIT 1))
      FROM public.driver_profiles dp JOIN public.users u ON u.id = dp.user_id
      WHERE dp.id = v_ride.driver_id),
    'last_point', (SELECT jsonb_build_object(
        'recorded_at', le.recorded_at, 'received_at', le.received_at,
        'distance_to_pickup_m', round(ST_Distance(le.location, v_ride.pickup_location))::int,
        'distance_to_dropoff_m', round(ST_Distance(le.location, v_ride.dropoff_location))::int)
      FROM public.ride_location_events le WHERE le.ride_id = v_ride.id
      ORDER BY le.recorded_at DESC, le.id DESC LIMIT 1),
    'alert', (SELECT jsonb_build_object('reason', a.reason, 'detected_at', a.detected_at)
      FROM public.stuck_ride_alerts a WHERE a.ride_id = v_ride.id AND a.resolved_at IS NULL),
    'preview', v_preview,
    'start_pickup_at', CASE WHEN v_ride.status = 'arrived_at_pickup' THEN v_start END,
    'start_pickup_source', v_source,
    'allowed_actions', to_jsonb(v_actions));
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_active_ride_context(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_active_ride_context(uuid) TO authenticated, service_role;
```

- [ ] **Step 2: Run the D, G and C tests**

Run: `bash supabase/tests/00660/run.sh supabase/migrations/00660_stuck_ride_support.sql 2>&1 | grep -E '^(PASS|FAIL)  (D|C[1-5] )'`
Expected: D1–D5 and C1–C5 PASS. The G tests about the RPCs that do not exist yet still fail.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00660_stuck_ride_support.sql
git commit -q -m "feat(db): GPS departure, charge preview and active-ride context for support (00660)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 7: Migration — release and advance

**Files:**
- Modify: `supabase/migrations/00660_stuck_ride_support.sql` (append)

- [ ] **Step 1: Append parts 8 and 9**

```sql
-- 8. Back to search, now (accepted, driver_en_route). What release_rides_from_dead_drivers
--    block A does, plus: the previous driver's GPS state is reset, so a rider
--    confirmation given to that driver does not let the next one skip the
--    arrival gate; the 00628 wait alert is stamped (support is already on it);
--    and dispatch runs at once.
CREATE OR REPLACE FUNCTION public.admin_release_active_ride(p_ride_id uuid, p_expected_status text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_driver_user uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status::text IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;
  IF v_ride.status NOT IN ('accepted', 'driver_en_route') THEN
    RETURN jsonb_build_object('error', 'ride_not_releasable', 'status', v_ride.status);
  END IF;
  IF v_ride.scheduled_at IS NOT NULL AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'status', v_ride.status);
  END IF;

  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;

  UPDATE public.driver_profiles
     SET is_online = false, auto_offline_at = COALESCE(auto_offline_at, now())
   WHERE id = v_ride.driver_id AND is_online;

  UPDATE public.rides SET
    status = 'searching', driver_id = NULL, accepted_at = NULL,
    searching_seen_at = now(), last_dispatched_at = NULL,
    driver_gps_status = 'healthy', driver_gps_unavailable_at = NULL,
    gps_override_requested_at = NULL, gps_override_confirmed_at = NULL,
    gps_check_distance_m = NULL, driver_custom_rate_cup = NULL,
    updated_at = now()
  WHERE id = p_ride_id;

  -- The driver's accepted offer stays 'accepted': dispatch never re-offers it,
  -- and the driver's acceptance_rate does not move.
  UPDATE public.ride_offers SET status = 'expired'
   WHERE ride_id = p_ride_id AND driver_profile_id = v_ride.driver_id AND status = 'pending';

  UPDATE public.stuck_ride_alerts SET resolved_at = now() WHERE ride_id = p_ride_id AND resolved_at IS NULL;

  INSERT INTO public.ride_assist AS ra (ride_id, wait_alert_sent_at, wait_email_sent_at)
  VALUES (p_ride_id, now(), now())
  ON CONFLICT (ride_id) DO UPDATE SET
    wait_alert_sent_at = COALESCE(ra.wait_alert_sent_at, now()),
    wait_email_sent_at = COALESCE(ra.wait_email_sent_at, now());

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_release_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status, 'driver_profile_id', v_ride.driver_id),
          jsonb_build_object('status', 'searching'), v_reason);

  PERFORM public._support_ride_push('admin_release_active_ride', p_ride_id, v_ride.customer_id,
    'Buscando otro conductor',
    'Tu conductor no pudo continuar. Estamos buscándote otro ahora mismo.',
    'ride', jsonb_build_object('reason', 'support_ride_released'));
  PERFORM public._support_ride_push('admin_release_active_ride', p_ride_id, v_driver_user,
    'Soporte te quitó el viaje',
    'Le pasamos el viaje a otro conductor. Te pusimos fuera de línea: conéctate cuando puedas tomar viajes.',
    'system', jsonb_build_object('event', 'support_ride_update', 'action', 'release'));

  BEGIN
    PERFORM public.dispatch_ride(p_ride_id);
  EXCEPTION WHEN OTHERS THEN
    -- The release stands; retry_dispatch_expired_rides picks it up next minute.
    RAISE WARNING 'admin_release_active_ride: dispatch of ride % failed: % %', p_ride_id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('admin_release_active_ride', v_admin, p_ride_id, 'dispatch_failed',
      jsonb_build_object('error', SQLERRM));
  END;

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'status', 'searching');
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_release_active_ride(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_release_active_ride(uuid, text, text) TO authenticated, service_role;

-- 9. One step forward, standing in for the driver's tap. No GPS gate: that is
--    what support is for. "Viaje iniciado" takes the pickup time from the GPS
--    departure; with none, pickup = arrival, so no wait is charged.
CREATE OR REPLACE FUNCTION public.admin_advance_active_ride(p_ride_id uuid, p_expected_status text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_new public.rides%ROWTYPE;
  v_to public.ride_status;
  v_label text;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status::text IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;

  IF v_ride.status IN ('accepted', 'driver_en_route') THEN
    v_to := 'arrived_at_pickup';
    v_label := 'llegaste a recoger';
    UPDATE public.rides
       SET status = v_to, driver_arrived_at = COALESCE(driver_arrived_at, now()), updated_at = now()
     WHERE id = p_ride_id;
  ELSIF v_ride.status = 'arrived_at_pickup' THEN
    v_to := 'in_progress';
    v_label := 'viaje iniciado';
    UPDATE public.rides
       SET status = v_to,
           pickup_at = COALESCE(v_ride.pickup_at,
                                public._ride_gps_departure_at(p_ride_id, v_ride.driver_arrived_at),
                                v_ride.driver_arrived_at, now()),
           updated_at = now()
     WHERE id = p_ride_id;
  ELSIF v_ride.status = 'in_progress' THEN
    v_to := 'arrived_at_destination';
    v_label := 'llegaste al destino';
    UPDATE public.rides SET status = v_to, updated_at = now() WHERE id = p_ride_id;
  ELSE
    RETURN jsonb_build_object('error', 'ride_not_advanceable', 'status', v_ride.status);
  END IF;

  SELECT * INTO v_new FROM public.rides WHERE id = p_ride_id;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_advance_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status, 'driver_arrived_at', v_ride.driver_arrived_at, 'pickup_at', v_ride.pickup_at),
          jsonb_build_object('status', v_to, 'driver_arrived_at', v_new.driver_arrived_at, 'pickup_at', v_new.pickup_at),
          v_reason);

  -- The rider already gets the status push from notify_ride_status_change.
  PERFORM public._support_ride_push('admin_advance_active_ride', p_ride_id,
    (SELECT dp.user_id FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id),
    'Soporte actualizó tu viaje', 'Lo marcamos como ' || v_label || '.',
    'system', jsonb_build_object('event', 'support_ride_update', 'action', 'advance', 'status', v_to));

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'status', v_to);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_advance_active_ride(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_advance_active_ride(uuid, text, text) TO authenticated, service_role;
```

- [ ] **Step 2: Run the R and A tests**

Run: `bash supabase/tests/00660/run.sh supabase/migrations/00660_stuck_ride_support.sql 2>&1 | grep -E '^(PASS|FAIL)  (R|A)'`
Expected: R1–R8 and A1–A7 PASS.

If R2's or A3's exact JSON differs only in key order, change the expected string to the order Postgres prints (`jsonb` sorts keys by length, then bytewise). Those tests check the content, not the order.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00660_stuck_ride_support.sql
git commit -q -m "feat(db): support releases or advances an active ride (00660)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 8: Migration — complete and charge

**Files:**
- Modify: `supabase/migrations/00660_stuck_ride_support.sql` (append)

- [ ] **Step 1: Append part 10**

```sql
-- 10. Complete and charge: the agreed price minus the discount plus the recorded
--     wait, through complete_ride_and_pay (it admits admin callers and moves the
--     money exactly as for any ride). The amount must be the one support saw.
CREATE OR REPLACE FUNCTION public.admin_complete_active_ride(p_ride_id uuid, p_expected_status text,
  p_expected_total_cup integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_preview jsonb;
  v_result jsonb;
  v_final integer;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status::text IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;
  IF v_ride.status NOT IN ('in_progress', 'arrived_at_destination') THEN
    RETURN jsonb_build_object('error', 'ride_not_completable', 'status', v_ride.status);
  END IF;
  v_preview := public._active_ride_charge_preview(v_ride, v_ride.pickup_at);
  IF v_preview IS NULL THEN
    RETURN jsonb_build_object('error', 'no_agreed_price');
  END IF;
  IF (v_preview->>'total_cup')::integer IS DISTINCT FROM p_expected_total_cup THEN
    RETURN jsonb_build_object('error', 'amount_changed', 'total_cup', (v_preview->>'total_cup')::integer);
  END IF;

  -- The distance does not change a ride with a snapshot: complete_ride_and_pay
  -- prefers the trail distance and only records it.
  v_result := public.complete_ride_and_pay(p_ride_id, v_ride.driver_id,
                                           v_ride.estimated_distance_m, v_ride.estimated_duration_s);
  SELECT final_fare_cup INTO v_final FROM public.rides WHERE id = p_ride_id;

  UPDATE public.stuck_ride_alerts SET resolved_at = now() WHERE ride_id = p_ride_id AND resolved_at IS NULL;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_complete_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status),
          jsonb_build_object('status', 'completed', 'final_fare_cup', v_final, 'preview', v_preview),
          v_reason);

  -- No support push: notify_ride_status_change already pushes both on 'completed'.
  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'final_fare_cup', v_final, 'payment', v_result);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_complete_active_ride(uuid, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_complete_active_ride(uuid, text, integer, text) TO authenticated, service_role;
```

- [ ] **Step 2: Run the whole rehearsal**

Run: `bash supabase/tests/00660/run.sh supabase/migrations/00660_stuck_ride_support.sql`
Expected: every test PASSes except those that depend on Task 9 (none should). Last line: `passed N, failed 0`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00660_stuck_ride_support.sql
git commit -q -m "feat(db): support completes an active ride at the agreed price + recorded wait (00660)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 9: Migration — CRLF rebuild, self-checks, negative proofs

**Files:**
- Modify: `supabase/migrations/00660_stuck_ride_support.sql` (append, and fill `NEW_CWC_MD5`)
- Modify: `supabase/tests/00660/run.sh` (append negative proofs)

- [ ] **Step 1: Append the CRLF rebuild and the checks**

```sql
-- A copy pasted with Windows line ends puts \r in the function bodies. They run
-- the same, but their md5 no longer matches git. Rebuild them from the catalog.
DO $crlf$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
      '_wait_charge_for', 'calculate_wait_charge', '_ride_gps_departure_at', '_active_ride_charge_preview',
      '_support_ride_push', 'admin_active_ride_context', 'admin_release_active_ride',
      'admin_advance_active_ride', 'admin_complete_active_ride')
      AND position(chr(13) IN p.prosrc) > 0
  LOOP
    EXECUTE replace(pg_get_functiondef(r.oid), chr(13), '');
  END LOOP;
END
$crlf$;

-- What this migration promises, checked in the database it just changed.
DO $verify$
DECLARE
  r record;
  v_n integer;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.calculate_wait_charge(uuid)'::regprocedure)
     IS DISTINCT FROM 'NEW_CWC_MD5' THEN
    RAISE EXCEPTION '00660 check: calculate_wait_charge has an unexpected body';
  END IF;

  IF (SELECT allowed_roles FROM public.valid_transitions
       WHERE from_status = 'accepted' AND to_status = 'arrived_at_pickup')
     IS DISTINCT FROM ARRAY['admin', 'super_admin']::public.user_role[] THEN
    RAISE EXCEPTION '00660 check: accepted -> arrived_at_pickup must be for admin and super_admin only';
  END IF;

  v_n := 0;
  FOR r IN
    SELECT p.oid::regprocedure AS fn FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
      '_wait_charge_for', '_ride_gps_departure_at', '_active_ride_charge_preview', '_support_ride_push')
  LOOP
    v_n := v_n + 1;
    IF has_function_privilege('anon', r.fn, 'EXECUTE') OR has_function_privilege('authenticated', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00660 check: % is executable by a client role', r.fn;
    END IF;
  END LOOP;
  IF v_n <> 4 THEN
    RAISE EXCEPTION '00660 check: expected 4 internal functions, found %', v_n;
  END IF;

  v_n := 0;
  FOR r IN
    SELECT p.oid::regprocedure AS fn FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
      'admin_active_ride_context', 'admin_release_active_ride', 'admin_advance_active_ride', 'admin_complete_active_ride')
  LOOP
    v_n := v_n + 1;
    IF has_function_privilege('anon', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00660 check: % is executable by anon', r.fn;
    END IF;
    IF NOT has_function_privilege('authenticated', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00660 check: % is not executable by authenticated', r.fn;
    END IF;
  END LOOP;
  IF v_n <> 4 THEN
    RAISE EXCEPTION '00660 check: expected 4 admin functions, found %', v_n;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
      '_wait_charge_for', 'calculate_wait_charge', '_ride_gps_departure_at', '_active_ride_charge_preview',
      '_support_ride_push', 'admin_active_ride_context', 'admin_release_active_ride',
      'admin_advance_active_ride', 'admin_complete_active_ride')
      AND position(chr(13) IN p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION '00660 check: a function body still has a carriage return';
  END IF;
END
$verify$;

RESET lock_timeout;
```

- [ ] **Step 2: Compute the new `calculate_wait_charge` md5 and fill it in**

While both `NEW_CWC_MD5` are still literal, the verify block cannot pass. Apply a copy without the verify block, then read the md5 the first apply leaves behind:

```bash
TMP660=$(mktemp -d)
sed 's/NEW_CWC_MD5/00000000000000000000000000000000/g; /^DO \$verify\$/,/^\$verify\$;/d' \
  supabase/migrations/00660_stuck_ride_support.sql > "$TMP660/m660.sql"
bash supabase/tests/00660/run.sh "$TMP660/m660.sql" | head -3
/usr/lib/postgresql/16/bin/psql -h 127.0.0.1 -p 5433 -U pgtest -d pr660 -qAt \
  -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.calculate_wait_charge(uuid)'::regprocedure"
```
Expected: the run stops at `migration NOT idempotent`. On the second apply the guard does not know the new body yet, and that is expected here. The last command prints a 32-character md5. Replace both placeholders with it:

```bash
sed -i "s/NEW_CWC_MD5/<the md5 printed above>/g" supabase/migrations/00660_stuck_ride_support.sql
grep -c "NEW_CWC_MD5" supabase/migrations/00660_stuck_ride_support.sql
```
Expected: `0`.

- [ ] **Step 3: Append the negative proofs and the CRLF run to `run.sh`**

Insert before the final `echo; echo "passed ..."` block:

```bash
if [ "$MIG" != "none" ]; then
  echo "== CRLF copy applies and leaves no carriage return =="
  fresh pr660crlf >/dev/null && grid pr660crlf >/dev/null
  CRLF_COPY=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF_COPY"
  apply pr660crlf "$CRLF_COPY" >/dev/null && ok "X1 a CRLF copy applies" || ko "X1 a CRLF copy applies" "migration failed"
  val "X2 ...and no body keeps a carriage return" \
    "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(chr(13) IN prosrc) > 0;" "0" pr660crlf

  echo "== the checks fail when their promise is broken =="
  neg(){ fresh pr660neg >/dev/null && grid pr660neg >/dev/null
         run pr660neg "$1" >/dev/null
         local r; r=$(apply pr660neg "$MIG")
         if echo "$r" | grep -q "$2"; then ok "$3"; else ko "$3" "expected [$2], got [$r]"; fi; }
  neg "CREATE OR REPLACE FUNCTION public.calculate_wait_charge(p_ride_id uuid) RETURNS record LANGUAGE plpgsql AS \$f\$ DECLARE r record; BEGIN SELECT 0 AS a INTO r; RETURN r; END \$f\$;" \
      "is not the body this migration replaces" "N1 refuses an unknown calculate_wait_charge"
  neg "INSERT INTO public.valid_transitions VALUES ('accepted','arrived_at_pickup','{driver,admin,super_admin}');" \
      "must be for admin and super_admin only" "N2 refuses a driver-open accepted -> arrived_at_pickup"
  neg "CREATE OR REPLACE FUNCTION public._wait_charge_for(p text) RETURNS int LANGUAGE sql AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION public._wait_charge_for(text) TO authenticated;" \
      "executable by a client role" "N3 refuses a client-executable helper overload"
fi
```

- [ ] **Step 4: Run the full rehearsal**

Run: `bash supabase/tests/00660/run.sh supabase/migrations/00660_stuck_ride_support.sql`
Expected: `passed N, failed 0`, including W1–W3, D1–D5, G1–G4, C1–C11, R1–R8, A1–A7, P1, X1–X2 and N1–N3.

Run: `bash supabase/tests/00660/run.sh none`
Expected: `failed` > 0 (RED stays RED).

Run: `pnpm check:migration-grants`
Expected: pass. The migration creates no table.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00660_stuck_ride_support.sql supabase/tests/00660/run.sh
git commit -q -m "feat(db): 00660 self-checks, CRLF rebuild and negative proofs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 10: Service methods

**Files:**
- Modify: `packages/api/src/services/ride-assist.service.ts`
- Test: `packages/api/src/services/__tests__/ride-assist.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe('rideAssistService', ...)` in `ride-assist.test.ts`:

```ts
  describe('active rides (00660)', () => {
    it('getActiveContext returns the context and maps a missing RPC to unavailable', async () => {
      const ctx = { ride: { id: 'r-1', status: 'in_progress' }, allowed_actions: ['advance', 'complete'] };
      mockRpc.mockResolvedValueOnce({ data: ctx, error: null });
      await expect(rideAssistService.getActiveContext('r-1')).resolves.toEqual(ctx);
      expect(mockRpc).toHaveBeenCalledWith('admin_active_ride_context', { p_ride_id: 'r-1' });

      mockRpc.mockResolvedValueOnce({ data: null, error: { ...MISSING, message: 'Could not find the function public.admin_active_ride_context' } });
      await expect(rideAssistService.getActiveContext('r-1')).rejects.toMatchObject({ code: RIDE_ASSIST_UNAVAILABLE });
    });

    it('releaseActiveRide sends the status support saw and the reason', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, status: 'searching' }, error: null });
      await rideAssistService.releaseActiveRide('r-1', 'accepted', 'no responde');
      expect(mockRpc).toHaveBeenCalledWith('admin_release_active_ride', {
        p_ride_id: 'r-1', p_expected_status: 'accepted', p_reason: 'no responde',
      });
    });

    it('advanceActiveRide returns the new status', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, status: 'in_progress' }, error: null });
      await expect(rideAssistService.advanceActiveRide('r-1', 'arrived_at_pickup', 'sin gps')).resolves.toBe('in_progress');
      expect(mockRpc).toHaveBeenCalledWith('admin_advance_active_ride', {
        p_ride_id: 'r-1', p_expected_status: 'arrived_at_pickup', p_reason: 'sin gps',
      });
    });

    it('completeActiveRide sends the confirmed total and returns the final fare', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, final_fare_cup: 2970 }, error: null });
      await expect(rideAssistService.completeActiveRide('r-1', 'in_progress', 2970, 'app caída')).resolves.toBe(2970);
      expect(mockRpc).toHaveBeenCalledWith('admin_complete_active_ride', {
        p_ride_id: 'r-1', p_expected_status: 'in_progress', p_expected_total_cup: 2970, p_reason: 'app caída',
      });
    });

    it('a refusal comes back as an AppError carrying the code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'amount_changed', total_cup: 3100 }, error: null });
      await expect(rideAssistService.completeActiveRide('r-1', 'in_progress', 2970, 'app caída'))
        .rejects.toMatchObject({ code: 'amount_changed' });
    });
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd packages/api && npx vitest run src/services/__tests__/ride-assist.test.ts`
Expected: FAIL with `rideAssistService.getActiveContext is not a function` (and the same for the others).

- [ ] **Step 3: Implement**

In `ride-assist.service.ts`, after the `AssistCandidate` interface, add:

```ts
/** An action support can take on an active ride (00660). */
export type ActiveRideAction = 'release' | 'advance' | 'complete';

/** What completing the ride would charge (00660 _active_ride_charge_preview). */
export interface ActiveRideChargePreview {
  agreed_cup: number;
  discount_cup: number;
  wait_minutes: number;
  billable_minutes: number;
  wait_cup: number;
  insurance_cup: number;
  is_corporate: boolean;
  total_cup: number;
}

/** Everything the assist page shows for a ride that already has a driver (admin_active_ride_context). */
export interface ActiveRideContext {
  ride: {
    id: string;
    code: string;
    status: string;
    service_type: string;
    payment_method: string;
    is_corporate: boolean;
    pickup_address: string;
    dropoff_address: string;
    created_at: string;
    accepted_at: string | null;
    driver_arrived_at: string | null;
    pickup_at: string | null;
    scheduled_at: string | null;
    estimated_fare_cup: number;
    customer_id: string;
    customer_name: string | null;
    customer_phone: string | null;
    customer_is_test: boolean;
  };
  driver: {
    driver_profile_id: string;
    full_name: string | null;
    phone: string | null;
    is_online: boolean;
    last_heartbeat_at: string | null;
    vehicle_label: string | null;
  } | null;
  last_point: {
    recorded_at: string;
    received_at: string | null;
    distance_to_pickup_m: number;
    distance_to_dropoff_m: number;
  } | null;
  alert: { reason: string; detected_at: string } | null;
  preview: ActiveRideChargePreview | null;
  /** For arrived_at_pickup: the pickup time "Marcar viaje iniciado" would record. */
  start_pickup_at: string | null;
  start_pickup_source: 'recorded' | 'gps' | 'arrival' | 'now' | null;
  allowed_actions: ActiveRideAction[];
}
```

At the end of the `rideAssistService` object, before the closing `};`, add:

```ts
  /** The active-ride view's data. A missing RPC (00660 not applied) throws RIDE_ASSIST_UNAVAILABLE. */
  async getActiveContext(rideId: string): Promise<ActiveRideContext> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_active_ride_context', { p_ride_id: rideId });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_active_ride_context');
      throw error;
    }
    throwIfRefused('admin_active_ride_context', data);
    return data as ActiveRideContext;
  },

  /** Back to search now. `expectedStatus` is the status support saw (refused as ride_changed otherwise). */
  async releaseActiveRide(rideId: string, expectedStatus: string, reason: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_release_active_ride', {
      p_ride_id: rideId,
      p_expected_status: expectedStatus,
      p_reason: reason,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_release_active_ride');
      throw error;
    }
    throwIfRefused('admin_release_active_ride', data);
  },

  /** One step forward. Returns the new status. */
  async advanceActiveRide(rideId: string, expectedStatus: string, reason: string): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_advance_active_ride', {
      p_ride_id: rideId,
      p_expected_status: expectedStatus,
      p_reason: reason,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_advance_active_ride');
      throw error;
    }
    throwIfRefused('admin_advance_active_ride', data);
    return (data as { status: string }).status;
  },

  /** Complete and charge `expectedTotalCup`, the amount support confirmed. Returns the final fare. */
  async completeActiveRide(rideId: string, expectedStatus: string, expectedTotalCup: number, reason: string): Promise<number> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_complete_active_ride', {
      p_ride_id: rideId,
      p_expected_status: expectedStatus,
      p_expected_total_cup: expectedTotalCup,
      p_reason: reason,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('admin_complete_active_ride');
      throw error;
    }
    throwIfRefused('admin_complete_active_ride', data);
    return (data as { final_fare_cup: number }).final_fare_cup;
  },
```

Also change the `unavailable()` message so it names no migration, since it now covers 00628 and 00660:

```ts
function unavailable(rpc: string): AppError {
  return new AppError(`${rpc} is not deployed yet`, RIDE_ASSIST_UNAVAILABLE, 503);
}
```

Check that the new types are exported from the package: `grep -n "ride-assist" packages/api/src/index.ts`. If it is `export * from './services/ride-assist.service'`, nothing else is needed. If it lists names, add `type ActiveRideContext, type ActiveRideAction, type ActiveRideChargePreview`.

- [ ] **Step 4: Run the tests**

Run: `cd packages/api && npx vitest run src/services/__tests__/ride-assist.test.ts`
Expected: PASS, all tests (the old ones and the 5 new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/ride-assist.service.ts packages/api/src/services/__tests__/ride-assist.test.ts packages/api/src/index.ts
git commit -q -m "feat(api): support actions on active rides (release, advance, complete)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 11: Admin panel

**Files:**
- Create: `apps/admin/src/components/support/AssistActiveRide.tsx`
- Modify: `apps/admin/src/app/rides/[id]/assist/page.tsx`
- Modify: `apps/admin/src/app/rides/[id]/page.tsx:196`
- Modify: `apps/admin/src/components/dashboard/StuckRideBanner.tsx:31`
- Modify: `apps/admin/src/components/support/assistErrors.ts`
- Modify: `packages/i18n/src/locales/{es,en,pt}/admin.json`

- [ ] **Step 1: Add the copy**

Run this script once. It adds the keys to the three locales, inside `ride_assist`, and refuses to overwrite a key that already exists:

```bash
python3 - <<'PY'
import json, collections
keys = {
 'es': {
  'active_title': 'Viaje con conductor', 'active_status': 'Estado: {{status}}',
  'status_accepted': 'Aceptado', 'status_driver_en_route': 'Conductor en camino', 'status_arrived_at_pickup': 'Conductor en la recogida',
  'status_in_progress': 'En viaje', 'status_arrived_at_destination': 'En el destino',
  'times_accepted': 'Aceptado', 'times_arrived': 'Llegó a recoger', 'times_pickup': 'Salió con el pasajero',
  'driver': 'Conductor', 'driver_online': 'En línea', 'driver_offline': 'Fuera de línea', 'heartbeat_ago': 'Último reporte: hace {{ago}}',
  'driver_whatsapp_text': 'Hola, te escribe soporte de TriciGo por el viaje {{code}}.',
  'last_point': 'Último punto GPS: hace {{ago}}, a {{meters}} m de {{target}}', 'last_point_none': 'Sin puntos GPS de este viaje',
  'target_pickup': 'la recogida', 'target_dropoff': 'el destino',
  'alert': 'Alerta: {{reason}} (detectada hace {{ago}})',
  'alert_complete_blocked': 'no pudo finalizar por distancia', 'alert_stationary_chat': 'conductor detenido con chat activo',
  'alert_dead_driver_app': 'la app del conductor dejó de responder',
  'charge_card': 'Cobro', 'charge_agreed': 'Precio acordado', 'charge_discount': 'Descuento',
  'charge_wait': 'Espera ({{minutes}} min, {{billable}} cobrables)', 'charge_insurance': 'Seguro (aparte)', 'charge_total': 'Total a cobrar',
  'charge_not_yet': 'El cobro se conoce cuando el pasajero sube al vehículo.',
  'charge_corporate': 'Viaje corporativo: la empresa paga con su comisión acordada y el monto final puede ser menor.',
  'charge_none': 'Este viaje no tiene precio acordado.',
  'actions_card': 'Ayudar con el viaje',
  'action_release': 'Volver a buscar conductor', 'action_advance_arrived': 'Marcar llegada',
  'action_advance_started': 'Marcar viaje iniciado', 'action_advance_destination': 'Marcar llegada al destino',
  'action_complete': 'Terminar y cobrar',
  'confirm_release_message': 'El viaje vuelve a buscar conductor ahora mismo y {{name}} queda fuera de línea. Avisamos a los dos.',
  'confirm_arrived_message': 'Marcamos que el conductor llegó a recoger. La espera empieza a contar desde ahora.',
  'confirm_started_message': 'Marcamos el viaje como iniciado a las {{time}} ({{source}}). Espera registrada: {{wait}}.',
  'source_gps': 'cuando el GPS lo muestra saliendo', 'source_arrival': 'sin salida en el GPS: no se cobra espera',
  'source_recorded': 'hora ya registrada', 'source_now': 'ahora',
  'confirm_destination_message': 'Marcamos que el conductor llegó al destino.',
  'confirm_complete_message': 'Terminamos el viaje y cobramos {{total}}.',
  'reason_placeholder': 'Motivo (obligatorio)',
  'done_release': 'El viaje volvió a buscar conductor', 'done_advance': 'Viaje actualizado', 'done_complete': 'Viaje terminado: se cobró {{total}}',
  'error_ride_changed': 'El viaje cambió mientras lo mirabas. Revisa los datos y vuelve a intentarlo.',
  'error_amount_changed': 'El monto cambió mientras lo mirabas. Revisa los datos y vuelve a intentarlo.',
  'error_ride_not_releasable': 'Este viaje ya no se puede devolver a búsqueda.',
  'error_ride_not_advanceable': 'Este viaje ya no se puede avanzar.',
  'error_ride_not_completable': 'Este viaje todavía no se puede terminar.',
  'error_no_agreed_price': 'Este viaje no tiene precio acordado; no se puede cobrar desde soporte.',
 },
 'en': {
  'active_title': 'Ride with a driver', 'active_status': 'Status: {{status}}',
  'status_accepted': 'Accepted', 'status_driver_en_route': 'Driver on the way', 'status_arrived_at_pickup': 'Driver at pickup',
  'status_in_progress': 'On the ride', 'status_arrived_at_destination': 'At the destination',
  'times_accepted': 'Accepted', 'times_arrived': 'Arrived at pickup', 'times_pickup': 'Left with the rider',
  'driver': 'Driver', 'driver_online': 'Online', 'driver_offline': 'Offline', 'heartbeat_ago': 'Last report: {{ago}} ago',
  'driver_whatsapp_text': 'Hi, this is TriciGo support about ride {{code}}.',
  'last_point': 'Last GPS point: {{ago}} ago, {{meters}} m from {{target}}', 'last_point_none': 'No GPS points for this ride',
  'target_pickup': 'the pickup', 'target_dropoff': 'the destination',
  'alert': 'Alert: {{reason}} (detected {{ago}} ago)',
  'alert_complete_blocked': 'could not finish because of distance', 'alert_stationary_chat': 'driver stopped with an active chat',
  'alert_dead_driver_app': "the driver's app stopped responding",
  'charge_card': 'Charge', 'charge_agreed': 'Agreed price', 'charge_discount': 'Discount',
  'charge_wait': 'Wait ({{minutes}} min, {{billable}} billable)', 'charge_insurance': 'Insurance (separate)', 'charge_total': 'Total to charge',
  'charge_not_yet': 'The charge is known once the rider is on board.',
  'charge_corporate': 'Corporate ride: the company pays with its agreed commission and the final amount can be lower.',
  'charge_none': 'This ride has no agreed price.',
  'actions_card': 'Help with the ride',
  'action_release': 'Find another driver', 'action_advance_arrived': 'Mark arrival',
  'action_advance_started': 'Mark ride started', 'action_advance_destination': 'Mark arrival at destination',
  'action_complete': 'Finish and charge',
  'confirm_release_message': 'The ride goes back to search right now and {{name}} goes offline. We notify both.',
  'confirm_arrived_message': 'We mark that the driver arrived at the pickup. The wait starts counting now.',
  'confirm_started_message': 'We mark the ride as started at {{time}} ({{source}}). Recorded wait: {{wait}}.',
  'source_gps': 'when the GPS shows the driver leaving', 'source_arrival': 'no departure in the GPS: no wait is charged',
  'source_recorded': 'time already recorded', 'source_now': 'now',
  'confirm_destination_message': 'We mark that the driver arrived at the destination.',
  'confirm_complete_message': 'We finish the ride and charge {{total}}.',
  'reason_placeholder': 'Reason (required)',
  'done_release': 'The ride is searching for a driver again', 'done_advance': 'Ride updated', 'done_complete': 'Ride finished: {{total}} charged',
  'error_ride_changed': 'The ride changed while you were looking. Check it and try again.',
  'error_amount_changed': 'The amount changed while you were looking. Check it and try again.',
  'error_ride_not_releasable': 'This ride can no longer go back to search.',
  'error_ride_not_advanceable': 'This ride can no longer be advanced.',
  'error_ride_not_completable': 'This ride cannot be finished yet.',
  'error_no_agreed_price': 'This ride has no agreed price; support cannot charge it.',
 },
 'pt': {
  'active_title': 'Corrida com motorista', 'active_status': 'Status: {{status}}',
  'status_accepted': 'Aceita', 'status_driver_en_route': 'Motorista a caminho', 'status_arrived_at_pickup': 'Motorista no embarque',
  'status_in_progress': 'Em viagem', 'status_arrived_at_destination': 'No destino',
  'times_accepted': 'Aceita', 'times_arrived': 'Chegou ao embarque', 'times_pickup': 'Saiu com o passageiro',
  'driver': 'Motorista', 'driver_online': 'Online', 'driver_offline': 'Offline', 'heartbeat_ago': 'Último sinal: há {{ago}}',
  'driver_whatsapp_text': 'Olá, aqui é o suporte da TriciGo sobre a corrida {{code}}.',
  'last_point': 'Último ponto GPS: há {{ago}}, a {{meters}} m de {{target}}', 'last_point_none': 'Sem pontos GPS desta corrida',
  'target_pickup': 'o embarque', 'target_dropoff': 'o destino',
  'alert': 'Alerta: {{reason}} (detectado há {{ago}})',
  'alert_complete_blocked': 'não pôde finalizar por distância', 'alert_stationary_chat': 'motorista parado com chat ativo',
  'alert_dead_driver_app': 'o app do motorista parou de responder',
  'charge_card': 'Cobrança', 'charge_agreed': 'Preço combinado', 'charge_discount': 'Desconto',
  'charge_wait': 'Espera ({{minutes}} min, {{billable}} cobráveis)', 'charge_insurance': 'Seguro (à parte)', 'charge_total': 'Total a cobrar',
  'charge_not_yet': 'A cobrança é conhecida quando o passageiro embarca.',
  'charge_corporate': 'Corrida corporativa: a empresa paga com sua comissão combinada e o valor final pode ser menor.',
  'charge_none': 'Esta corrida não tem preço combinado.',
  'actions_card': 'Ajudar com a corrida',
  'action_release': 'Buscar outro motorista', 'action_advance_arrived': 'Marcar chegada',
  'action_advance_started': 'Marcar corrida iniciada', 'action_advance_destination': 'Marcar chegada ao destino',
  'action_complete': 'Finalizar e cobrar',
  'confirm_release_message': 'A corrida volta a buscar motorista agora e {{name}} fica offline. Avisamos os dois.',
  'confirm_arrived_message': 'Marcamos que o motorista chegou ao embarque. A espera começa a contar agora.',
  'confirm_started_message': 'Marcamos a corrida como iniciada às {{time}} ({{source}}). Espera registrada: {{wait}}.',
  'source_gps': 'quando o GPS mostra a saída', 'source_arrival': 'sem saída no GPS: não se cobra espera',
  'source_recorded': 'horário já registrado', 'source_now': 'agora',
  'confirm_destination_message': 'Marcamos que o motorista chegou ao destino.',
  'confirm_complete_message': 'Finalizamos a corrida e cobramos {{total}}.',
  'reason_placeholder': 'Motivo (obrigatório)',
  'done_release': 'A corrida voltou a buscar motorista', 'done_advance': 'Corrida atualizada', 'done_complete': 'Corrida finalizada: {{total}} cobrados',
  'error_ride_changed': 'A corrida mudou enquanto você olhava. Confira e tente de novo.',
  'error_amount_changed': 'O valor mudou enquanto você olhava. Confira e tente de novo.',
  'error_ride_not_releasable': 'Esta corrida não pode mais voltar à busca.',
  'error_ride_not_advanceable': 'Esta corrida não pode mais avançar.',
  'error_ride_not_completable': 'Esta corrida ainda não pode ser finalizada.',
  'error_no_agreed_price': 'Esta corrida não tem preço combinado; o suporte não pode cobrá-la.',
 },
}
assert set(keys['es']) == set(keys['en']) == set(keys['pt'])
for loc, add in keys.items():
    p = f'packages/i18n/src/locales/{loc}/admin.json'
    d = json.load(open(p, encoding='utf-8'), object_pairs_hook=collections.OrderedDict)
    ra = d['ride_assist']
    clash = [k for k in add if k in ra]
    assert not clash, (loc, clash)
    ra.update(add)
    open(p, 'w', encoding='utf-8', newline='\n').write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
    print(loc, len(ra))
PY
git diff --stat packages/i18n/src/locales/
```
Expected: the same count for `es`, `en` and `pt` (101 plus the keys added), and the diff touches only the three `admin.json` files. If the diff also reformats unrelated lines, the file used a different indent: redo the write with that indent.

Copy check: `pnpm test --filter @tricigo/utils -- copyTuteo` must pass. None of the Spanish strings use voseo.

- [ ] **Step 2: Add the new codes to `assistErrors.ts`**

In `CODES`, after `'invalid_service_type',`, add:

```ts
  'ride_changed',
  'amount_changed',
  'ride_not_releasable',
  'ride_not_advanceable',
  'ride_not_completable',
  'no_agreed_price',
```

- [ ] **Step 3: Create `AssistActiveRide.tsx`**

```tsx
'use client';

/**
 * The assist page's view for a ride that already has a driver (00660): who is involved and how to
 * reach them, where the ride is, what finishing it would charge, and the actions the server allows
 * for its status. Every action asks for a reason and is refused if the ride changed meanwhile.
 */

import { useState } from 'react';
import { MessageCircle, Phone } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { rideAssistService, type ActiveRideContext } from '@tricigo/api';
import { formatCUP, waMeLink } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { formatAdminDate } from '@/lib/formatDate';
import { assistErrorKey } from './assistErrors';
import { agoLabel, telLink } from './supportFormat';

const CARD = 'rounded-xl border border-line bg-surface-elevated p-6 shadow-sm';
const LINK_BTN =
  'inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken';
const ACTION_BTN =
  'rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50';
const DANGER_BTN =
  'rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50';

type Pending = 'release' | 'advance' | 'complete' | null;

const ADVANCE_LABEL: Record<string, string> = {
  accepted: 'ride_assist.action_advance_arrived',
  driver_en_route: 'ride_assist.action_advance_arrived',
  arrived_at_pickup: 'ride_assist.action_advance_started',
  in_progress: 'ride_assist.action_advance_destination',
};

export function AssistActiveRide({ ctx, now, onChanged }: { ctx: ActiveRideContext; now: number; onChanged: () => void }) {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const { ride, driver, last_point: point, alert, preview } = ctx;
  const riderWa = waMeLink(ride.customer_phone, t('ride_assist.rider_whatsapp_text', { code: ride.code }));
  const riderTel = telLink(ride.customer_phone);
  const driverWa = waMeLink(driver?.phone ?? null, t('ride_assist.driver_whatsapp_text', { code: ride.code }));
  const driverTel = telLink(driver?.phone);
  const beforePickup = ride.status === 'accepted' || ride.status === 'driver_en_route';
  const can = (a: 'release' | 'advance' | 'complete') => ctx.allowed_actions.includes(a);

  const startTime = ctx.start_pickup_at ? formatAdminDate(ctx.start_pickup_at) : '';
  const confirmMessage = (() => {
    if (pending === 'release') return t('ride_assist.confirm_release_message', { name: driver?.full_name ?? '' });
    if (pending === 'complete') return t('ride_assist.confirm_complete_message', { total: formatCUP(preview?.total_cup ?? 0) });
    if (pending === 'advance') {
      if (beforePickup) return t('ride_assist.confirm_arrived_message');
      if (ride.status === 'arrived_at_pickup') {
        return t('ride_assist.confirm_started_message', {
          time: startTime,
          source: t(`ride_assist.source_${ctx.start_pickup_source ?? 'now'}`),
          wait: formatCUP(preview?.wait_cup ?? 0),
        });
      }
      return t('ride_assist.confirm_destination_message');
    }
    return '';
  })();

  const close = () => {
    setPending(null);
    setReason('');
  };

  const confirm = async () => {
    const why = reason.trim();
    if (why.length < 3) {
      showToast('error', t('ride_assist.error_reason_required'));
      return;
    }
    setBusy(true);
    try {
      if (pending === 'release') {
        await rideAssistService.releaseActiveRide(ride.id, ride.status, why);
        showToast('success', t('ride_assist.done_release'));
      } else if (pending === 'advance') {
        await rideAssistService.advanceActiveRide(ride.id, ride.status, why);
        showToast('success', t('ride_assist.done_advance'));
      } else if (pending === 'complete' && preview) {
        const final = await rideAssistService.completeActiveRide(ride.id, ride.status, preview.total_cup, why);
        showToast('success', t('ride_assist.done_complete', { total: formatCUP(final) }));
      }
      close();
    } catch (err) {
      showToast('error', t(assistErrorKey(err)));
      close();
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <>
      <p className="mb-4 text-sm font-medium text-ink-muted">
        {t('ride_assist.active_title')} ·{' '}
        {t('ride_assist.active_status', { status: t(`ride_assist.status_${ride.status}`, { defaultValue: ride.status }) })}
      </p>

      {alert && (
        <div className="mb-6 rounded-xl bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-400">
          {t('ride_assist.alert', {
            reason: t(`ride_assist.alert_${alert.reason}`, { defaultValue: alert.reason }),
            ago: agoLabel(alert.detected_at, now),
          })}
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className={CARD}>
          <h2 className="mb-4 text-lg font-bold">{t('ride_assist.ride_card')}</h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-ink-muted">{t('ride_assist.origin')}</dt>
              <dd className="font-medium text-ink">{ride.pickup_address}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">{t('ride_assist.destination')}</dt>
              <dd className="font-medium text-ink">{ride.dropoff_address}</dd>
            </div>
            <div className="flex flex-wrap gap-6">
              {ride.accepted_at && (
                <div>
                  <dt className="text-ink-muted">{t('ride_assist.times_accepted')}</dt>
                  <dd className="font-medium text-ink">{formatAdminDate(ride.accepted_at)}</dd>
                </div>
              )}
              {ride.driver_arrived_at && (
                <div>
                  <dt className="text-ink-muted">{t('ride_assist.times_arrived')}</dt>
                  <dd className="font-medium text-ink">{formatAdminDate(ride.driver_arrived_at)}</dd>
                </div>
              )}
              {ride.pickup_at && (
                <div>
                  <dt className="text-ink-muted">{t('ride_assist.times_pickup')}</dt>
                  <dd className="font-medium text-ink">{formatAdminDate(ride.pickup_at)}</dd>
                </div>
              )}
            </div>
            <p className="text-ink-muted">
              {point
                ? t('ride_assist.last_point', {
                    ago: agoLabel(point.recorded_at, now),
                    meters: beforePickup || ride.status === 'arrived_at_pickup' ? point.distance_to_pickup_m : point.distance_to_dropoff_m,
                    target: t(beforePickup || ride.status === 'arrived_at_pickup' ? 'ride_assist.target_pickup' : 'ride_assist.target_dropoff'),
                  })
                : t('ride_assist.last_point_none')}
            </p>
          </dl>
        </section>

        <section className={CARD}>
          <h2 className="mb-4 text-lg font-bold">{t('ride_assist.rider')}</h2>
          <p className="text-sm font-medium text-ink">{ride.customer_name}</p>
          <p className="text-sm text-ink-muted">{ride.customer_phone ?? '—'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {riderWa && (
              <a href={riderWa} target="_blank" rel="noopener noreferrer" className={LINK_BTN}>
                <MessageCircle className="h-4 w-4" />
                {t('ride_assist.whatsapp')}
              </a>
            )}
            {riderTel && (
              <a href={riderTel} className={LINK_BTN}>
                <Phone className="h-4 w-4" />
                {t('ride_assist.call')}
              </a>
            )}
          </div>

          {driver && (
            <>
              <h2 className="mb-2 mt-6 text-lg font-bold">{t('ride_assist.driver')}</h2>
              <p className="text-sm font-medium text-ink">{driver.full_name}</p>
              <p className="text-sm text-ink-muted">
                {driver.phone ?? '—'}
                {driver.vehicle_label ? ` · ${driver.vehicle_label}` : ''}
              </p>
              <p className="text-sm text-ink-muted">
                {t(driver.is_online ? 'ride_assist.driver_online' : 'ride_assist.driver_offline')}
                {driver.last_heartbeat_at ? ` · ${t('ride_assist.heartbeat_ago', { ago: agoLabel(driver.last_heartbeat_at, now) })}` : ''}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {driverWa && (
                  <a href={driverWa} target="_blank" rel="noopener noreferrer" className={LINK_BTN}>
                    <MessageCircle className="h-4 w-4" />
                    {t('ride_assist.whatsapp')}
                  </a>
                )}
                {driverTel && (
                  <a href={driverTel} className={LINK_BTN}>
                    <Phone className="h-4 w-4" />
                    {t('ride_assist.call')}
                  </a>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <section className={`${CARD} mb-6`}>
        <h2 className="mb-4 text-lg font-bold">{t('ride_assist.charge_card')}</h2>
        {!preview ? (
          <p className="text-sm text-ink-muted">{t('ride_assist.charge_none')}</p>
        ) : (
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-muted">{t('ride_assist.charge_agreed')}</dt>
              <dd className="font-medium text-ink">{formatCUP(preview.agreed_cup)}</dd>
            </div>
            {preview.discount_cup > 0 && (
              <div className="flex justify-between">
                <dt className="text-ink-muted">{t('ride_assist.charge_discount')}</dt>
                <dd className="font-medium text-ink">−{formatCUP(preview.discount_cup)}</dd>
              </div>
            )}
            {beforePickup ? (
              <p className="text-ink-muted">{t('ride_assist.charge_not_yet')}</p>
            ) : (
              <>
                <div className="flex justify-between">
                  <dt className="text-ink-muted">
                    {t('ride_assist.charge_wait', { minutes: preview.wait_minutes, billable: preview.billable_minutes })}
                  </dt>
                  <dd className="font-medium text-ink">{formatCUP(preview.wait_cup)}</dd>
                </div>
                {preview.insurance_cup > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">{t('ride_assist.charge_insurance')}</dt>
                    <dd className="font-medium text-ink">{formatCUP(preview.insurance_cup)}</dd>
                  </div>
                )}
                <div className="flex justify-between border-t border-line pt-2">
                  <dt className="font-semibold text-ink">{t('ride_assist.charge_total')}</dt>
                  <dd className="font-bold text-ink">{formatCUP(preview.total_cup)}</dd>
                </div>
                {preview.is_corporate && <p className="text-ink-muted">{t('ride_assist.charge_corporate')}</p>}
              </>
            )}
          </dl>
        )}
      </section>

      {ctx.allowed_actions.length > 0 && (
        <section className={`${CARD} mb-6`}>
          <h2 className="mb-4 text-lg font-bold">{t('ride_assist.actions_card')}</h2>
          <div className="flex flex-wrap gap-3">
            {can('advance') && ADVANCE_LABEL[ride.status] && (
              <button type="button" disabled={busy} className={ACTION_BTN} onClick={() => setPending('advance')}>
                {t(ADVANCE_LABEL[ride.status]!)}
              </button>
            )}
            {can('complete') && preview && (
              <button type="button" disabled={busy} className={ACTION_BTN} onClick={() => setPending('complete')}>
                {t('ride_assist.action_complete')}
              </button>
            )}
            {can('release') && (
              <button type="button" disabled={busy} className={DANGER_BTN} onClick={() => setPending('release')}>
                {t('ride_assist.action_release')}
              </button>
            )}
          </div>
        </section>
      )}

      <AdminConfirmModal
        open={pending !== null}
        title={
          pending === 'release'
            ? t('ride_assist.action_release')
            : pending === 'complete'
              ? t('ride_assist.action_complete')
              : t(ADVANCE_LABEL[ride.status] ?? 'ride_assist.actions_card')
        }
        message={confirmMessage}
        confirmLabel={t('common.confirm', { defaultValue: 'Confirmar' })}
        cancelLabel={t('common.cancel')}
        variant={pending === 'release' ? 'warning' : 'default'}
        onConfirm={confirm}
        onCancel={close}
        inputValue={reason}
        onInputChange={setReason}
        inputPlaceholder={t('ride_assist.reason_placeholder')}
      />
    </>
  );
}
```

- [ ] **Step 4: Wire it into the assist page**

In `apps/admin/src/app/rides/[id]/assist/page.tsx`:

1. Add the imports:
   ```tsx
   import { AssistActiveRide } from '@/components/support/AssistActiveRide';
   import type { ActiveRideContext } from '@tricigo/api';
   ```
   Add `type ActiveRideContext` to the existing `@tricigo/api` import list instead of a second import line.
2. Add the constant `const ACTIVE = ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination'];` next to `CARD`.
3. Add state: `const [active, setActive] = useState<ActiveRideContext | null>(null);`
4. Inside `load`, after `setCtx(next);`, add:
   ```tsx
      if (ACTIVE.includes(next.ride.status)) {
        try {
          const a = await rideAssistService.getActiveContext(id);
          if (seq === latestLoad.current) setActive(a);
        } catch {
          if (seq === latestLoad.current) setActive(null);
        }
      } else {
        setActive(null);
      }
   ```
5. Replace the `{!searching && ( ... not_searching ... )}` block with:
   ```tsx
      {!searching && !active && (
        <div className="mb-6 rounded-xl bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-400">
          {t('ride_assist.not_searching', { status: ride.status })}{' '}
          <Link href={`/rides/${ride.id}`} className="font-semibold underline">
            {t('ride_assist.see_ride')}
          </Link>
        </div>
      )}

      {active && <AssistActiveRide ctx={active} now={now} onChanged={load} />}
   ```
6. Wrap the existing two-card grid and the offers section in `{!active && ( <> ... </> )}`, so the searching view stays exactly as it is and the active view replaces it.

When the active RPC is missing (00660 not applied), `active` stays null and the page shows today's "not searching" notice.

- [ ] **Step 5: "Asistir" for active statuses, and the banner link**

In `apps/admin/src/app/rides/[id]/page.tsx`, replace `{ride.status === 'searching' && (` before the Asistir `Link` with:

```tsx
          {['searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination'].includes(ride.status) && (
```

In `apps/admin/src/components/dashboard/StuckRideBanner.tsx`, change line 31 to:

```tsx
  const href = count === 1 ? `/rides/${latest.ride_id}/assist` : '/rides';
```

- [ ] **Step 6: Type-check and lint the admin**

Run: `pnpm --filter @tricigo/admin check-types && pnpm --filter @tricigo/admin lint`
Expected: 0 errors. If lint reports `tricigo/require-dark-variant` on `ACTION_BTN`/`DANGER_BTN`, add `dark:` pairs following the rule's message, e.g. `dark:bg-primary-500 dark:hover:bg-primary-600`. Warnings must not go up from master's count.

- [ ] **Step 7: Commit**

```bash
git add apps/admin packages/i18n/src/locales/*/admin.json
git commit -q -m "feat(admin): assist page helps rides that already have a driver" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 12: Driver app — a status further along reaches the screen

**Files:**
- Create: `apps/driver/src/utils/tripStatusOrder.ts`
- Test: `apps/driver/src/utils/__tests__/tripStatusOrder.test.ts`
- Modify: `apps/driver/src/hooks/useDriverRide.ts` (5 s poll, before `const gateableStatus`)
- Modify: `packages/i18n/src/locales/{es,en,pt}/driver.json`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { isStatusAhead } from '../tripStatusOrder';

describe('isStatusAhead (what the server says vs what the screen shows)', () => {
  it('is true for a later active status', () => {
    expect(isStatusAhead('arrived_at_pickup', 'driver_en_route')).toBe(true);
    expect(isStatusAhead('in_progress', 'accepted')).toBe(true);
    expect(isStatusAhead('arrived_at_destination', 'in_progress')).toBe(true);
  });

  it('is false for the same or an earlier status, so a slow answer never moves the screen back', () => {
    expect(isStatusAhead('in_progress', 'in_progress')).toBe(false);
    expect(isStatusAhead('driver_en_route', 'arrived_at_pickup')).toBe(false);
  });

  it('is false for anything outside the active path (completion and release have their own handling)', () => {
    expect(isStatusAhead('completed', 'in_progress')).toBe(false);
    expect(isStatusAhead('searching', 'accepted')).toBe(false);
    expect(isStatusAhead(undefined, 'accepted')).toBe(false);
    expect(isStatusAhead('in_progress', null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/driver && npx vitest run src/utils/__tests__/tripStatusOrder.test.ts`
Expected: FAIL, `Failed to resolve import "../tripStatusOrder"`.

- [ ] **Step 3: Implement**

`apps/driver/src/utils/tripStatusOrder.ts`:

```ts
/**
 * The active part of the ride FSM, in order. Support can move a ride forward from the panel
 * (00660); the trip poll applies a status from the server only when it is further along than the
 * one on screen, so an answer that left before the driver's own tap cannot move the screen back.
 */
const ACTIVE_ORDER = ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination'];

export function isStatusAhead(server: string | null | undefined, local: string | null | undefined): boolean {
  const s = ACTIVE_ORDER.indexOf(server ?? '');
  const l = ACTIVE_ORDER.indexOf(local ?? '');
  return s >= 0 && l >= 0 && s > l;
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/driver && npx vitest run src/utils/__tests__/tripStatusOrder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Use it in the poll**

In `apps/driver/src/hooks/useDriverRide.ts`, add the import next to the other `../utils` imports:

```ts
import { isStatusAhead } from '../utils/tripStatusOrder';
```

In the 5 s poll, right before `// The rest only matters while waiting on rider confirmation`, insert:

```ts
        // Support moved the ride forward from the panel (00660), or the driver's own tap landed
        // but its answer was lost. Only a status further along is applied (isStatusAhead).
        if (isStatusAhead(fresh.status, localTrip.status)) {
          useDriverRideStore.getState().updateActiveTrip(fresh);
          triggerHaptic('success');
          Toast.show({
            type: 'info',
            text1: i18next.t('driver:trip.trip_updated_title', { defaultValue: 'Tu viaje se actualizó' }),
            text2: i18next.t('driver:trip.trip_updated_msg', { defaultValue: 'Te mostramos el estado actual del viaje.' }),
            visibilityTime: 5000,
          });
          logger.info('[DriverRide] server status ahead of the screen', {
            ride_id: localTrip.id,
            local_status: localTrip.status,
            server_status: fresh.status,
          });
          return;
        }
```

- [ ] **Step 6: Add the copy to the three `driver.json` files**

```bash
python3 - <<'PY'
import json, collections
add = {'es': ('Tu viaje se actualizó', 'Te mostramos el estado actual del viaje.'),
       'en': ('Your ride was updated', 'We are showing the ride as it is now.'),
       'pt': ('Sua corrida foi atualizada', 'Mostramos a corrida como está agora.')}
for loc, (title, msg) in add.items():
    p = f'packages/i18n/src/locales/{loc}/driver.json'
    d = json.load(open(p, encoding='utf-8'), object_pairs_hook=collections.OrderedDict)
    assert 'trip_updated_title' not in d['trip']
    d['trip']['trip_updated_title'] = title
    d['trip']['trip_updated_msg'] = msg
    open(p, 'w', encoding='utf-8', newline='\n').write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
PY
git diff --stat packages/i18n/src/locales/*/driver.json
```
Expected: 3 files, +2 lines each.

- [ ] **Step 7: Type-check, lint and test the driver app**

Run: `pnpm --filter @tricigo/driver check-types && pnpm --filter @tricigo/driver lint && pnpm --filter @tricigo/driver test`
Expected: 0 type errors. No new lint warning in `useDriverRide.ts`: the 12 preexisting `exhaustive-deps` warnings belong to `(tabs)/index.tsx` and do not count. All tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/driver/src/utils/tripStatusOrder.ts apps/driver/src/utils/__tests__/tripStatusOrder.test.ts apps/driver/src/hooks/useDriverRide.ts packages/i18n/src/locales/*/driver.json
git commit -q -m "feat(driver): the trip poll applies a status the server has further along" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 13: Prod check in a rolled-back block (no writes stay)

This runs through `mcp__Supabase__execute_sql`. It applies nothing: every block ends in `RAISE EXCEPTION`, which rolls back everything, the migration included. Tell the owner before running it that it is read-only in effect.

- [ ] **Step 1: The migration applies on prod's real bodies, and the new wait charge equals the old one on every real ride**

```sql
DO $probe$
DECLARE
  r record; v_old record; v_new record; v_n int := 0; v_diff int := 0;
BEGIN
  CREATE TEMP TABLE probe_old ON COMMIT DROP AS
    SELECT id, service_type, driver_arrived_at, pickup_at FROM public.rides
    WHERE driver_arrived_at IS NOT NULL AND pickup_at IS NOT NULL;
  CREATE TEMP TABLE probe_res (id uuid, w int, b int, c int) ON COMMIT DROP;
  FOR r IN SELECT * FROM probe_old LOOP
    SELECT * INTO v_old FROM public.calculate_wait_charge(r.id) AS (wait_minutes int, billable_minutes int, charge int);
    INSERT INTO probe_res VALUES (r.id, v_old.wait_minutes, v_old.billable_minutes, v_old.charge);
  END LOOP;
  EXECUTE $mig$<the whole 00660 file, pasted here>$mig$;
  FOR r IN SELECT o.*, p.w, p.b, p.c FROM probe_old o JOIN probe_res p USING (id) LOOP
    v_n := v_n + 1;
    SELECT * INTO v_new FROM public._wait_charge_for(r.service_type, r.driver_arrived_at, r.pickup_at);
    IF (v_new.wait_minutes, v_new.billable_minutes, v_new.charge) IS DISTINCT FROM (r.w, r.b, r.c) THEN v_diff := v_diff + 1; END IF;
  END LOOP;
  RAISE EXCEPTION 'PROBE rides=% differ=% md5_query=%', v_n, v_diff, md5(current_query());
END
$probe$;
```
To build the query, write it with Python, reading the migration file between the `$mig$` markers, so nothing is transcribed by hand.

Expected: `PROBE rides=N differ=0`. If the migration's own checks fail, the error names the check. Compare `md5_query` against `md5` of the text you sent: the same value means it arrived intact (CLAUDE.md § 00628).

- [ ] **Step 2: End-to-end with the demo accounts, rolled back**

Look up the ids first:
```sql
SELECT u.id, u.phone, dp.id AS dp FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id
WHERE u.phone IN ('+5355550100','+5355550101');
```

Then run one block that does all of this:
1. Applies the migration (`EXECUTE $mig$…$mig$`).
2. Inserts a scheduled ride (`scheduled_at = now() + 1 hour`, so nothing dispatches) for the demo rider at the 00631-valid fare for `triciclo_basico`, then sets `scheduled_at = NULL`.
3. Sets the demo driver and `accepted`.
4. As an admin (`set_config('request.jwt.claim.sub', <admin id>, true)`, `SET LOCAL ROLE authenticated`): `admin_advance_active_ride` (arrival), then, back as owner, inserts 3 trail points for the demo driver (40 m at −14 min, 250 m at −9 min and −8 min), then `admin_advance_active_ride` (started), then reads `admin_active_ride_context`, then `admin_complete_active_ride` with the preview's `total_cup`.
5. Reads back the following and returns them in the final `RAISE EXCEPTION 'E2E %', jsonb_build_object(...)`:
   - `final_fare_cup`
   - the ride's `pickup_at − driver_arrived_at` in minutes
   - the ledger rows for the ride (`ledger_transactions.reference_id`/`ride_id`, whichever prod uses; check with `\d ledger_transactions` first)
   - `admin_actions` count for the ride
   - the `net.http_request_queue` rows created in the block (`cron_http_calls` with label `support-ride-resolved`)

Expected:
- the pickup is 9 minutes after arrival, so 4 billable minutes at the band of the arrival time;
- `final_fare_cup` equals the preview's `total_cup`;
- 3 `admin_actions` rows;
- the support pushes: 2 for the advances, 0 for the completion.

Nothing remains after the block (the RAISE rolls back): confirm with `SELECT to_regprocedure('public.admin_active_ride_context(uuid)')` → NULL.

- [ ] **Step 3: Record the results in the PR body (Task 15).**

---

### Task 14: CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (new subsection after "### Soporte asistido (00628)…")

- [ ] **Step 1: Add the section**

```markdown
### Soporte con viajes trabados (00660, 2026-10-12)

Cuando un viaje ya tiene conductor, la página "Asistir" (`/rides/[id]/assist`, también desde el detalle del viaje y desde el aviso de viaje trabado) muestra a las dos personas con WhatsApp y llamada, dónde está el viaje según el GPS, cuánto se cobraría y las acciones que el servidor permite para su estado. Diseño: `docs/superpowers/specs/2026-10-12-stuck-ride-support-design.md`.

- **Volver a buscar conductor** (`admin_release_active_ride`, solo `accepted`/`driver_en_route`): lo mismo que la liberación automática de los 12 minutos, al instante. Además borra el estado de GPS del conductor anterior y despacha enseguida. La liberación automática todavía no borra ese estado: queda pendiente.
- **Avanzar** (`admin_advance_active_ride`): un paso por vez, sin la verja de GPS. "Viaje iniciado" toma como recogida el primer punto del rastro a más de 100 m de la recogida, con la hora más temprana entre celular y servidor; sin ese punto, recogida = llegada y no se cobra espera. `accepted → arrived_at_pickup` existe solo para admin (`valid_transitions`).
- **Terminar y cobrar** (`admin_complete_active_ride`): precio acordado − descuento + espera registrada, por `complete_ride_and_pay`. Se rechaza si el monto cambió desde que soporte lo vio (`amount_changed`).
- Todas piden motivo, rechazan `ride_changed` si el estado no es el que soporte vio, dejan fila en `admin_actions` y avisan por `cron_http_post('support-ride-resolved')`. Al pasajero le llega el push de estado de siempre; soporte no le manda un segundo.
- **`calculate_wait_charge` llama a `_wait_charge_for`** (sin escrituras). Un cambio en las reglas de espera se hace en `_wait_charge_for`; así la vista previa del panel y el cobro siguen siendo la misma cuenta.
- **La app del conductor** aplica en su consulta de 5 s un estado más avanzado que el de la pantalla (`isStatusAhead`). Las versiones anteriores se ponen al día al volver a la app.
- Ensayo: `supabase/tests/00660/run.sh`.
```

- [ ] **Step 2: Copy check and commit**

Run: `pnpm --filter @tricigo/utils test -- copyTuteo`
Expected: PASS.

```bash
git add CLAUDE.md
git commit -q -m "docs: stuck-ride support in CLAUDE.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki"
```

---

### Task 15: Full checks, PR, apply and merge (each with authorization)

- [ ] **Step 1: Run every check once more**

```bash
pnpm check-types
pnpm --filter @tricigo/api test
pnpm --filter @tricigo/driver test
pnpm --filter @tricigo/utils test
pnpm check:migration-grants
bash supabase/tests/00660/run.sh supabase/migrations/00660_stuck_ride_support.sql | tail -1
```
Expected: all green; the rehearsal ends with `failed 0`.

- [ ] **Step 2: Push and open a draft PR**

```bash
git push -u origin claude/pensive-archimedes-41vkeh
```
Create the PR with `mcp__github__create_pull_request` (draft, base `master`). The body covers:
- what support can do now;
- the measured reasons;
- the rehearsal count;
- the prod probe results from Task 13;
- that the driver change needs the next driver build;
- the follow-up for block A's GPS state.

It ends with:
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01QhinwD8BYzm5x6GoTZvtki

---
_Generated by [Claude Code](https://claude.ai/code)_
```
Then `subscribe_pr_activity` and a `send_later` safety-net check-in about 50 minutes out.

- [ ] **Step 3: Ask for authorization to apply 00660 in prod (AskUserQuestion), then apply it**

The migration has no DELETE/DROP/TRUNCATE, so `mcp__Supabase__apply_migration` (name `00660_stuck_ride_support`) should run without waiting for in-app approval. After applying, verify by object:

```sql
SELECT p.proname, md5(p.prosrc) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
AND p.proname IN ('calculate_wait_charge','_wait_charge_for','admin_active_ride_context','admin_release_active_ride',
                  'admin_advance_active_ride','admin_complete_active_ride') ORDER BY 1;
SELECT allowed_roles FROM valid_transitions WHERE from_status='accepted' AND to_status='arrived_at_pickup';
```
Expected: `calculate_wait_charge` has the `NEW_CWC_MD5` value from Task 9, and the transition is `{admin,super_admin}`.

- [ ] **Step 4: When CI is green, ask for authorization to merge (AskUserQuestion), then squash-merge**

After the merge:
- the admin deploys on its own;
- unsubscribe from the PR and delete the check-in;
- reset the branch to `origin/master`.
