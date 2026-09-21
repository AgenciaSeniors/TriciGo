#!/bin/bash
# TriciGo — test suite for the Supabase availability watchdog.
#
# Exercises the real script against a local mock of PostgREST / the health-check
# EF / Resend / D7, so the alert path is proven rather than assumed. Includes
# NEGATIVE cases (broken channel, no channel, missing config): a verification
# that has never been seen to fail is not a verification.
#
# Usage:  ops/supabase-watchdog/tests/run.sh
# Needs:  bash, curl, python3. Touches nothing outside its temp dir and /tmp.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WD="$HERE/../healthcheck.sh"
WORK="$(mktemp -d)"; PORT="${WD_TEST_PORT:-8799}"
MODE=/tmp/wd_mode; EMAILS=/tmp/wd_email.jsonl; SMSS=/tmp/wd_sms.jsonl
cleanup() { [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

pass=0; fail=0
chk() { if [[ "$2" == "$3" ]]; then echo "  ok    $1"; pass=$((pass+1));
        else echo "  FAIL  $1 (want='$3' got='$2')"; fail=$((fail+1)); fi; }

bash -n "$WD" || { echo "FATAL: watchdog has a syntax error"; exit 1; }

rm -f "$EMAILS" "$SMSS"; echo ok > "$MODE"
python3 "$HERE/mock.py" & MOCK_PID=$!
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
SLOW_MS=300
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
chk "both recipients parsed" "$(python3 -c "import json,sys;print(len(json.loads(open('$EMAILS').readline())['to']))")" "2"
chk "payload is valid JSON"  "$(python3 -c "import json;json.loads(open('$EMAILS').readline());print('y')")" "y"
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
chk "alert carries onset"    "$(python3 -c "import json;print('y' if 'Desde:' in json.loads(open('$EMAILS').readline())['text'] else 'n')")" "y"
# Newlines must survive as \n, not be stripped: a human reads this mid-outage.
chk "body is multi-line"     "$(python3 -c "import json;print('y' if json.loads(open('$EMAILS').readline())['text'].count(chr(10))>10 else 'n')")" "y"

echo "F. classification"
rm -f "$SUPABASE_HEALTH_STATE"; chk "slow counts as outage" "$(run slow | grep -c 'state=slow')" "1"
rm -f "$SUPABASE_HEALTH_STATE"; echo hang > "$MODE"
chk "timeout counts as outage" "$(PROBE_TIMEOUT_S=2 bash "$WD" 2>&1 | grep -c 'state=down')" "1"

echo ok > "$MODE"
echo; echo "===== $pass passed · $fail failed ====="
[[ "$fail" == "0" ]]
