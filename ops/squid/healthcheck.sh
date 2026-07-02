#!/bin/bash
# ============================================================
# TriciGo — NETOPIA payment-proxy watchdog (VPS-local).
#
# Run every 5 min by systemd (ops/squid/systemd/tricigo-proxy-healthcheck.*).
# Verifies the two proxy layers the in-app card checkout depends on, reports the
# result to the `proxy-health` Edge Function (which alerts + records state), and
# auto-restarts the failing service after N consecutive failures.
#
#   1. squid CONNECT tunnel  — mints a local ephemeral HMAC token (same scheme
#      as hmac_auth.sh / the mint EF) and curls the NETOPIA card page THROUGH
#      the tunnel. 200 = the tunnel is alive and NETOPIA reachable.
#   2. nginx /np-proxy/      — the server->API reverse proxy the create/webhook
#      EFs use. Reachable and not 403/5xx = alive.
#
# Config (env file, root:root 600): /etc/tricigo/proxy-health.env
#   PROXY_HEALTH_URL   = https://<project>.supabase.co/functions/v1/proxy-health
#   PROXY_HEALTH_SECRET= <shared secret, == EF env PROXY_HEALTH_SECRET>
#   NP_PROXY_SECRET    = <x-proxy-secret, == the nginx /np-proxy/ guard>
# Secret for minting: /etc/squid/hmac_secret (proxy:proxy 600 — this script runs
# as root via systemd, so it can read it).
#
# Install: see ops/squid/README.md.
# ============================================================
set -u

HMAC_SECRET_FILE=/etc/squid/hmac_secret
ENV_FILE=/etc/tricigo/proxy-health.env
STATE_DIR=/run/tricigo-proxy
FAIL_FILE="$STATE_DIR/consecutive_fails"
RESTART_THRESHOLD=2          # 2 * 5 min = ~10 min of failure before a restart
NETOPIA_PROBE_URL="https://secure.mobilpay.ro/ui/card"
NP_PROXY_URL="https://tricigo.com/np-proxy/"

mkdir -p "$STATE_DIR"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

log() { logger -t tricigo-proxy-health "$*"; }

# ── 1. squid tunnel probe (mint a local ephemeral token, curl through squid) ──
squid_http=000
if [ -s "$HMAC_SECRET_FILE" ]; then
  secret=$(cat "$HMAC_SECRET_FILE")
  exp=$(( $(date +%s) + 600 ))
  sig=$(printf '%s' "$exp" | openssl dgst -sha256 -hmac "$secret" -r 2>/dev/null | cut -d' ' -f1)
  if [ -n "$sig" ]; then
    squid_http=$(curl -s -x "http://$exp:$sig@127.0.0.1:13128" \
      --max-time 25 -o /dev/null -w '%{http_code}' "$NETOPIA_PROBE_URL" 2>/dev/null || echo 000)
  fi
fi

# ── 2. np-proxy reverse-proxy probe ──
npproxy_http=000
if [ -n "${NP_PROXY_SECRET:-}" ]; then
  npproxy_http=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' \
    -H "x-proxy-secret: $NP_PROXY_SECRET" "$NP_PROXY_URL" 2>/dev/null || echo 000)
fi

# ── Decide health ──
# squid: 200 required (tunnel alive AND NETOPIA reachable through the clean IP).
# np-proxy: anything that isn't a hard failure. 403 = secret drift (guard
# rejecting us) → treat as failure; 000/502/503/504 = upstream/proxy down.
squid_ok=false; [ "$squid_http" = "200" ] && squid_ok=true
npproxy_ok=false
case "$npproxy_http" in
  000|403|500|502|503|504) npproxy_ok=false ;;
  *) npproxy_ok=true ;;
esac

status=ok
$squid_ok || status=down
$npproxy_ok || status=down

# ── Report to the proxy-health EF (records state + de-duped alert) ──
if [ -n "${PROXY_HEALTH_URL:-}" ] && [ -n "${PROXY_HEALTH_SECRET:-}" ]; then
  curl -s --max-time 15 -X POST "$PROXY_HEALTH_URL" \
    -H "Content-Type: application/json" \
    -H "x-proxy-alert-secret: $PROXY_HEALTH_SECRET" \
    -d "{\"source\":\"vps-watchdog\",\"status\":\"$status\",\"squid_http\":\"$squid_http\",\"npproxy_http\":\"$npproxy_http\"}" \
    >/dev/null 2>&1 || log "report POST failed"
fi

# ── Consecutive-failure tracking + auto-restart ──
fails=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
if [ "$status" = "ok" ]; then
  echo 0 > "$FAIL_FILE"
  log "ok squid=$squid_http npproxy=$npproxy_http"
  exit 0
fi

fails=$((fails + 1))
echo "$fails" > "$FAIL_FILE"
log "DOWN squid=$squid_http npproxy=$npproxy_http fails=$fails"

if [ "$fails" -ge "$RESTART_THRESHOLD" ]; then
  # Restart only the failing service; systemd Restart=always covers crashes,
  # this covers "running but not serving" (hung worker, bad reconfigure).
  $squid_ok   || { log "restarting squid";  systemctl restart squid; }
  $npproxy_ok || { log "reloading nginx";    systemctl reload nginx || systemctl restart nginx; }
  echo 0 > "$FAIL_FILE"
fi
exit 1
