#!/bin/bash
# TriciGo — gate for the self-hosted GitHub Actions runner on the VPS.
#
# The runner on the VPS runs as root, and GitHub hands it ANY job whose
# `runs-on` says `self-hosted`: a workflow pushed on any branch, a workflow
# dispatched from any branch, or (the repo is public) a workflow added by a pull
# request from a fork once its run is approved or its author has contributed
# before. Only two jobs belong there: the `deploy` jobs of deploy-web.yml and
# deploy-admin.yml, from master.
#
# Installed as the runner's job-started hook (ACTIONS_RUNNER_HOOK_JOB_STARTED in
# /root/actions-runner/.env). The runner runs it before the first step of every
# job; a non-zero exit fails the job and none of its steps run. It reads the
# GITHUB_* variables the runner sets from the job GitHub sent, never the
# workflow's own `env:`. Any value missing or unexpected refuses the job (fail
# closed). A refusal is written to the job log and the journal
# (tag tricigo-runner-gate), and e-mailed through Resend with the same config as
# the Supabase watchdog and the integrity alarm.
#
# Exit codes: 0 allowed, 1 refused.
#
# Tested by ops/actions-runner/tests/run.sh (CI: runner-gate-tests.yml).
set -u
export LC_ALL=C

TAG="tricigo-runner-gate"
CONFIG_FILE="${RUNNER_GATE_CONFIG:-/etc/tricigo/supabase-health.env}"

# compared lowercase: GitHub names are case-insensitive. In 2026-10 the repo spent
# about a day as Edua050923/TriciGo and came back; that name is refused on purpose.
GATE_REPO="agenciaseniors/tricigo"
GATE_REF="refs/heads/master"
GATE_JOB="deploy"
GATE_EVENTS=" push workflow_dispatch "
GATE_WORKFLOWS=" deploy-web.yml deploy-admin.yml "

log() { logger -t "$TAG" -- "$*" 2>/dev/null || true; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
# One printable line, capped: values come from GitHub (a branch name may hold
# `$(...)` or newlines). They are only ever printed, never evaluated.
clean() { printf '%s' "$1" | tr -d '\000-\037\177' | cut -c1-300; }

# Prints why the job is refused; returns 0 when it is allowed.
decide() {
  local repo ev ref wref job owner_repo rest file
  repo="$(lower "${GITHUB_REPOSITORY:-}")"
  ev="${GITHUB_EVENT_NAME:-}"
  ref="${GITHUB_REF:-}"
  wref="${GITHUB_WORKFLOW_REF:-}"
  job="${GITHUB_JOB:-}"

  [[ "$repo" == "$GATE_REPO" ]] || { echo "repositorio distinto"; return 1; }                        # gate:repo
  [[ -n "$ev" && "$GATE_EVENTS" == *" $ev "* ]] || { echo "evento $ev"; return 1; }                  # gate:event
  [[ "$ref" == "$GATE_REF" ]] || { echo "rama o ref $ref"; return 1; }                               # gate:ref
  [[ "$job" == "$GATE_JOB" ]] || { echo "trabajo $job"; return 1; }                                  # gate:job

  # GITHUB_WORKFLOW_REF = <owner>/<repo>/.github/workflows/<file>@<ref>: the file
  # the job comes from, and the ref that file was read from.
  [[ "$wref" == */.github/workflows/* ]] || { echo "workflow sin ruta"; return 1; }                  # gate:wfpath
  owner_repo="${wref%%/.github/workflows/*}"
  rest="${wref#*/.github/workflows/}"
  file="${rest%%@*}"
  [[ "$(lower "$owner_repo")" == "$GATE_REPO" ]] || { echo "workflow de otro repositorio"; return 1; } # gate:wfrepo
  [[ "$file" =~ ^[A-Za-z0-9._-]+$ && "$GATE_WORKFLOWS" == *" $file "* ]] \
    || { echo "workflow $file"; return 1; }                                                          # gate:wffile
  [[ "$rest" == "$file@$GATE_REF" ]] || { echo "workflow leído de ${rest#*@}"; return 1; }           # gate:wfref
  return 0
}

# ── e-mail (Resend, direct) — same parsing as ops/vps-integrity ─────────
# The config is PARSED, never sourced: `ALERT_EMAIL_TO=a@x.com, b@x.com` sourced
# would be a command prefix and the variable would never be set.
CONFIG_KEYS=" RESEND_API_KEY RESEND_API_URL ALERT_EMAIL_TO ALERT_EMAIL_FROM "
ENV_RESEND_API_URL="${RESEND_API_URL:-}"   # tests point Resend at a mock
RESEND_API_KEY=""; RESEND_API_URL=""; ALERT_EMAIL_TO=""; ALERT_EMAIL_FROM=""

load_kv() {   # $1 = file, $2 = whitespace-delimited whitelist
  local file="$1" allow="$2" line key val
  [[ -r "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"; val="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ "$allow" == *" $key "* ]] || continue
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if [[ ${#val} -ge 2 && ( ( "$val" == \"*\" ) || ( "$val" == \'*\' ) ) ]]; then
      val="${val:1:${#val}-2}"
    fi
    printf -v "$key" '%s' "$val"
  done < "$file"
  return 0
}

json_escape() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | tr -d '\000-\011\013-\037' \
    | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g'
}

SEND_HTTP=""
send_email() {   # $1 = subject, $2 = body. 0 when Resend answered 2xx.
  local subject="$1" body="$2" to_json="" addr tmpd
  local -a addrs=()
  SEND_HTTP="-"
  IFS=',' read -ra addrs <<< "$ALERT_EMAIL_TO"
  for addr in "${addrs[@]}"; do
    addr="${addr#"${addr%%[![:space:]]*}"}"; addr="${addr%"${addr##*[![:space:]]}"}"
    [[ -n "$addr" ]] || continue
    to_json="${to_json:+$to_json,}\"$(json_escape "$addr")\""
  done
  [[ -n "$to_json" ]] || { SEND_HTTP="no-recipient"; return 1; }
  tmpd="$(mktemp -d)" || return 1
  # Key and payload go through files, not argv (argv shows in `ps`).
  printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$RESEND_API_KEY" > "$tmpd/h"
  printf '{"from":"%s","to":[%s],"subject":"%s","text":"%s"}' "$(json_escape "$ALERT_EMAIL_FROM")" \
    "$to_json" "$(json_escape "$subject")" "$(json_escape "$body")" > "$tmpd/b"
  # Short timeout: the job (already refused) waits for this hook.
  SEND_HTTP="$(cd "$tmpd" && curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
    -H @h --data-binary @b "$RESEND_API_URL" 2>/dev/null)"
  SEND_HTTP="${SEND_HTTP:-000}"
  rm -rf "$tmpd"
  [[ "$SEND_HTTP" =~ ^2[0-9][0-9]$ ]]
}

# ── main ───────────────────────────────────────────────────────────────
summary="repo=$(clean "${GITHUB_REPOSITORY:-}") evento=$(clean "${GITHUB_EVENT_NAME:-}") ref=$(clean "${GITHUB_REF:-}") workflow=$(clean "${GITHUB_WORKFLOW_REF:-}") trabajo=$(clean "${GITHUB_JOB:-}") actor=$(clean "${GITHUB_ACTOR:-}")"
run_url="$(clean "${GITHUB_SERVER_URL:-https://github.com}")/$(clean "${GITHUB_REPOSITORY:-?}")/actions/runs/$(clean "${GITHUB_RUN_ID:-?}")"

if reason="$(decide)"; then
  log "permitido: $summary run=$run_url"
  echo "Runner de TriciGo: trabajo permitido ($(clean "${GITHUB_WORKFLOW_REF:-}"), trabajo $(clean "${GITHUB_JOB:-}"))."
  exit 0
fi
reason="$(clean "$reason")"

echo "::error::Este runner solo ejecuta el trabajo deploy de deploy-web.yml y deploy-admin.yml desde master. Trabajo rechazado: $reason."
log "RECHAZADO ($reason): $summary run=$run_url"

if load_kv "$CONFIG_FILE" "$CONFIG_KEYS"; then
  RESEND_API_URL="${ENV_RESEND_API_URL:-${RESEND_API_URL:-https://api.resend.com/emails}}"
  ALERT_EMAIL_FROM="${ALERT_EMAIL_FROM:-noreply@tricigo.com}"
fi
if [[ -n "$RESEND_API_KEY" && -n "$ALERT_EMAIL_TO" ]]; then
  host="$(hostname 2>/dev/null || uname -n 2>/dev/null)"
  body="El runner de GitHub Actions del VPS rechazó un trabajo y no lo ejecutó.

Servidor: $(clean "$host")
Hora:     $(date -u +%Y-%m-%dT%H:%M:%SZ) UTC
Motivo:   $reason

Repositorio: $(clean "${GITHUB_REPOSITORY:-}")
Evento:      $(clean "${GITHUB_EVENT_NAME:-}")
Ref:         $(clean "${GITHUB_REF:-}")
Workflow:    $(clean "${GITHUB_WORKFLOW_REF:-}")
Trabajo:     $(clean "${GITHUB_JOB:-}")
Actor:       $(clean "${GITHUB_ACTOR:-}")
Ejecución:   $run_url

Este runner solo ejecuta el trabajo deploy de deploy-web.yml y deploy-admin.yml
desde master. Si no reconoces la ejecución, alguien intentó correr código en el
VPS: revisa quién la lanzó, cancélala si sigue en curso y revisa el repositorio
(ramas y pull requests nuevos). Si la lanzaste tú, corre el deploy desde master."
  if send_email "Runner del VPS: trabajo rechazado ($reason)" "$body"; then
    log "aviso enviado (resend http=$SEND_HTTP)"
  else
    log "aviso NO entregado (resend http=$SEND_HTTP)"
  fi
else
  log "sin canal de aviso: falta RESEND_API_KEY o ALERT_EMAIL_TO en $CONFIG_FILE"
fi
exit 1
