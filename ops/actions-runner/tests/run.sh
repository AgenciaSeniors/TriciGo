#!/bin/bash
# TriciGo — test suite for the runner gate (ops/actions-runner/job-gate.sh).
#
# Runs the REAL hook with the GITHUB_* variables of each kind of job (in a clean
# `env -i` environment, so the variables of a CI runner never leak in), a fake
# `logger` and the mock Resend server of ops/vps-integrity/tests/mock.py.
# Includes negative proofs: each check of the gate is deleted in turn and the
# suite must then see a refused job go through. A verification that has never
# been seen to fail is not a verification.
#
# Usage:  ops/actions-runner/tests/run.sh
# Needs:  bash 4+, curl, python3.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/../job-gate.sh"
MOCKPY="$HERE/../../vps-integrity/tests/mock.py"
WORK="$(mktemp -d)"
MOCK_PID=""; PORT=""
cleanup() {
  [[ -n "$PORT" ]] && curl -s --max-time 2 "http://127.0.0.1:$PORT/shutdown" >/dev/null 2>&1
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

pass=0; fail=0
ok()  { echo "  ok    $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
chk()   { if [[ "$2" == "$3" ]];  then ok "$1"; else bad "$1 (want='$3' got='$2')"; fi; }
has()   { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1 (missing '$3')"; fi; }
hasnt() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else bad "$1 (unexpected '$3')"; fi; }

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 \
     && "$c" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1; then
    PY="$c"; break
  fi
done
[[ -n "$PY" ]] || { echo "FATAL: need python3 for the mock Resend server"; exit 1; }
bash -n "$GATE" || { echo "FATAL: job-gate.sh has a syntax error"; exit 1; }

# ── mock Resend ───────────────────────────────────────────
MOCK="$WORK/mock"; mkdir -p "$MOCK"; echo ok > "$MOCK/mode"
NONCE="runner-gate-$$-$RANDOM"
"$PY" "$MOCKPY" "$MOCK" "$NONCE" 2> "$MOCK/stderr.log" & MOCK_PID=$!
up=0
for _ in $(seq 1 240); do
  if [[ -s "$MOCK/port" ]]; then
    PORT="$(tr -d '\r\n' < "$MOCK/port")"
    if [[ "$(curl -s --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null)" == "$NONCE" ]]; then up=1; break; fi
  fi
  sleep 0.25
done
(( up )) || { echo "FATAL: the mock Resend server did not come up"; sed 's/^/  mock: /' "$MOCK/stderr.log"; exit 1; }

# A fake logger first on PATH: the journal lines land in a file.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/logger" <<'EOF'
#!/bin/bash
tag=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t) tag="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
printf '%s: %s\n' "$tag" "$*" >> "$GATE_TEST_JOURNAL"
EOF
chmod +x "$WORK/bin/logger"

CONF="$WORK/gate.env"
SECRET_KEY="re_test_secret_$RANDOM$RANDOM"
printf 'RESEND_API_KEY=%s\nALERT_EMAIL_TO=ops@example.com, owner@example.com\nALERT_EMAIL_FROM=noreply@tricigo.com\n' "$SECRET_KEY" > "$CONF"

OUT=""; RC=0; JOURNAL=""
# run_gate <script> [VAR=value ...]: runs the hook with ONLY these variables.
run_gate() {
  local script="$1"; shift
  : > "$WORK/journal"
  rm -f "$MOCK/attempts.jsonl" "$MOCK/emails.jsonl" "$MOCK"/last.*
  OUT="$(cd "$WORK" && env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$WORK" \
    GATE_TEST_JOURNAL="$WORK/journal" RUNNER_GATE_CONFIG="$CONF" \
    RESEND_API_URL="http://127.0.0.1:$PORT/emails" \
    GITHUB_SERVER_URL=https://github.com GITHUB_RUN_ID=12345 GITHUB_ACTOR=someone \
    "$@" bash "$script" 2>&1)"
  RC=$?
  JOURNAL="$(cat "$WORK/journal")"
}
emails() { if [[ -s "$MOCK/emails.jsonl" ]]; then grep -c '' "$MOCK/emails.jsonl"; else echo 0; fi; }

R=GITHUB_REPOSITORY=Edua050923/TriciGo
WEB=GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/deploy-web.yml@refs/heads/master
ADMIN=GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/deploy-admin.yml@refs/heads/master
M=GITHUB_REF=refs/heads/master
J=GITHUB_JOB=deploy

echo "== allowed: the two deploys from master"
run_gate "$GATE" "$R" GITHUB_EVENT_NAME=push "$M" "$WEB" "$J"
chk "push to master, deploy-web: allowed" "$RC" 0
has "  says so in the job log" "$OUT" "trabajo permitido"
has "  journal line" "$JOURNAL" "tricigo-runner-gate: permitido:"
chk "  no e-mail" "$(emails)" 0
run_gate "$GATE" "$R" GITHUB_EVENT_NAME=workflow_dispatch "$M" "$ADMIN" "$J"
chk "dispatch on master, deploy-admin: allowed" "$RC" 0
run_gate "$GATE" GITHUB_REPOSITORY=edua050923/tricigo GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=edua050923/TRICIGO/.github/workflows/deploy-web.yml@refs/heads/master "$J"
chk "repository name in another case: allowed" "$RC" 0

echo "== refused"
refused() {   # <label> <want-in-reason> VAR=value ...
  local label="$1" want="$2"; shift 2
  run_gate "$GATE" "$@"
  chk "$label: refused" "$RC" 1
  has "  reason in the job log" "$OUT" "$want"
}
refused "pull request (fork or branch)" "evento pull_request" "$R" GITHUB_EVENT_NAME=pull_request \
  GITHUB_REF=refs/pull/7/merge GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/deploy-web.yml@refs/pull/7/merge "$J"
refused "pull_request_target" "evento pull_request_target" "$R" GITHUB_EVENT_NAME=pull_request_target "$M" "$WEB" "$J"
refused "push to another branch" "rama o ref refs/heads/feature" "$R" GITHUB_EVENT_NAME=push \
  GITHUB_REF=refs/heads/feature GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/deploy-web.yml@refs/heads/feature "$J"
refused "dispatch from another branch" "rama o ref refs/heads/x" "$R" GITHUB_EVENT_NAME=workflow_dispatch \
  GITHUB_REF=refs/heads/x GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/deploy-admin.yml@refs/heads/x "$J"
refused "ref master but workflow read from a branch" "workflow leído de refs/heads/evil" "$R" GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/deploy-web.yml@refs/heads/evil "$J"
refused "a tag" "rama o ref refs/tags/v1" "$R" GITHUB_EVENT_NAME=push GITHUB_REF=refs/tags/v1 \
  GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/deploy-web.yml@refs/tags/v1 "$J"
refused "another workflow on master" "workflow ci.yml" "$R" GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/ci.yml@refs/heads/master "$J"
refused "a look-alike workflow file" "workflow deploy-web.yml.bak" "$R" GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/deploy-web.yml.bak@refs/heads/master "$J"
refused "a workflow in a subfolder" "workflow sub/.github/workflows/deploy-web.yml" "$R" GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/sub/.github/workflows/deploy-web.yml@refs/heads/master "$J"
refused "a second @ in the workflow ref" "workflow leído de" "$R" GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/deploy-web.yml@refs/heads/master@refs/heads/evil "$J"
refused "the build job" "trabajo build" "$R" GITHUB_EVENT_NAME=push "$M" "$WEB" GITHUB_JOB=build
refused "another repository" "repositorio distinto" GITHUB_REPOSITORY=someone/TriciGo GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=someone/TriciGo/.github/workflows/deploy-web.yml@refs/heads/master "$J"
refused "a workflow of another repository" "workflow de otro repositorio" "$R" GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=someone/TriciGo/.github/workflows/deploy-web.yml@refs/heads/master "$J"
# The repository moved from AgenciaSeniors/TriciGo (2026-10). GitHub redirects the
# old name, but whoever holds it now could create a new repository there.
refused "the repository's old name" "repositorio distinto" GITHUB_REPOSITORY=AgenciaSeniors/TriciGo \
  GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=AgenciaSeniors/TriciGo/.github/workflows/deploy-web.yml@refs/heads/master "$J"
refused "a workflow under the old name" "workflow de otro repositorio" "$R" GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=AgenciaSeniors/TriciGo/.github/workflows/deploy-admin.yml@refs/heads/master "$J"
refused "a schedule" "evento schedule" "$R" GITHUB_EVENT_NAME=schedule "$M" "$WEB" "$J"
for v in GITHUB_REPOSITORY GITHUB_EVENT_NAME GITHUB_REF GITHUB_WORKFLOW_REF GITHUB_JOB; do
  args=()
  for a in "$R" GITHUB_EVENT_NAME=push "$M" "$WEB" "$J"; do [[ "${a%%=*}" == "$v" ]] || args+=("$a"); done
  run_gate "$GATE" "${args[@]}"
  chk "without $v: refused" "$RC" 1
done
run_gate "$GATE"
chk "no variables at all: refused" "$RC" 1

echo "== the refusal is logged and e-mailed"
run_gate "$GATE" "$R" GITHUB_EVENT_NAME=pull_request GITHUB_REF=refs/pull/7/merge \
  GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/evil.yml@refs/pull/7/merge "$J"
chk "exit 1" "$RC" 1
has "error annotation in the job log" "$OUT" "::error::Este runner solo ejecuta"
has "journal: refused" "$JOURNAL" "tricigo-runner-gate: RECHAZADO (evento pull_request)"
has "journal: e-mail sent" "$JOURNAL" "aviso enviado (resend http=200)"
chk "one e-mail" "$(emails)" 1
chk "  to both recipients" "$(cat "$MOCK/last.to")" "ops@example.com,owner@example.com"
has "  subject names the reason" "$(cat "$MOCK/last.subject")" "trabajo rechazado (evento pull_request)"
has "  body has the run link" "$(cat "$MOCK/last.text")" "https://github.com/Edua050923/TriciGo/actions/runs/12345"
has "  body has the workflow" "$(cat "$MOCK/last.text")" "evil.yml@refs/pull/7/merge"
chk "  valid JSON" "$(cat "$MOCK/last.valid")" y
chk "  key only in the Authorization header" "$(cat "$MOCK/last.auth")" "Bearer $SECRET_KEY"
hasnt "  key not in the body" "$(cat "$MOCK/last.text")" "$SECRET_KEY"
hasnt "  key not in the job log" "$OUT" "$SECRET_KEY"
hasnt "  key not in the journal" "$JOURNAL" "$SECRET_KEY"

echo "== Resend down or no config: still refused"
echo fail > "$MOCK/mode"
run_gate "$GATE" "$R" GITHUB_EVENT_NAME=pull_request "$M" "$WEB" "$J"
chk "Resend 500: refused" "$RC" 1
has "  journal says not delivered" "$JOURNAL" "aviso NO entregado (resend http=500)"
echo ok > "$MOCK/mode"
cp "$CONF" "$CONF.bak"; : > "$CONF"
run_gate "$GATE" "$R" GITHUB_EVENT_NAME=pull_request "$M" "$WEB" "$J"
chk "empty config: refused" "$RC" 1
has "  journal says there is no channel" "$JOURNAL" "sin canal de aviso"
rm -f "$CONF"
run_gate "$GATE" "$R" GITHUB_EVENT_NAME=pull_request "$M" "$WEB" "$J"
chk "missing config: refused" "$RC" 1
chk "  no e-mail" "$(emails)" 0
mv "$CONF.bak" "$CONF"

echo "== hostile values are printed, never run"
run_gate "$GATE" "$R" GITHUB_EVENT_NAME=push "GITHUB_REF=refs/heads/\$(touch $WORK/pwned1)" \
  "GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/deploy-web.yml@refs/heads/\`touch $WORK/pwned2\`" "$J"
chk "branch with \$(...) and backticks: refused" "$RC" 1
chk "  nothing executed" "$(ls "$WORK" | grep -c pwned)" 0
run_gate "$GATE" "$R" GITHUB_EVENT_NAME=push $'GITHUB_REF=refs/heads/a\n::add-mask::x' "$WEB" "$J"
chk "branch with a newline: refused" "$RC" 1
chk "  the error stays on one line" "$(grep -c '::error::' <<<"$OUT")" 1
chk "  no line starts a workflow command" "$(grep -c '^::add-mask::' <<<"$OUT")" 0
printf 'RESEND_API_KEY=%s\nALERT_EMAIL_TO=$(touch %s/pwned3)\n' "$SECRET_KEY" "$WORK" > "$CONF.evil"
run_gate "$GATE" RUNNER_GATE_CONFIG="$CONF.evil" "$R" GITHUB_EVENT_NAME=pull_request "$M" "$WEB" "$J"
chk "config is parsed, not sourced" "$(ls "$WORK" | grep -c pwned)" 0
printf 'RESEND_API_KEY="%s"\r\nALERT_EMAIL_TO = ops@example.com\r\n' "$SECRET_KEY" > "$CONF.crlf"
run_gate "$GATE" RUNNER_GATE_CONFIG="$CONF.crlf" "$R" GITHUB_EVENT_NAME=pull_request "$M" "$WEB" "$J"
chk "CRLF, quoted and spaced config still e-mails" "$(emails)" 1

echo "== negative proofs: drop each check, a refused job must go through"
mutant() {   # <check tag> <label> VAR=value ... (a job that only that check refuses)
  local tag="$1" label="$2"; shift 2
  local m="$WORK/mutant-$tag.sh"
  grep -q "# gate:$tag\$" "$GATE" || { bad "mutant $tag: tag not found in job-gate.sh"; return; }
  sed "/# gate:$tag\$/d" "$GATE" > "$m"
  # gate:wffile spans two lines: drop the line before its tag too.
  [[ "$tag" == wffile ]] && sed -e '/\[\[ "\$file" =~/d' -e "/# gate:$tag\$/d" "$GATE" > "$m"
  bash -n "$m" || { bad "mutant $tag: syntax error"; return; }
  run_gate "$GATE" "$@"
  chk "real gate refuses: $label" "$RC" 1
  run_gate "$m" "$@"
  chk "without gate:$tag it goes through: $label" "$RC" 0
}
mutant repo   "another repository" GITHUB_REPOSITORY=someone/TriciGo GITHUB_EVENT_NAME=push "$M" "$WEB" "$J"
mutant event  "pull_request" "$R" GITHUB_EVENT_NAME=pull_request "$M" "$WEB" "$J"
mutant ref    "push to a branch" "$R" GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/x "$WEB" "$J"
mutant job    "the build job" "$R" GITHUB_EVENT_NAME=push "$M" "$WEB" GITHUB_JOB=build
mutant wfrepo "workflow of another repository" "$R" GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=someone/TriciGo/.github/workflows/deploy-web.yml@refs/heads/master "$J"
mutant wffile "another workflow" "$R" GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/ci.yml@refs/heads/master "$J"
mutant wfref  "workflow read from a branch" "$R" GITHUB_EVENT_NAME=push "$M" \
  GITHUB_WORKFLOW_REF=Edua050923/TriciGo/.github/workflows/deploy-web.yml@refs/heads/evil "$J"

echo
echo "passed: $pass  failed: $fail"
(( fail == 0 ))
