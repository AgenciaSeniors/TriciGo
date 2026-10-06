#!/bin/bash
# TriciGo — test suite for the Supabase availability watchdog.
#
# Exercises the real script against a local mock of PostgREST / the health-check
# EF / Resend / D7, so the alert path is proven rather than assumed. Includes
# NEGATIVE cases (broken channel, no channel, missing config): a verification
# that has never been seen to fail is not a verification.
#
# Usage:  ops/supabase-watchdog/tests/run.sh
# Needs:  bash, curl, python3 (or python). Touches nothing outside its temp dir.
# Runs on Linux and on Git Bash for Windows: the mock gets its paths through the
# environment, converted with cygpath where bash and python disagree on paths.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WD="$HERE/../healthcheck.sh"
WORK="$(mktemp -d)"; PORT="${WD_TEST_PORT:-8799}"
MODE="$WORK/wd_mode"; EMAILS="$WORK/wd_email.jsonl"; SMSS="$WORK/wd_sms.jsonl"
PY="$(command -v python3 || command -v python || true)"
[[ -n "$PY" ]] || { echo "FATAL: python3/python not found"; exit 1; }
topy() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
pyread() { "$PY" -c "$1" "$(topy "$2")"; }   # $1 = python code reading sys.argv[1]
cleanup() { [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

pass=0; fail=0
chk() { if [[ "$2" == "$3" ]]; then echo "  ok    $1"; pass=$((pass+1));
        else echo "  FAIL  $1 (want='$3' got='$2')"; fail=$((fail+1)); fi; }

bash -n "$WD" || { echo "FATAL: watchdog has a syntax error"; exit 1; }
# A stale mock from an earlier run would answer instead of this one.
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"; then
  echo "FATAL: port $PORT already in use (stale mock?). Stop it or set WD_TEST_PORT."; exit 1
fi

# On Git Bash for Windows every probe spawns a native curl and costs several
# hundred ms, so a healthy answer would already count as "slow" at 300 ms.
if command -v cygpath >/dev/null 2>&1; then SLOW_MS_T=2500; SLOW_SLEEP=3.5; else SLOW_MS_T=300; SLOW_SLEEP=0.6; fi

echo ok > "$MODE"
WD_MODE_FILE="$(topy "$MODE")" WD_OUT_DIR="$(topy "$WORK")" WD_TEST_PORT="$PORT" WD_SLOW_SLEEP="$SLOW_SLEEP" \
  "$PY" "$(topy "$HERE/mock.py")" & MOCK_PID=$!
for _ in $(seq 1 25); do
  curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/rest/v1/platform_config" && break
  sleep 0.2
done

cat > "$WORK/wd.env" <<ENV
SUPABASE_URL=http://127.0.0.1:$PORT
SUPABASE_PUBLISHABLE_KEY=sb_publishable_test
RESEND_API_URL=http://127.0.0.1:$PORT/emails
D7_API_URL=http://127.0.0.1:$PORT/messages/v1/send
RESEND_API_KEY=re_test
ALERT_EMAIL_TO=soporte@tricigo.com, owner@tricigo.com
ALERT_EMAIL_FROM=noreply@tricigo.com
D7_API_TOKEN=d7_test
ALERT_SMS_TO=+5355512345
PROBE_TIMEOUT_S=5
SLOW_MS=$SLOW_MS_T
FAILS_BEFORE_ALERT=2
OKS_BEFORE_RECOVERY=2
ENV
export SUPABASE_HEALTH_CONFIG="$WORK/wd.env" SUPABASE_HEALTH_STATE="$WORK/wd.state"
run() { echo "$1" > "$MODE"; bash "$WD" 2>&1; }

# ALERT_EMAIL_TO above is intentionally unquoted WITH a space after the comma:
# a sourced env file silently loses the variable entirely (bash reads it as a
# command prefix) and every email alert is skipped. Regression guard.
echo "A. selftest, multi-recipient unquoted config"
out=$(bash "$WD" --selftest 2>&1); rc=$?
chk "exit 0"                 "$rc" "0"
chk "honest verdict"         "$(grep -c 'selftest: OK' <<<"$out")" "1"
chk "email delivered"        "$(wc -l < "$EMAILS")" "1"
chk "both recipients parsed" "$(pyread "import json,sys;print(len(json.loads(open(sys.argv[1]).readline())['to']))" "$EMAILS")" "2"
chk "payload is valid JSON"  "$(pyread "import json,sys;json.loads(open(sys.argv[1]).readline());print('y')" "$EMAILS")" "y"
chk "sms delivered"          "$(wc -l < "$SMSS")" "1"

echo "B. negative: broken alert endpoint must FAIL the selftest"
sed -e "s#^RESEND_API_URL=.*#RESEND_API_URL=http://127.0.0.1:$PORT/nope#" \
    -e "s#^D7_API_URL=.*#D7_API_URL=http://127.0.0.1:$PORT/nope#" "$WORK/wd.env" > "$WORK/broken.env"
out=$(SUPABASE_HEALTH_CONFIG="$WORK/broken.env" bash "$WD" --selftest 2>&1); rc=$?
chk "exit 1"        "$rc" "1"
chk "says FALLO"    "$(grep -c 'selftest: FALLO' <<<"$out")" "1"

echo "C. negative: no channel at all must be loud"
grep -v 'RESEND_API_KEY\|D7_API_TOKEN' "$WORK/wd.env" > "$WORK/nochan.env"
chk "shouts CONFIG ERROR" \
  "$(SUPABASE_HEALTH_CONFIG="$WORK/nochan.env" bash "$WD" 2>&1 | grep -c 'CONFIG ERROR: no alert channel')" "1"

echo "D. negative: missing config exits clean (never wedges the timer)"
out=$(SUPABASE_HEALTH_CONFIG=/nonexistent bash "$WD" 2>&1); rc=$?
chk "exit 0 + explains" "$rc:$(grep -c 'missing or unreadable' <<<"$out")" "0:1"

echo "E. state machine: debounce, anti-flood, confirmed recovery"
rm -f "$SUPABASE_HEALTH_STATE" "$EMAILS"
chk "healthy: silent"        "$(run ok   | grep -c 'ALERT SENT')" "0"
chk "fail 1: debounced"      "$(run down | grep -c 'ALERT SENT')" "0"
chk "fail 2: ALERT"          "$(run down | grep -c 'ALERT SENT')" "1"
chk "fail 3: no repeat"      "$(run down | grep -c 'ALERT SENT')" "0"
chk "ok 1: not yet recovered" "$(run ok  | grep -c 'RECOVERY SENT')" "0"
chk "ok 2: RECOVERY"         "$(run ok   | grep -c 'RECOVERY SENT')" "1"
chk "exactly 2 emails"       "$(wc -l < "$EMAILS")" "2"
chk "alert carries onset"    "$(pyread "import json,sys;print('y' if 'Desde:' in json.loads(open(sys.argv[1]).readline())['text'] else 'n')" "$EMAILS")" "y"
# Newlines must survive as \n, not be stripped: a human reads this mid-outage.
chk "body is multi-line"     "$(pyread "import json,sys;print('y' if json.loads(open(sys.argv[1]).readline())['text'].count(chr(10))>10 else 'n')" "$EMAILS")" "y"

echo "F. classification"
rm -f "$SUPABASE_HEALTH_STATE"; chk "slow counts as outage" "$(run slow | grep -c 'state=slow')" "1"
rm -f "$SUPABASE_HEALTH_STATE"; echo hang > "$MODE"
chk "timeout counts as outage" "$(PROBE_TIMEOUT_S=2 bash "$WD" 2>&1 | grep -c 'state=down')" "1"

echo "G. a debounced blip must not leave a stale onset behind"
# One failed probe that recovers before FAILS_BEFORE_ALERT is not an incident.
# If its onset survives, the NEXT real outage — maybe days later — is reported
# as "Desde: <that old blip>", which sends whoever is on call chasing the wrong window.
onset() { sed -n 's/^down_since="\(.*\)"$/\1/p' "$SUPABASE_HEALTH_STATE"; }
rm -f "$SUPABASE_HEALTH_STATE" "$EMAILS"
run down >/dev/null; onset1="$(onset)"
run ok   >/dev/null
chk "recovered blip clears the onset" "$(onset)" ""
sleep 1.2   # onsets have one-second resolution
run down >/dev/null; onset2="$(onset)"
chk "new incident gets a new onset"  "$([[ -n "$onset2" && "$onset2" != "$onset1" ]] && echo y || echo n)" "y"
run down >/dev/null
chk "alert reports the new onset"    "$(pyread "import json,sys;t=json.loads(open(sys.argv[1]).readline())['text'];print('y' if '$onset2' in t and '$onset1' not in t else 'n')" "$EMAILS")" "y"

echo ok > "$MODE"
echo; echo "===== $pass passed · $fail failed ====="
[[ "$fail" == "0" ]]
