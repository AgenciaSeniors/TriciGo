#!/bin/bash
# ============================================================
# TriciGo — Supabase availability watchdog (VPS-local). v1 (2026-09-21).
#
# WHY THIS EXISTS — the 2026-09-21 outage nobody was told about
# ------------------------------------------------------------
# Every alerting path in this project lives INSIDE the database and is fired by
# pg_cron: check_database_health() (00577), check_exchange_rate_freshness()
# (00503), check_cron_http_failures() (00507). All of them reach the outside
# world through cron_http_post()/net.http_post().
#
# On 2026-09-21 the project's storage layer stalled for ~3 h (09:24-12:28 UTC).
# Postgres itself was healthy by every internal metric — 775 MB, 26/60
# connections, 99.76 % cache hit, zero long transactions, zero deadlocks — but
# the disk stopped answering: a checkpoint that normally writes 118 buffers in
# 11.9 s took 242 s to write 9. pg_cron could not even start its background
# workers ("cron job startup timeout" x98 that morning), so NOT ONE watchdog
# ran. platform_config.db_health_status stayed frozen on 'ok' from 08:55 UTC
# while PostgREST served 503s (/rest/v1/rides 215x, platform_config 126x,
# driver_heartbeat, find_nearby_vehicles) for three hours. The owner found out
# by using the app and had to restart the project by hand.
#
# The same shape had already happened on 2026-09-18 and 2026-09-20 — visible
# only as gaps in cron.job_run_details, because nothing was watching from
# outside. A watchdog that lives inside the thing it watches cannot report
# that thing being down. This script lives outside.
#
# DESIGN RULE — it must not need Postgres for ANY of its own work:
#   * state goes to a local file, never to platform_config;
#   * alerts go straight to Resend/D7 over HTTPS, never through the send-email
#     / send-sms Edge Functions (those write to email_sends / sms_log, i.e.
#     they need the database that is down);
#   * the only Supabase thing it touches is the probe target itself.
#
# WHAT IT PROBES (two layers, because they fail independently — verified in the
# incident: the Edge runtime kept running and kept being invoked while every
# call that touched the database failed):
#   rest  — GET /rest/v1/platform_config?select=key&limit=1 with the publishable
#           key. This is literally the path the apps use. 2xx fast = healthy.
#   ef    — GET /functions/v1/health-check (verify_jwt=false). Survives a dead
#           database and says WHICH layer broke (checks.database / checks.auth).
#           200 = ok, 503 = degraded. Enriches the alert; never decides alone.
#
# CLASSIFICATION (rest decides, ef explains):
#   ok    — rest 2xx within SLOW_MS
#   slow  — rest 2xx but slower than SLOW_MS. This is NOT cosmetic: during the
#           incident origin_time reached 125 s while still returning, and a
#           naive up/down probe would have called that "up".
#   down  — rest non-2xx, or no answer inside PROBE_TIMEOUT_S
#
# Config (env file, root:root 600): /etc/tricigo/supabase-health.env
# State (root:root 600):            /var/lib/tricigo/supabase-health.state
# Install: see ops/supabase-watchdog/README.md
# ============================================================
set -uo pipefail

SELFTEST=0
[[ "${1:-}" == "--selftest" ]] && SELFTEST=1

CONFIG_FILE="${SUPABASE_HEALTH_CONFIG:-/etc/tricigo/supabase-health.env}"
STATE_FILE="${SUPABASE_HEALTH_STATE:-/var/lib/tricigo/supabase-health.state}"
TAG="tricigo-supabase-health"

log() { logger -t "$TAG" -- "$*" 2>/dev/null || true; echo "$*"; }

# ── config ────────────────────────────────────────────────
# The config is PARSED, never sourced. A sourced env file turns
#   ALERT_EMAIL_TO=a@x.com, b@x.com
# into the command prefix `ALERT_EMAIL_TO=a@x.com b@x.com`, so the variable is
# never actually set and every email alert is skipped in silence — found by the
# test suite, and it is precisely the "no alert arrived" failure this watchdog
# exists to prevent. Parsing also means a typo in the config cannot execute
# anything as root. Unquoted, quoted and spaced values all work.
CONFIG_KEYS=" SUPABASE_URL SUPABASE_PUBLISHABLE_KEY RESEND_API_KEY RESEND_API_URL \
ALERT_EMAIL_TO ALERT_EMAIL_FROM D7_API_TOKEN D7_API_URL D7_SENDER_ID ALERT_SMS_TO \
PROBE_TIMEOUT_S SLOW_MS FAILS_BEFORE_ALERT OKS_BEFORE_RECOVERY "
STATE_KEYS=" fails oks alerted down_since last_state "

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
    [[ "$allow" == *" $key "* ]] || continue          # ignore anything unknown
    val="${val#"${val%%[![:space:]]*}"}"               # ltrim
    val="${val%"${val##*[![:space:]]}"}"               # rtrim
    if [[ ${#val} -ge 2 && ( ( "$val" == \"*\" ) || ( "$val" == \'*\' ) ) ]]; then
      val="${val:1:${#val}-2}"
    fi
    printf -v "$key" '%s' "$val"
  done < "$file"
  return 0
}

if ! load_kv "$CONFIG_FILE" "$CONFIG_KEYS"; then
  log "config: $CONFIG_FILE missing or unreadable — cannot probe, exiting"
  exit 0   # do not spam systemd; the absence is visible in the journal
fi

SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_PUBLISHABLE_KEY="${SUPABASE_PUBLISHABLE_KEY:-}"
RESEND_API_KEY="${RESEND_API_KEY:-}"
ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-}"
ALERT_EMAIL_FROM="${ALERT_EMAIL_FROM:-noreply@tricigo.com}"
D7_API_TOKEN="${D7_API_TOKEN:-}"
D7_SENDER_ID="${D7_SENDER_ID:-TriciGo}"
ALERT_SMS_TO="${ALERT_SMS_TO:-}"
RESEND_API_URL="${RESEND_API_URL:-https://api.resend.com/emails}"
D7_API_URL="${D7_API_URL:-https://api.d7networks.com/messages/v1/send}"
PROBE_TIMEOUT_S="${PROBE_TIMEOUT_S:-20}"
SLOW_MS="${SLOW_MS:-5000}"
FAILS_BEFORE_ALERT="${FAILS_BEFORE_ALERT:-2}"
OKS_BEFORE_RECOVERY="${OKS_BEFORE_RECOVERY:-2}"

if [[ -z "$SUPABASE_URL" || -z "$SUPABASE_PUBLISHABLE_KEY" ]]; then
  log "config: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not set — cannot probe, exiting"
  exit 1
fi

# A watchdog with no way to reach a human is decoration. Say so on EVERY run,
# loudly, rather than discovering it during the next outage.
have_email=0; have_sms=0
[[ -n "$RESEND_API_KEY" && -n "$ALERT_EMAIL_TO" ]] && have_email=1
[[ -n "$D7_API_TOKEN"   && -n "$ALERT_SMS_TO"   ]] && have_sms=1
if (( have_email == 0 && have_sms == 0 )); then
  log "CONFIG ERROR: no alert channel configured (need RESEND_API_KEY+ALERT_EMAIL_TO and/or D7_API_TOKEN+ALERT_SMS_TO). Probing anyway, but NOBODY WILL BE TOLD."
fi

# ── state ─────────────────────────────────────────────────
fails=0; oks=0; alerted=0; down_since=""; last_state="ok"
load_kv "$STATE_FILE" "$STATE_KEYS" || true

save_state() {
  mkdir -p "$(dirname "$STATE_FILE")"
  cat > "$STATE_FILE" <<STATE
fails=$fails
oks=$oks
alerted=$alerted
down_since="$down_since"
last_state="$last_state"
STATE
  chmod 600 "$STATE_FILE" 2>/dev/null || true
}

# Escapes for a JSON string. Newlines become the two-character sequence \n
# instead of being deleted: the alert body is read by a human at 5 a.m. during
# an outage, and a single run-on paragraph is not what you want then.
json_escape() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | tr -d '\000-\011\013-\037' \
    | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g'
}

# ── probes ────────────────────────────────────────────────
TMP_REST="$(mktemp)"; TMP_EF="$(mktemp)"
trap 'rm -f "$TMP_REST" "$TMP_EF"' EXIT

t0=$(date +%s%3N)
rest_code=$(curl -s -o "$TMP_REST" -w '%{http_code}' --max-time "$PROBE_TIMEOUT_S" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_PUBLISHABLE_KEY" \
  "$SUPABASE_URL/rest/v1/platform_config?select=key&limit=1" 2>/dev/null)
t1=$(date +%s%3N)
rest_ms=$(( t1 - t0 ))

t0=$(date +%s%3N)
ef_code=$(curl -s -o "$TMP_EF" -w '%{http_code}' --max-time "$PROBE_TIMEOUT_S" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  "$SUPABASE_URL/functions/v1/health-check" 2>/dev/null)
t1=$(date +%s%3N)
ef_ms=$(( t1 - t0 ))

ef_body=$(tr -d '\n' < "$TMP_EF" | cut -c1-400)
rest_body=$(tr -d '\n' < "$TMP_REST" | cut -c1-240)

# ── classify ──────────────────────────────────────────────
if [[ "$rest_code" =~ ^2 ]]; then
  if (( rest_ms > SLOW_MS )); then state="slow"; else state="ok"; fi
else
  state="down"
fi

detail="rest=${rest_code} ${rest_ms}ms · ef=${ef_code} ${ef_ms}ms"
[[ "$state" != "ok" && -n "$rest_body" ]] && detail="$detail · rest_body=${rest_body}"
[[ "$state" != "ok" && -n "$ef_body"   ]] && detail="$detail · ef_body=${ef_body}"

# ── alert channels (no database in the path) ──────────────
EMAIL_SEND_OK=-1; SMS_SEND_OK=-1   # -1 = not attempted

send_email() {
  local subject="$1" body="$2"
  [[ -z "$RESEND_API_KEY" || -z "$ALERT_EMAIL_TO" ]] && { log "email: RESEND_API_KEY/ALERT_EMAIL_TO not set — skipped"; return; }
  local to_json="" addr
  IFS=',' read -ra _addrs <<< "$ALERT_EMAIL_TO"
  for addr in "${_addrs[@]}"; do
    addr="$(echo "$addr" | xargs)"; [[ -z "$addr" ]] && continue
    to_json="${to_json:+$to_json,}\"$(json_escape "$addr")\""
  done
  [[ -z "$to_json" ]] && return
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$RESEND_API_URL" \
    -H "Authorization: Bearer $RESEND_API_KEY" -H 'Content-Type: application/json' \
    -d "{\"from\":\"$(json_escape "$ALERT_EMAIL_FROM")\",\"to\":[$to_json],\"subject\":\"$(json_escape "$subject")\",\"text\":\"$(json_escape "$body")\"}" 2>/dev/null)
  [[ "$code" =~ ^2 ]] && EMAIL_SEND_OK=1 || EMAIL_SEND_OK=0
  log "email: resend http=$code"
}

send_sms() {
  local body="$1"
  [[ -z "$D7_API_TOKEN" || -z "$ALERT_SMS_TO" ]] && return
  local num code
  IFS=',' read -ra _nums <<< "$ALERT_SMS_TO"
  for num in "${_nums[@]}"; do
    num="$(echo "$num" | xargs)"; [[ -z "$num" ]] && continue
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$D7_API_URL" \
      -H "Authorization: Bearer $D7_API_TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json' \
      -d "{\"messages\":[{\"channel\":\"sms\",\"recipients\":[\"$(json_escape "$num")\"],\"content\":\"$(json_escape "$body")\",\"msg_type\":\"text\",\"data_coding\":\"unicode\"}],\"message_globals\":{\"originator\":\"$(json_escape "$D7_SENDER_ID")\"}}" 2>/dev/null)
    [[ "$code" =~ ^2 ]] && SMS_SEND_OK=1 || SMS_SEND_OK=0
    log "sms: d7 http=$code to=$num"
  done
}

# ── selftest ──────────────────────────────────────────────
# Exercises the alert path end to end so an install is proven, not assumed.
if (( SELFTEST == 1 )); then
  log "selftest: probe -> state=$state · $detail"
  log "selftest: channels -> email=$( ((have_email)) && echo configured || echo MISSING ) sms=$( ((have_sms)) && echo configured || echo MISSING )"
  send_email "TriciGo — PRUEBA del watchdog de Supabase" \
"Esto es una PRUEBA. Si lees este correo, las alertas de caida funcionan.

Sonda real en este momento: ${state}
Detalle: ${detail}

Enviado por: $(hostname) · $(date -u +%Y-%m-%dT%H:%M:%SZ) UTC"
  send_sms "TriciGo: PRUEBA del watchdog. Si lees esto, las alertas funcionan. Sonda=${state}"
  if (( have_email == 0 && have_sms == 0 )); then
    log "selftest: FALLO — ningun canal configurado"; exit 1
  fi
  # A selftest that reports success without checking is the bug it exists to
  # catch. Demand that at least one configured channel actually accepted.
  if (( EMAIL_SEND_OK == 1 || SMS_SEND_OK == 1 )); then
    log "selftest: OK — al menos un canal acepto el envio. Confirma que te llego."
    exit 0
  fi
  log "selftest: FALLO — ningun canal acepto el envio (email=$EMAIL_SEND_OK sms=$SMS_SEND_OK; -1=no intentado)"
  exit 1
fi

# ── counters + transitions ────────────────────────────────
now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fire_alert=0; fire_recovery=0

if [[ "$state" == "ok" ]]; then
  oks=$(( oks + 1 )); fails=0
  # A blip that recovered before alerting was never an incident: forget its
  # onset, or the next real outage would be reported as starting back then.
  (( alerted == 0 )) && down_since=""
  if (( alerted == 1 )) && (( oks >= OKS_BEFORE_RECOVERY )); then
    fire_recovery=1; alerted=0
  fi
else
  fails=$(( fails + 1 )); oks=0
  [[ -z "$down_since" ]] && down_since="$now_iso"
  if (( alerted == 0 )) && (( fails >= FAILS_BEFORE_ALERT )); then
    fire_alert=1; alerted=1
  fi
fi

log "state=$state fails=$fails oks=$oks alerted=$alerted · $detail"

if (( fire_alert == 1 )); then
  subject="TriciGo CAIDO — Supabase no responde (${state})"
  body="La plataforma no esta respondiendo.

Estado: ${state}
Desde:  ${down_since} UTC
Sonda:  ${detail}

Que significa:
  rest = el camino exacto que usan las apps (PostgREST). Si no es 2xx, los
         pasajeros y conductores estan viendo errores AHORA.
  ef   = Edge Function health-check. Si responde pero dice degraded, el
         runtime vive y lo que fallo es la base de datos.

Primer paso (incidentes de 2026-09-18, 20 y 21): revisar Disk IO en el panel
de Supabase. En los tres casos la base estaba sana por dentro (tamano, memoria,
conexiones, cache) y lo que se cayo fue el almacenamiento. El reinicio del
proyecto lo destraba; abrir ticket con Supabase con la evidencia de checkpoints.

Watchdog externo (VPS) — no depende de la base que vigila.
Journal: journalctl -t tricigo-supabase-health -n 50"
  send_email "$subject" "$body"
  send_sms "TriciGo CAIDO: Supabase no responde (${state}) desde ${down_since} UTC. ${detail}"
  log "ALERT SENT — state=$state since=$down_since"
fi

if (( fire_recovery == 1 )); then
  subject="TriciGo recuperado — Supabase responde normal"
  body="La plataforma volvio a responder.

Caida desde: ${down_since} UTC
Recuperado:  ${now_iso} UTC
Sonda:       ${detail}

Watchdog externo (VPS).
Journal: journalctl -t tricigo-supabase-health -n 50"
  send_email "$subject" "$body"
  send_sms "TriciGo recuperado: Supabase responde normal a las ${now_iso} UTC."
  log "RECOVERY SENT — down_since=$down_since"
  down_since=""
fi

last_state="$state"
save_state
exit 0
