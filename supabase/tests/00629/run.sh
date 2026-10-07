#!/usr/bin/env bash
# Rehearsal runner for migration 00629 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00629/run.sh none
#       -> scaffold (users with its live protect trigger, the auth tables a block
#          touches, driver_profiles, admin_actions) + tests (RED: nothing blocks)
#   supabase/tests/00629/run.sh supabase/migrations/00629_admin_block_user_and_level.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# Each test runs as PostgREST would (role authenticated/anon with the JWT subject
# set) inside a transaction that is rolled back.
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00629/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr629
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

SUSI=a0000000-0000-4000-8000-00000000005a   # super_admin
ADA=a0000000-0000-4000-8000-0000000000ad    # admin
ADO=a0000000-0000-4000-8000-0000000000a0    # another admin
CARL=a0000000-0000-4000-8000-00000000000c   # customer with two sessions
DIEGO=a0000000-0000-4000-8000-0000000000d1  # driver, online
DORA=a0000000-0000-4000-8000-0000000000d2   # driver, offline (control)
PLAT=00000000-0000-0000-0000-000000000001   # platform account (super_admin in prod)
ANON=00000000-0000-0000-0000-000000000099   # owner of anonymized rows (00287); banned by 00604
S1=b0000000-0000-4000-8000-000000000001
S2=b0000000-0000-4000-8000-000000000002
S3=b0000000-0000-4000-8000-000000000003
SEED="INSERT INTO public.users (id, role, level) VALUES
  ('$SUSI','super_admin','bronce'),('$ADA','admin','bronce'),('$ADO','admin','bronce'),
  ('$CARL','customer','plata'),('$DIEGO','driver','bronce'),('$DORA','driver','bronce'),('$PLAT','super_admin','bronce'),('$ANON','customer','bronce');
INSERT INTO auth.users (id) SELECT id FROM public.users;
UPDATE auth.users SET banned_until = '2999-12-31 00:00:00+00' WHERE id IN ('$PLAT','$ANON');
INSERT INTO auth.sessions (id, user_id) VALUES ('$S1','$CARL'),('$S2','$CARL'),('$S3','$DIEGO');
INSERT INTO auth.refresh_tokens (token, user_id, session_id) VALUES
  ('t1','$CARL','$S1'),('t2','$CARL','$S2'),('t3','$CARL',NULL),('t4','$DIEGO','$S3'),('t5','$DORA',NULL);
INSERT INTO public.driver_profiles (user_id, is_online, auto_offline_at) VALUES
  ('$DIEGO', true, now() - interval '1 minute'),('$DORA', false, NULL);"

# tx SUB|anon SQL [AFTER] -> SQL as that account (or anon), then AFTER as the test superuser; all rolled back
tx(){ local who
  if [ "$1" = anon ]; then who="SET LOCAL ROLE anon;"
  else who="SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; fi
  printf "BEGIN; %s %s RESET ROLE; %s ROLLBACK;" "$who" "$2" "${3:-}"; }
block(){ printf "SELECT public.admin_set_user_active('%s', %s, %s) IS NOT NULL;" "$1" "$2" "${3:-NULL}"; }
level(){ printf "SELECT public.admin_set_user_level('%s', '%s') IS NOT NULL;" "$1" "$2"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$SEED" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

fresh $DB || { echo "scaffold or seed failed"; exit 2; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('tg_users_protect_admin_fields', 'is_admin', 'is_super_admin', 'current_user_role')" \
  "current_user_role:cb4a7c12d4e21fe2997135833f141e25/103,is_admin:22cb75e91980d512498034cd33e1eda2/285,is_super_admin:5655a4615e92e8b1e323d06c7566b058/105,tg_users_protect_admin_fields:377912e83023297eda4761622a113364/2995"
val "S1 what the panel does today: an admin's direct UPDATE of users.is_active touches 0 rows" \
  "$(tx $ADA "WITH x AS (UPDATE public.users SET is_active = false WHERE id = '$CARL' RETURNING 1) SELECT count(*) FROM x;")" "0"

if [ "$MIG" != none ]; then
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}e" -c "CREATE DATABASE ${DB}e" >/dev/null 2>&1
  $BIN/psql $CONN -d ${DB}e -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1
  r=$(apply_err ${DB}e "$MIG"); [ "$r" = applied ] && ok "M0 applies on an empty database" || ko "M0 applies on an empty database" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}e" >/dev/null 2>&1
  for i in 1 2; do
    r=$(apply_err $DB "$MIG"); [ "$r" = applied ] || { echo "migration failed (run $i): $r"; exit 2; }
  done
  echo "migration applied twice"
fi

echo "== an admin blocks a customer =="
val "A1 Carl is blocked: inactive, banned ~100 years, both sessions and all refresh tokens gone, audited" \
  "$(tx $ADA "$(block $CARL false "'fraude con regalos'")" \
    "SELECT is_active FROM public.users WHERE id = '$CARL';
     SELECT banned_until > now() + interval '99 years' FROM auth.users WHERE id = '$CARL';
     SELECT count(*) FROM auth.sessions WHERE user_id = '$CARL';
     SELECT count(*) FROM auth.refresh_tokens WHERE user_id = '$CARL';
     SELECT admin_id || '|' || action || '|' || target_type || '|' || target_id || '|' || reason FROM public.admin_actions;")" \
  "t;f;t;0;0;$ADA|block_user|user|$CARL|fraude con regalos"
val "A2 the call reports how many sessions it closed" \
  "$(tx $ADA "SELECT public.admin_set_user_active('$CARL', false, 'x y z')->>'sessions_closed';")" "2"
val "A3 other accounts keep their sessions and tokens" \
  "$(tx $ADA "$(block $CARL false "'motivo'")" "SELECT count(*) FROM auth.sessions; SELECT count(*) FROM auth.refresh_tokens;")" "t;1;2"

echo "== blocking a driver takes them offline and keeps them there =="
val "D1 Diego is offline and the auto-offline mark is cleared, so the heartbeat cannot revive him" \
  "$(tx $ADA "$(block $DIEGO false "'motivo'")" "SELECT is_online, auto_offline_at IS NULL FROM public.driver_profiles WHERE user_id = '$DIEGO';")" "t;f|t"
val "D2 a blocked driver who still holds an access token cannot go back online" \
  "$(tx $ADA "$(block $DIEGO false "'motivo'") RESET ROLE; SET LOCAL request.jwt.claim.sub = '$DIEGO'; SET LOCAL ROLE authenticated;
     UPDATE public.driver_profiles SET is_online = true WHERE user_id = '$DIEGO';" "SELECT is_online FROM public.driver_profiles WHERE user_id = '$DIEGO';")" "t;f"
val "D3 nor through a server-side write without a JWT (heartbeat, cron)" \
  "$(tx $ADA "$(block $DIEGO false "'motivo'")" "UPDATE public.driver_profiles SET is_online = true WHERE user_id = '$DIEGO'; SELECT is_online FROM public.driver_profiles WHERE user_id = '$DIEGO';")" "t;f"
val "D4 an active driver still goes online" \
  "$(tx $DORA "UPDATE public.driver_profiles SET is_online = true WHERE user_id = '$DORA';" "SELECT is_online FROM public.driver_profiles WHERE user_id = '$DORA';")" "t"
val "D5 unblocking lifts the ban and lets him go online again" \
  "$(tx $ADA "$(block $DIEGO false "'motivo'") $(block $DIEGO true)" \
    "SELECT is_active, banned_until IS NULL FROM public.users u JOIN auth.users a USING (id) WHERE u.id = '$DIEGO';
     UPDATE public.driver_profiles SET is_online = true WHERE user_id = '$DIEGO'; SELECT is_online FROM public.driver_profiles WHERE user_id = '$DIEGO';
     SELECT string_agg(action, ',' ORDER BY created_at, action) FROM public.admin_actions;")" \
  "t;t;t|t;t;block_user,unblock_user"

echo "== who may block whom =="
err "R1 a customer cannot"                       "$(tx $CARL "$(block $DIEGO false "'x'")")" "42501|administrador"
err "R2 anon cannot even call it"                 "$(tx anon "$(block $DIEGO false "'x'")")" "permission denied"
err "R3 an admin cannot block themselves"         "$(tx $ADA "$(block $ADA false "'x'")")" "propia cuenta"
err "R4 an admin cannot block another admin"      "$(tx $ADA "$(block $ADO false "'x'")")" "super admin"
val "R5 a super_admin can"                        "$(tx $SUSI "$(block $ADO false "'x'")" "SELECT is_active FROM public.users WHERE id = '$ADO';")" "t;f"
err "R6 nobody blocks the platform account"       "$(tx $SUSI "$(block $PLAT false "'x'")")" "sistema"
err "R6b nobody unblocks the anonymized-data account (00604 keeps it banned)" "$(tx $SUSI "$(block $ANON true)")" "sistema"
err "R7 a block needs a reason"                   "$(tx $ADA "$(block $CARL false "'   '")")" "motivo"
err "R8 an unknown account"                       "$(tx $ADA "$(block c0000000-0000-4000-8000-000000000000 false "'x'")")" "no existe"

echo "== the level override =="
val "L1 a super_admin changes the level, audited with the change" \
  "$(tx $SUSI "$(level $CARL oro)" "SELECT level FROM public.users WHERE id = '$CARL'; SELECT action || '|' || reason FROM public.admin_actions;")" "t;oro;set_user_level|plata → oro"
err "L2 an admin cannot (the protect trigger keeps level for super_admins)" "$(tx $ADA "$(level $CARL oro)")" "super admin"
err "L3 a customer cannot"                        "$(tx $CARL "$(level $CARL diamante)")" "super admin"

echo "== grants =="
val "G1 anon cannot execute either function; authenticated can" \
  "SELECT has_function_privilege('anon','public.admin_set_user_active(uuid,boolean,text)','EXECUTE'),
          has_function_privilege('anon','public.admin_set_user_level(uuid,public.user_level)','EXECUTE'),
          has_function_privilege('authenticated','public.admin_set_user_active(uuid,boolean,text)','EXECUTE'),
          has_function_privilege('authenticated','public.admin_set_user_level(uuid,public.user_level)','EXECUTE')" "f|f|t|t"

if [ "$MIG" = none ]; then
  echo "(the A, D, R, L and G tests check what 00629 adds: they fail on the baseline)"
else
  echo "== negative proofs =="
  T=$(mktemp -d)
  "$PY" - "$MIG" "$T" <<'PYEOF'
import sys
src, out = sys.argv[1:3]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
def variant(name, *pairs):
    v = s
    for old, new in pairs:
        assert v.count(old) == 1, (name, old)
        v = v.replace(old, new)
    open(f'{out}/{name}.sql', 'w', encoding='utf-8').write(v)
# Without its REVOKE the block keeps Postgres' default EXECUTE for PUBLIC (the scaffold, like a
# migration run as supabase_admin, does not narrow defaults the way postgres' own default ACL does).
variant('public_can_block', ("REVOKE ALL ON FUNCTION public.admin_set_user_active(uuid, boolean, text) FROM PUBLIC, anon;\n", ""))
variant('anon_can_set_level', ("GRANT EXECUTE ON FUNCTION public.admin_set_user_level(uuid, public.user_level) TO authenticated, service_role;",
                               "GRANT EXECUTE ON FUNCTION public.admin_set_user_level(uuid, public.user_level) TO anon, authenticated, service_role;"))
variant('no_guard_trigger', ("CREATE TRIGGER trg_driver_profiles_inactive_stays_offline", "CREATE TRIGGER trg_unrelated_name"),
        ("DROP TRIGGER IF EXISTS trg_driver_profiles_inactive_stays_offline ON public.driver_profiles;", "DROP TRIGGER IF EXISTS trg_unrelated_name ON public.driver_profiles;"))
PYEOF
  refuses(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2"); echo "$r" | grep -q "$3" && ok "$1" || ko "$1" "$r"; }
  refuses "N1 the migration refuses to finish if PUBLIC can execute the block" "$T/public_can_block.sql" "anon or PUBLIC can execute"
  refuses "N1b the migration refuses to finish if anon can set levels" "$T/anon_can_set_level.sql" "anon or PUBLIC can execute"
  refuses "N2 the migration refuses to finish without the stay-offline trigger" "$T/no_guard_trigger.sql" "stay-offline trigger"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = 0 ]
