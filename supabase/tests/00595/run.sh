#!/usr/bin/env bash
# Rehearsal runner for migration 00595 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00595/run.sh none
#       -> scaffold + tests (RED: a signup that matches 2+ pending invitations aborts)
#   supabase/tests/00595/run.sh supabase/migrations/00595_fix_auto_link_fleet_member_on_signup.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# PG_BIN and PYTHON override the defaults, e.g. for a portable Postgres on Windows, where Python is `python`.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PY="${PYTHON:-python3}"
DB=pr595
# pg ARGS -> psql on the local cluster. P ARGS -> the same on $DB, quiet, stopping at the first error.
# Functions, not strings, so a PG_BIN with spaces (C:/Program Files/...) is not split.
pg(){ "$BIN/psql" -h 127.0.0.1 -p 5433 -U pgtest "$@"; }
P(){ pg -d "$DB" -qAt -v ON_ERROR_STOP=1 "$@"; }
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# q SQL -> run the statements and print their rows (CRs dropped: psql on Windows ends lines with \r\n)
q(){ P -c "$1" 2>&1 | tr -d '\r'; }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$(q "$2" | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }

U1=11111111-1111-4111-8111-111111111111   # the person signing up
U2=22222222-2222-4222-8222-222222222222   # someone who signed up earlier
FN="'public.auto_link_fleet_member_on_signup()'::regprocedure"

# seed INVITATIONS -> SQL that empties the tables, creates fleets 1-7 and user U2, then adds INVITATIONS
seed(){ printf "TRUNCATE public.fleet_members, public.users, public.driver_fleets;
INSERT INTO public.driver_fleets (id, name)
  SELECT ('00000000-0000-4000-8000-00000000000' || g)::uuid, 'fleet ' || g FROM generate_series(1, 7) g;
INSERT INTO public.users (id, phone) VALUES ('%s', '+5359999999');
%s" "$U2" "$1"; }
# inv FLEET PHONE STATUS [DRIVER] -> one invitation. Inserted as the table owner with no JWT, so the
# protect trigger keeps status and driver_id as given.
inv(){ printf "INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status, driver_id)
  VALUES ('00000000-0000-4000-8000-00000000000%s', 'Driver', '%s', '%s', %s);\n" "$1" "$2" "$3" "${4:-NULL}"; }
# signup PHONE -> the row handle_new_user() inserts for a new auth user (no JWT: auth.uid() is NULL)
signup(){ printf "INSERT INTO public.users (id, phone) VALUES ('%s', %s);\n" "$U1" "$1"; }
# self_signup PHONE -> a signed-in user inserting their own row (policy users_insert_own)
self_signup(){ printf "SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '%s';
INSERT INTO public.users (id, phone) VALUES ('%s', %s); RESET ROLE;\n" "$U1" "$U1" "$1"; }
# RESULT -> "is U1 in users;invitations linked to U1/all invitations"
RESULT="SELECT count(*) FROM public.users WHERE id = '$U1';
SELECT count(*) FILTER (WHERE driver_id = '$U1' AND status = 'active' AND signed_up_at IS NOT NULL) || '/' || count(*) FROM public.fleet_members;"
# ROWS -> every invitation as fleet:status:driver:signed_up
ROWS="SELECT string_agg(right(fleet_id::text, 1) || ':' || status || ':'
  || CASE driver_id WHEN '$U1' THEN 'U1' WHEN '$U2' THEN 'U2' ELSE '-' END || ':'
  || CASE WHEN signed_up_at IS NULL THEN 'n' ELSE 's' END, ',' ORDER BY fleet_id, driver_phone) FROM public.fleet_members;"
# FINGERPRINT -> md5 of every row in users and fleet_members
FINGERPRINT="SELECT md5(coalesce((SELECT string_agg(concat_ws('|', id, fleet_id, driver_id, driver_phone, status, signed_up_at), ',' ORDER BY id) FROM public.fleet_members), '')
  || '#' || coalesce((SELECT string_agg(concat_ws('|', id, phone), ',' ORDER BY id) FROM public.users), ''));"

echo "== reset database =="
OUT=$(pg -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" 2>&1) \
  || { echo "$OUT"; echo "could not recreate $DB: is the cluster up on 127.0.0.1:5433, and is nothing connected to $DB?"; exit 1; }
OUT=$(P -f "$DIR/scaffold.sql" 2>&1) || { echo "$OUT"; echo "scaffold failed"; exit 1; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || '=' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('auto_link_fleet_member_on_signup', 'tg_fleet_members_protect', '_normalize_cuban_phone', 'tg_users_normalize_phone')" \
  "_normalize_cuban_phone=9f5227a3c108fa42f6aacdf01fb0ad86/451,auto_link_fleet_member_on_signup=0b74fd48e33257ba39bd719376d1a732/494,tg_fleet_members_protect=8b0d07aff7ab33142bfcec29304c01ed/674,tg_users_normalize_phone=c0491b42cf36767c3911fb8a3fda9f04/147"
val "S1 scaffold carries the prod event triggers that fire on the self-test's temp objects" \
  "SELECT string_agg(e.evtname || '=' || md5(p.prosrc) || '/' || length(p.prosrc), ',' ORDER BY e.evtname COLLATE \"C\")
   FROM pg_event_trigger e JOIN pg_proc p ON p.oid = e.evtfoid" \
  "ensure_rls=99be20677b456ea8d3be47bdd44fb369/953,issue_pg_graphql_access=dd3f3e2bb94cff45ef24b9cecb6af1c8/1357,pgrst_ddl_watch=7f27b8118fea5c88b0164331292859e3/729"

if [ "$MIG" != "none" ]; then
  # Baseline rows first. Two are invitations for the phone the migration's self-test uses: if its
  # temporary copy of the function ever reached the real table, it would try to link them to a user
  # that does not exist, and the FK would fail the apply.
  OUT=$(P -c "$(seed "$(inv 1 '+5351230595' pending_signup) $(inv 2 '51230595' approved) $(inv 3 '+5358888888' pending_signup)")
    CREATE SCHEMA rehearsal;
    CREATE TABLE rehearsal.live_src AS SELECT prosrc FROM pg_proc WHERE oid = $FN;" 2>&1) || { echo "$OUT"; echo "baseline failed"; exit 1; }
  BEFORE=$(q "$FINGERPRINT")
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, search_path = '') =="
  OUT=$(P -1 -c "SET search_path = ''" -f "$MIG" 2>&1) || { echo "$OUT"; echo "migration failed"; exit 1; }
  if echo "$OUT" | grep -q "00595: verified"; then ok "M0 the migration's self-test ran and passed"
  else ko "M0 the migration's self-test ran and passed" "no NOTICE in [$OUT]"; fi
  echo "== apply migration (2nd, idempotency, autocommit, search_path = '') =="
  OUT=$(P -c "SET search_path = ''" -f "$MIG" 2>&1) || { echo "$OUT"; echo "migration NOT idempotent"; exit 1; }
  val "M1 the migration leaves every row exactly as it was" "$FINGERPRINT" "$BEFORE"
  val "M2 the new body is the live one minus the RETURNING ... INTO and its variable, nothing else" \
    "SELECT (md5(p.prosrc) = md5(replace(replace(l.prosrc, E'DECLARE\n  v_member_id uuid;\n', ''), E'\n  RETURNING id INTO v_member_id', '')))
       || '|' || (length(l.prosrc) - length(p.prosrc))
     FROM pg_proc p, rehearsal.live_src l WHERE p.oid = $FN" "true|60"
fi

echo "== tests =="
# A. behaviour: signups against the invitation shapes that break the live body, plus the controls
val "A1 two fleets invited the same person, in two formats: the signup links both" \
  "$(seed "$(inv 1 '+5351234567' pending_signup) $(inv 2 '51234567' approved)") $(signup "'5351234567'") $RESULT" "1;2/2"
val "A2 one fleet holds the same number in two formats: the signup links both" \
  "$(seed "$(inv 1 '+5351234567' pending_signup) $(inv 1 '51234567' pending_signup)") $(signup "'+5351234567'") $RESULT" "1;2/2"
val "A3 same when the signed-in user inserts their own row: the trusted flag gets both past the protect trigger" \
  "$(seed "$(inv 1 '+5351234567' approved) $(inv 2 '+53 5123-4567' pending_signup)") $(self_signup "'51234567'") $RESULT" "1;2/2"
val "A4 one invitation (the case the live body survives): linked" \
  "$(seed "$(inv 1 '+5351234567' pending_signup)") $(signup "'5351234567'") $RESULT" "1;1/1"
val "A5 one invitation, signed-in self-insert: linked, and not reverted by the protect trigger" \
  "$(seed "$(inv 1 '+5351234567' approved)") $(self_signup "'+5351234567'") $RESULT" "1;1/1"
val "A6 no invitation for this phone: the signup goes through and nothing is linked" \
  "$(seed "$(inv 1 '+5358888888' pending_signup)") $(signup "'5351234567'") $RESULT" "1;0/1"
val "A7 only approved/pending_signup invitations without a driver change; every other row stays as it was" \
  "$(seed "$(inv 1 '+5351234567' pending_signup) $(inv 2 '51234567' approved) $(inv 3 '+5351234567' pending_review)
           $(inv 4 '5351234567' rejected) $(inv 5 '+53 5123 4567' inactive) $(inv 6 '+5351234567' approved "'$U2'")
           $(inv 7 '+5358888888' pending_signup)") $(signup "'5351234567'") $ROWS" \
  "1:active:U1:s,2:active:U1:s,3:pending_review:-:n,4:rejected:-:n,5:inactive:-:n,6:approved:U2:n,7:pending_signup:-:n"
val "A8 no phone (email or OAuth signup): the guard returns early and nothing is linked" \
  "$(seed "$(inv 1 '+5351234567' pending_signup) $(inv 2 '51234567' approved)") $(signup NULL) $RESULT" "1;0/2"

# B. contract: same function, same privileges, same trigger as before
val "B1 same signature and return type" \
  "SELECT pg_get_function_identity_arguments($FN) || '|' || pg_get_function_result($FN)" "|trigger"
val "B2 still plpgsql and SECURITY DEFINER, with the same pinned search_path" \
  "SELECT l.lanname || '|' || p.prosecdef || '|' || array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = $FN" \
  "plpgsql|true|search_path=public, pg_temp"
val "B3 EXECUTE: anon no, authenticated no, service_role yes" \
  "SELECT has_function_privilege('anon', $FN, 'EXECUTE') || '|' || has_function_privilege('authenticated', $FN, 'EXECUTE')
     || '|' || has_function_privilege('service_role', $FN, 'EXECUTE')" "false|false|true"
val "B4 the trigger on public.users is unchanged" \
  "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'auto_link_fleet_member_on_signup'" \
  "CREATE TRIGGER auto_link_fleet_member_on_signup AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION auto_link_fleet_member_on_signup()"
val "B5 no RETURNING left in the body" "SELECT prosrc !~* 'RETURNING' FROM pg_proc WHERE oid = $FN" "t"

# N. negative proofs: put the bug back into copies of the migration; its self-test must abort both
if [ "$MIG" != "none" ]; then
  BUGGY="$(mktemp --suffix=.sql)"; SWALLOW="$(mktemp --suffix=.sql)"
  if $PY - "$MIG" "$BUGGY" "$SWALLOW" <<'PYEOF'
import hashlib, sys
src = open(sys.argv[1], encoding="utf-8", newline="").read()
def once(s, old, new):
    assert s.count(old) == 1, f"expected {old!r} once, found {s.count(old)}"
    return s.replace(old, new)
# 1. Put the bug back: the variable and the RETURNING ... INTO.
buggy = once(src, "AS $function$\nBEGIN\n", "AS $function$\nDECLARE\n  v_member_id uuid;\nBEGIN\n")
buggy = once(buggy, "    AND driver_id IS NULL;\n", "    AND driver_id IS NULL\n  RETURNING id INTO v_member_id;\n")
# What that restores must be, byte for byte, the body prod runs today.
body = buggy.split("AS $function$", 1)[1].split("$function$;", 1)[0]
assert hashlib.md5(body.encode("utf-8")).hexdigest() == "0b74fd48e33257ba39bd719376d1a732", "restored body is not prod's"
# 2. A plausible wrong fix: keep the RETURNING ... INTO and swallow its error.
#    Signups go through again, but nothing gets linked.
swallow = once(buggy, "  RETURN NEW;\nEND;\n$function$;", "  RETURN NEW;\nEXCEPTION WHEN too_many_rows THEN\n  RETURN NEW;\nEND;\n$function$;")
open(sys.argv[2], "w", encoding="utf-8", newline="").write(buggy)
open(sys.argv[3], "w", encoding="utf-8", newline="").write(swallow)
PYEOF
  then
    ok "N0 built two broken copies of the migration; the first restores prod's body byte for byte"
    # N ARGS -> psql on the scratch database the negative proofs use
    N(){ pg -d "${DB}n" -qAt -v ON_ERROR_STOP=1 "$@"; }
    # neg NAME FILE PATTERN -> on a fresh scaffold, applying FILE must abort with an error matching PATTERN
    neg(){ local out
      if ! pg -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}n" -c "CREATE DATABASE ${DB}n" >/dev/null 2>&1; then
        ko "$1" "could not recreate ${DB}n"; return; fi
      N -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { ko "$1" "the scaffold failed on ${DB}n"; return; }
      if out=$(N -1 -c "SET search_path = ''" -f "$2" 2>&1); then ko "$1" "the migration went through"
      elif echo "$out" | grep -q "$3"; then ok "$1"
      else ko "$1" "wrong error: $(echo "$out" | tr -d '\r' | grep -m1 ERROR)"; fi; }
    neg "N1 the self-test aborts a migration that still carries the bug" "$BUGGY" "more than one row"
    neg "N2 the self-test aborts a 'fix' that swallows the error and links nothing" "$SWALLOW" "linked 0 of 2"
  else
    ko "N0 built two broken copies of the migration" "the replacements did not apply; N1 and N2 skipped"
  fi
  rm -f "$BUGGY" "$SWALLOW"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
