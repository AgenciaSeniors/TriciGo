#!/usr/bin/env bash
# Rehearsal runner for migration 00670 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00670/run.sh none
#       -> scaffold + tests on the live prod bodies (RED: a wait that starts at 18:30 Cuba time on
#          2026-12-01 is billed at the 12-18 rate, because tzdata still reads America/Havana as UTC-5)
#   supabase/tests/00670/run.sh supabase/migrations/00670_cuba_kept_summer_time.sql
#       -> scaffold + migration x2 (idempotency) + tests + a CRLF copy + negative proofs of the
#          migration's own guards (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00670/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
DB=pr670
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# fresh DBNAME -> a new database with the scaffold
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

LIVE="_team_digest_totals:a7b5c96c51cc27b0567d12e26ed826cd,_wait_charge_for:caf3762b1dc87fce94e0b1f79bf39231,_write_ride_estimate_snapshot:3158ab50b99457c52815b1bb75c1a008,admin_deliveries_by_day:283a77a52d989b77022b00cd85a8f766,admin_launch_pulse:8a1937bbe51baf3772cfd067f7d3df2e,check_cron_sql_failures:f6ef567f3d9a6ff9050bcf862d9a3344,check_team_digest_overdue:b2fd3012af81b5e981e7c44473685eae,create_rides_for_recurring:5ace384a2e19b75c2f340162d46e957a,dispatch_team_digest:f0a895ebe2b6d4cf472882cc853c1078,get_admin_dashboard_metrics:8b5f98c002141541b6837511ccee100c,get_destination_suggestions:d4841a72cef0980810b10f4a3df37664,get_peak_hours:9cc7e8ba4a44a026e5c7a02c939ad466,get_platform_earnings:1580da05501f4f2f0f683fec822d7bfd,get_rides_by_day:339b0f0dbf075ea8c470097be5495bb1,get_rides_by_payment_method:beb36eb41b576ec41e81430e9f6e8308,get_rides_by_service_type:1cd2058668e150fb7ce5d228cb9ab389,refresh_corporate_month_spend:868268ee2d6988b4f6493e6ed4305779,team_daily_metrics:36ab1a68217774f5264ef60db40bdbc4,tg_recurring_rides_client_guard:a2b28d015540a64ac5b388b0228c1132,tg_rides_validate_corporate:17bd1b28f1cf42550da942a102f008ba"
NEW="_team_digest_totals:cfc76615b07ff5415740ab3e123fef9f,_wait_charge_for:cd7a8577019dd8945d6e5575639e63ea,_write_ride_estimate_snapshot:34756a7ea1e38b482cd1c1e0aa9865a7,admin_deliveries_by_day:03c084967be3709ea1c3569dd70a3026,admin_launch_pulse:3cb4919f1fab027a9be8450253995242,check_cron_sql_failures:0c0f58e17036bc08b948ffeff2b0d4ec,check_team_digest_overdue:b8542a53f93f1baabd159e6a96cd6cd7,create_rides_for_recurring:c0f9af8b06829ce95aa6b1e64df2c353,dispatch_team_digest:b83bd397082eeae2679e5a7dde57a644,get_admin_dashboard_metrics:a8928a91483088931f8457e3f71b2f70,get_destination_suggestions:bc9044cfcf1bb70600e7c794f7745cdc,get_peak_hours:4e78381d356c0814062a0dfa49a3a7ce,get_platform_earnings:b1acbc03666c0abc6fc106e399bd3a9a,get_rides_by_day:d3797fe1337d92a0d36baed6efc1746f,get_rides_by_payment_method:b193b4680be7c6099f4f7f2a24ee48e5,get_rides_by_service_type:9da58ac98cc6d61f46cb541a24b61bc1,refresh_corporate_month_spend:cce8fc1987c4ec2c2485d4c7656516cc,team_daily_metrics:594b2605e4ffb37e6db562b09c730700,tg_recurring_rides_client_guard:dc938f5d404fd7b80a501035f27c0296,tg_rides_validate_corporate:1ce7e55f97ad92e5f6e3416e375e374a"
BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname NOT IN ('cuba_tz', 'get_platform_config_numeric')"
# Bands like prod's: 12-18 and 18-24 with different waiting rates. Free 5 min, the wait lasts 10: 5 billable.
SEED="INSERT INTO public.service_type_configs VALUES ('triciclo_basico', true, 5, 7) ON CONFLICT DO NOTHING;
      INSERT INTO public.pricing_rules (service_type, per_wait_minute_rate_cup, time_window_start, time_window_end) VALUES
        ('triciclo_basico', 10, '12:00', '18:00'), ('triciclo_basico', 30, '18:00', '00:00')
      ON CONFLICT DO NOTHING;"
WAIT="SELECT charge FROM public._wait_charge_for('triciclo_basico', %s, %s)"
WAIT_DEC=$(printf "$WAIT" "'2026-12-01 22:30:00+00'" "'2026-12-01 22:40:00+00'")   # 18:30 in Cuba (UTC-4)
WAIT_JAN=$(printf "$WAIT" "'2026-01-15 23:30:00+00'" "'2026-01-15 23:40:00+00'")   # 18:30 in Cuba (UTC-5)
WAIT_DEC_AFTERNOON=$(printf "$WAIT" "'2026-12-01 21:30:00+00'" "'2026-12-01 21:40:00+00'")   # 17:30 in Cuba

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 scaffold carries the 20 live prod bodies" "$BODIES" "$LIVE"
val "S1 like prod, postgres owns them and is not a superuser" \
  "SELECT string_agg(DISTINCT pg_get_userbyid(proowner), ',') || '|' || (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres')
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace" "postgres|false"
val "S2 tzdata here, as in prod, still reads Havana as UTC-5 after 2026-11-01" \
  "SELECT (timestamptz '2026-12-01 16:00:00+00' AT TIME ZONE 'America/Havana')::time" "11:00:00"
$P -c "$SEED" >/dev/null

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== the bodies =="
val "B1 the 20 functions have the patched bodies" "$BODIES" "$NEW"
val "B2 no function in public names 'America/Havana' outside cuba_tz" \
  "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%''America/Havana''%' AND proname <> 'cuba_tz'" "0"
val "B3 owners, SECURITY DEFINER and search_path unchanged" \
  "SELECT count(*) FILTER (WHERE pg_get_userbyid(proowner) = 'postgres') || '|' || count(*) FILTER (WHERE prosecdef) || '|' || count(*) FILTER (WHERE proconfig IS NOT NULL)
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname NOT IN ('cuba_tz', 'get_platform_config_numeric')" "20|17|20"
val "B4 cuba_tz is IMMUTABLE and every API role can call it, not PUBLIC" \
  "SELECT p.provolatile::text || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE')
          || has_function_privilege('service_role', p.oid, 'EXECUTE') || '|' || EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
   FROM pg_proc p WHERE p.oid = to_regprocedure('public.cuba_tz(timestamptz)')" "i|truetruetrue|false"
val "B5 no carriage return entered any body" \
  "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%' || chr(13) || '%'" "0"

echo "== Cuba's clock =="
val "C1 cuba_tz on each side of the extension" \
  "SELECT public.cuba_tz('2026-11-01 04:59:59+00') || ',' || public.cuba_tz('2026-11-01 05:00:00+00') || ',' || public.cuba_tz('2027-03-01 12:00:00+00') || ',' || public.cuba_tz('2027-11-07 05:00:00+00')" \
  "America/Havana,America/Santo_Domingo,America/Santo_Domingo,America/Havana"
val "C2 Cuba's wall clock: 2026-12-01 16:00Z is 12:00, 2026-01-15 16:00Z is 11:00" \
  "SELECT (timestamptz '2026-12-01 16:00:00+00' AT TIME ZONE public.cuba_tz('2026-12-01 16:00:00+00'))::time || ',' ||
          (timestamptz '2026-01-15 16:00:00+00' AT TIME ZONE public.cuba_tz('2026-01-15 16:00:00+00'))::time" "12:00:00,11:00:00"

echo "== the waiting charge picks the band of Cuba's clock =="
val "W1 a wait starting 18:30 Cuba time on 2026-12-01 is billed at the 18-24 rate (5 x 30)" "$WAIT_DEC" "150"
val "W2 17:30 Cuba time on the same day stays in 12-18 (5 x 10)" "$WAIT_DEC_AFTERNOON" "50"
val "W3 outside the extension (2026-01-15, UTC-5), 18:30 is still the 18-24 rate" "$WAIT_JAN" "150"

if [ "$MIG" != "none" ]; then
  echo "== a CRLF copy (pasted from Windows into the SQL Editor) =="
  CRLF=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF"
  fresh pr670_crlf
  r=$(apply_err pr670_crlf "$CRLF")
  if [ "$r" = "applied" ]; then ok "X1 the CRLF copy applies"; else ko "X1 the CRLF copy applies" "$r"; fi
  r=$($BIN/psql $CONN -d pr670_crlf -qAt -c "$BODIES" | tr -d '\r')
  if [ "$r" = "$NEW" ]; then ok "X2 and leaves the same 20 bodies"; else ko "X2 and leaves the same 20 bodies" "got $r"; fi
  r=$($BIN/psql $CONN -d pr670_crlf -qAt -c "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%' || chr(13) || '%'" | tr -d '\r')
  if [ "$r" = "0" ]; then ok "X3 with no carriage return in any body"; else ko "X3 with no carriage return in any body" "$r bodies with CR"; fi
  rm -f "$CRLF"

  echo "== negative proofs: the migration's guards abort it =="
  fresh pr670_neg
  $BIN/psql $CONN -d pr670_neg -qAt -c "SET SESSION AUTHORIZATION postgres;
    CREATE OR REPLACE FUNCTION public.get_peak_hours(p_days_back integer DEFAULT 30) RETURNS TABLE(hour integer, avg_rides numeric)
    LANGUAGE plpgsql AS \$f\$ BEGIN RETURN QUERY SELECT 1, 1::numeric WHERE now() AT TIME ZONE 'America/Havana' IS NOT NULL; END \$f\$;" >/dev/null 2>&1
  r=$(apply_err pr670_neg "$MIG")
  case "$r" in *"get_peak_hours(integer) has an unknown body"*) ok "N1 an unknown body aborts the migration";; *) ko "N1 an unknown body aborts the migration" "$r";; esac
  r=$($BIN/psql $CONN -d pr670_neg -qAt -c "SELECT count(*) FROM pg_proc WHERE proname = 'cuba_tz'" | tr -d '\r')
  if [ "$r" = "0" ]; then ok "N2 and leaves nothing behind"; else ko "N2 and leaves nothing behind" "cuba_tz exists"; fi

  fresh pr670_neg
  $BIN/psql $CONN -d pr670_neg -qAt -c "SET SESSION AUTHORIZATION postgres;
    CREATE FUNCTION public.some_new_report() RETURNS date LANGUAGE plpgsql AS \$f\$ BEGIN RETURN (now() AT TIME ZONE 'America/Havana')::date; END \$f\$;" >/dev/null 2>&1
  r=$(apply_err pr670_neg "$MIG")
  case "$r" in *"still using 'America/Havana': public.some_new_report()"*) ok "N3 a function the migration does not know about aborts it";; *) ko "N3 a function the migration does not know about aborts it" "$r";; esac

  fresh pr670_neg
  BROKEN=$(mktemp); sed "s/'2027-11-07 05:00:00+00' THEN 'America\/Santo_Domingo'/'2027-11-08 05:00:00+00' THEN 'America\/Santo_Domingo'/" "$MIG" > "$BROKEN"
  r=$(apply_err pr670_neg "$BROKEN")
  case "$r" in *"cuba_tz boundaries are wrong"*) ok "N4 a wrong boundary in cuba_tz aborts it";; *) ko "N4 a wrong boundary in cuba_tz aborts it" "$r";; esac
  rm -f "$BROKEN"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS pr670_neg" -c "DROP DATABASE IF EXISTS pr670_crlf" >/dev/null 2>&1
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
