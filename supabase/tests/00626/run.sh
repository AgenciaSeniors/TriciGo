#!/usr/bin/env bash
# Rehearsal runner for migration 00626 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00626/run.sh none
#       -> scaffold (realtime.messages, its live policies, is_ride_party) + tests (RED)
#   supabase/tests/00626/run.sh supabase/migrations/00626_ride_typing_private_channel.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# Each test does what Realtime does to authorize a private join: in a rolled-back
# transaction it sets the user's JWT subject and realtime.topic, switches to the
# authenticated role and reads from (join) or inserts into (send, track) realtime.messages.
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00626/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr626
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

RITA=00000000-0000-4000-8000-0000000000a1    # rider of R (and of Q, still searching)
SOFIA=00000000-0000-4000-8000-0000000000a2   # rider of S
DAVID=00000000-0000-4000-8000-0000000000da   # driver of R
DORA=00000000-0000-4000-8000-0000000000db    # driver of S
OMAR=00000000-0000-4000-8000-0000000000ff    # no ride at all
R=aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa
S=bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb
Q=cccccccc-3333-4333-8333-cccccccccccc
DENIED="new row violates row-level security policy"

# as SUB|anon TOPIC SQL -> SQL as the authenticated (or anon) role on that topic, rolled back
as(){ local who
  if [ "$1" = anon ]; then who="SET LOCAL ROLE anon;"
  else who="SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; fi
  printf "BEGIN; SET LOCAL realtime.topic = '%s'; %s %s ROLLBACK;" "$2" "$who" "$3"; }
send(){ echo "INSERT INTO realtime.messages (topic, extension, event, private) VALUES (realtime.topic(), '${1:-broadcast}', 'typing', true) RETURNING 'ok';"; }
# join: a row on the topic exists (written by the superuser), can the user see it?
join(){ local who
  if [ "$1" = anon ]; then who="SET LOCAL ROLE anon;"
  else who="SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; fi
  printf "BEGIN; SET LOCAL realtime.topic = '%s';
    INSERT INTO realtime.messages (topic, extension, private) VALUES ('%s', '%s', true);
    %s SELECT count(*) FROM realtime.messages WHERE extension = '%s'; ROLLBACK;" "$2" "$2" "${3:-broadcast}" "$who" "${3:-broadcast}"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

fresh $DB
r=$(run $DB "SELECT count(*) FROM pg_policy WHERE polrelid = 'realtime.messages'::regclass")
[ "$r" = 4 ] || { echo "scaffold failed ($r policies)"; exit 2; }

if [ "$MIG" != none ]; then
  for i in 1 2; do
    r=$(apply_err $DB "$MIG"); [ "$r" = applied ] || { echo "migration failed (run $i): $r"; exit 2; }
  done
  echo "migration applied twice"
fi

echo "== the ride's parties can use typing:<ride> =="
val "W1 the rider sends typing"             "$(as $RITA "typing:$R" "$(send)")" "ok"
val "W2 the driver sends typing"            "$(as $DAVID "typing:$R" "$(send)")" "ok"
val "W3 the rider announces presence"       "$(as $RITA "typing:$R" "$(send presence)")" "ok"
val "W4 the driver announces presence"      "$(as $DAVID "typing:$R" "$(send presence)")" "ok"
val "W5 a rider on a ride with no driver yet" "$(as $RITA "typing:$Q" "$(send)")" "ok"
val "R1 the rider joins and receives typing" "$(join $RITA "typing:$R")" "1"
val "R2 the driver joins and sees presence"  "$(join $DAVID "typing:$R" presence)" "1"

echo "== nobody else can =="
err "D1 a user with no ride cannot send"            "$(as $OMAR "typing:$R" "$(send)")" "$DENIED"
err "D2 the rider of another ride cannot send"      "$(as $SOFIA "typing:$R" "$(send)")" "$DENIED"
err "D3 the driver of another ride cannot send"     "$(as $DORA "typing:$R" "$(send)")" "$DENIED"
err "D4 anon cannot send"                           "$(as anon "typing:$R" "$(send)")" "$DENIED"
err "D5 a party cannot use another extension"       "$(as $RITA "typing:$R" "$(send postgres_changes)")" "$DENIED"
err "D6 a longer topic is not the ride's"           "$(as $RITA "typing:$R:x" "$(send)")" "$DENIED"
err "D7 a topic that is not a ride id"              "$(as $RITA "typing:not-a-ride" "$(send)")" "$DENIED"
val "D8 a user with no ride sees nothing"           "$(join $OMAR "typing:$R")" "0"
val "D9 the driver of another ride sees no presence" "$(join $DORA "typing:$R" presence)" "0"
val "D10 anon sees nothing"                         "$(join anon "typing:$R")" "0"

echo "== the other private topics are unchanged =="
val "X1 the rider still sends her location"         "$(as $RITA "rider-location:$R" "$(send)")" "ok"
err "X2 a stranger still cannot"                    "$(as $OMAR "rider-location:$R" "$(send)")" "$DENIED"
err "X3 typing presence does not open rider-location presence" "$(as $RITA "rider-location:$R" "$(send presence)")" "$DENIED"

if [ "$MIG" = none ]; then
  echo "(the W and R tests check what 00626 adds: they fail on the baseline)"
else
  val "E1 six policies on realtime.messages" \
    "SELECT count(*) FROM pg_policy WHERE polrelid = 'realtime.messages'::regclass" "6"

  echo "== negative proofs =="
  T=$(mktemp -d)
  "$PY" - "$MIG" "$T" <<'PYEOF'
import sys
src, out = sys.argv[1:3]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
i = s.index('-- Assert the end state.'); j = s.index('RESET lock_timeout;')
no_assert = s[:i] + s[j:]
def variant(name, base, *pairs):
    v = base
    for old, new in pairs:
        n = v.count(old); assert n >= 1, (name, old)
        v2 = v.replace(old, new, 1); assert v2 != v, name; v = v2
    open(f'{out}/{name}.sql', 'w', encoding='utf-8').write(v)
variant('wrong_offset_read', s, ("substring(realtime.topic() FROM 8)", "substring(realtime.topic() FROM 9)"))
variant('write_for_anon', s, ("  FOR INSERT TO authenticated\n", "  FOR INSERT TO anon, authenticated\n"))
variant('wrong_offset_no_assert', no_assert, ("substring(realtime.topic() FROM 8)", "substring(realtime.topic() FROM 9)"),
        ("substring(realtime.topic() FROM 8)", "substring(realtime.topic() FROM 9)"))
PYEOF
  refuses(){ local r; fresh ${DB}g; [ -n "${4:-}" ] && run ${DB}g "$4" >/dev/null; r=$(apply_err ${DB}g "$2")
    echo "$r" | grep -q "$3" && ok "$1" || ko "$1" "$r"; }
  refuses "N1 the migration refuses to finish with a wrong read policy" "$T/wrong_offset_read.sql" \
    "ride_typing_realtime_read is missing or not the 00626 policy"
  refuses "N2 the migration refuses to finish with a write policy for anon" "$T/write_for_anon.sql" \
    "ride_typing_realtime_write is missing or not the 00626 policy"
  refuses "N3 the migration refuses to finish when RLS is off" "$MIG" "RLS is off on realtime.messages" \
    "ALTER TABLE realtime.messages DISABLE ROW LEVEL SECURITY"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/wrong_offset_no_assert.sql")
  if [ "$r" = applied ]; then
    r=$(run ${DB}g "$(as $RITA "typing:$R" "$(send)")")
    echo "$r" | grep -q "ok" && ko "N4 a wrong offset fails W1 (so W1 tests it)" "got [$r]" \
      || ok "N4 a wrong offset fails W1 (so W1 tests it)"
  else ko "N4" "apply: $r"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = 0 ]
