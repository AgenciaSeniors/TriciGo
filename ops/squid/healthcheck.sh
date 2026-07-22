#!/bin/bash
# ============================================================
# TriciGo — NETOPIA payment-proxy watchdog (VPS-local). v2 (2026-07-21).
#
# Run every 5 min by systemd (ops/squid/systemd/tricigo-proxy-healthcheck.*).
# Probes the two proxy layers the in-app card checkout depends on, CLASSIFIES
# each failure (VPS service broken vs NETOPIA/upstream broken — decided with a
# direct-from-VPS control probe), reports per-layer state to the `proxy-health`
# EF (which debounces alerts), and auto-restarts a service ONLY when the
# failure is actually that service's fault:
#
#   squid layer   — mint a local ephemeral HMAC token (same scheme as
#                   hmac_auth.sh / the mint EF) and curl the NETOPIA card page
#                   THROUGH the tunnel.
#                     hmac_secret missing/empty        → config (the probe
#                       can't even run — and squid's auth helper reads the
#                       SAME file, so real checkouts are likely 407ing too;
#                       restarting squid can't fix a missing file)
#                     200                              → ok
#                     curl rc=7 (proxy refuses)        → down (squid dead)
#                     fail + direct(/ui/card) == 200   → down (squid broken)
#                     fail + direct(/ui/card) fails    → upstream (NETOPIA —
#                       restarting squid is useless; 2026-07-20 incident)
#   npproxy layer — curl nginx /np-proxy/ with the x-proxy-secret.
#                     NP_PROXY_SECRET not set          → config (the probe
#                       never ran — nginx may be perfectly fine; blaming it
#                       with a fake 'down' + reload would be the same class
#                       of misdiagnosis this watchdog exists to prevent)
#                     404 (NETOPIA answers /pay/)      → ok (normal response)
#                     403                              → config (secret drift;
#                       a reload can't fix it → alert only)
#                     000/5xx + direct(/pay/) fails    → upstream (NETOPIA;
#                       2026-07-21 502 blips)
#                     000/5xx + direct(/pay/) fine     → down (nginx broken)
#
# HTTP code "-" in the report/journal = that probe never ran (config state).
#
# Config (env file, root:root 600): /etc/tricigo/proxy-health.env
#   PROXY_HEALTH_URL   = https://<project>.supabase.co/functions/v1/proxy-health
#   PROXY_HEALTH_SECRET= <shared secret, == EF env PROXY_HEALTH_SECRET>
#   NP_PROXY_SECRET    = <x-proxy-secret, == the nginx /np-proxy/ guard>
# Secret for minting: /etc/squid/hmac_secret (proxy:proxy 600 — this script
# runs as root via systemd, so it can read it).
#
# Install: see ops/squid/README.md.
# ============================================================
set -u

HMAC_SECRET_FILE=/etc/squid/hmac_secret
ENV_FILE=/etc/tricigo/proxy-health.env
STATE_DIR=/run/tricigo-proxy
RESTART_THRESHOLD=2          # 2 * 5 min ≈ 10 min of service-fault failure before restart
NETOPIA_PROBE_URL="https://secure.mobilpay.ro/ui/card"
NETOPIA_PAY_URL="https://secure.mobilpay.ro/pay/"
NP_PROXY_URL="https://tricigo.com/np-proxy/"

mkdir -p "$STATE_DIR"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

log() { logger -t tricigo-proxy-health "$*"; }

# ── 1. squid tunnel probe (mint a local ephemeral token, curl through squid) ──
# "-" = the probe never ran (secret missing → 'config', never a fake 'down').
squid_probe_ran=false
squid_http="-"
squid_rc=99
if [ -s "$HMAC_SECRET_FILE" ]; then
  secret=$(cat "$HMAC_SECRET_FILE")
  exp=$(( $(date +%s) + 600 ))
  sig=$(printf '%s' "$exp" | openssl dgst -sha256 -hmac "$secret" -r 2>/dev/null | cut -d' ' -f1)
  if [ -n "$sig" ]; then
    squid_probe_ran=true
    squid_http=$(curl -s -x "http://$exp:$sig@127.0.0.1:13128" \
      --max-time 25 -o /dev/null -w '%{http_code}' "$NETOPIA_PROBE_URL" 2>/dev/null)
    squid_rc=$?
    [ -n "$squid_http" ] || squid_http=000
  fi
fi

# ── 2. np-proxy reverse-proxy probe ──
npproxy_http="-"
if [ -n "${NP_PROXY_SECRET:-}" ]; then
  npproxy_http=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' \
    -H "x-proxy-secret: $NP_PROXY_SECRET" "$NP_PROXY_URL" 2>/dev/null)
  [ -n "$npproxy_http" ] || npproxy_http=000
fi

# ── 3. Classify each layer: the VPS service's fault vs NETOPIA/upstream ──
# The direct control probes hit NETOPIA from this box WITHOUT the proxy layer:
# if NETOPIA fails both through and around the proxy, the proxy is innocent.
direct_card="-"
direct_pay="-"

squid_state=ok
if [ "$squid_probe_ran" != "true" ]; then
  squid_state=config            # hmac_secret missing/empty/unreadable — the
                                # watchdog can't mint; squid may be fine (and a
                                # restart can't conjure the secret back)
elif [ "$squid_http" != "200" ]; then
  direct_card=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$NETOPIA_PROBE_URL" 2>/dev/null)
  [ -n "$direct_card" ] || direct_card=000
  if [ "$squid_rc" = "7" ]; then
    squid_state=down            # squid isn't even accepting connections
  elif [ "$direct_card" = "200" ]; then
    squid_state=down            # NETOPIA fine from this box → squid is broken
  else
    squid_state=upstream        # NETOPIA failing with AND without the tunnel
  fi
fi

npproxy_state=ok
case "$npproxy_http" in
  -)   npproxy_state=config ;;  # NP_PROXY_SECRET not set — the probe never ran
  403) npproxy_state=config ;;  # x-proxy-secret drift — a reload can't fix it
  000|500|502|503|504)
    direct_pay=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$NETOPIA_PAY_URL" 2>/dev/null)
    [ -n "$direct_pay" ] || direct_pay=000
    case "$direct_pay" in
      000|500|502|503|504) npproxy_state=upstream ;;
      *)                   npproxy_state=down ;;   # NETOPIA fine direct → nginx broken
    esac ;;
esac

status=ok
{ [ "$squid_state" = ok ] && [ "$npproxy_state" = ok ]; } || status=down

# ── 4. Report to the proxy-health EF (per-layer state; the EF debounces) ──
if [ -n "${PROXY_HEALTH_URL:-}" ] && [ -n "${PROXY_HEALTH_SECRET:-}" ]; then
  curl -s --max-time 15 -X POST "$PROXY_HEALTH_URL" \
    -H "Content-Type: application/json" \
    -H "x-proxy-alert-secret: $PROXY_HEALTH_SECRET" \
    -d "{\"source\":\"vps-watchdog\",\"status\":\"$status\",\"squid_http\":\"$squid_http\",\"npproxy_http\":\"$npproxy_http\",\"squid_state\":\"$squid_state\",\"npproxy_state\":\"$npproxy_state\",\"direct_card_http\":\"$direct_card\",\"direct_pay_http\":\"$direct_pay\"}" \
    >/dev/null 2>&1 || log "report POST failed"
fi

# ── 5. Per-layer consecutive-failure tracking + TARGETED remediation ──
# Restart a service ONLY when the failure is the service's own fault ('down').
# 'upstream' (NETOPIA broken) and 'config' (secret drift): a restart fixes
# nothing and kills live payment tunnels — never auto-restart for those
# (2026-07-20: 4 useless squid restarts during a NETOPIA-side stall).
fails_squid=$(cat "$STATE_DIR/fails_squid" 2>/dev/null || echo 0)
fails_npproxy=$(cat "$STATE_DIR/fails_npproxy" 2>/dev/null || echo 0)

if [ "$squid_state" = "down" ]; then
  fails_squid=$((fails_squid + 1))
  if [ "$fails_squid" -ge "$RESTART_THRESHOLD" ]; then
    log "restarting squid (fails=$fails_squid)"
    systemctl restart squid
    fails_squid=0
  fi
else
  fails_squid=0
fi

if [ "$npproxy_state" = "down" ]; then
  fails_npproxy=$((fails_npproxy + 1))
  if [ "$fails_npproxy" -ge "$RESTART_THRESHOLD" ]; then
    log "reloading nginx (fails=$fails_npproxy)"
    systemctl reload nginx || systemctl restart nginx
    fails_npproxy=0
  fi
else
  fails_npproxy=0
fi

echo "$fails_squid"   > "$STATE_DIR/fails_squid"
echo "$fails_npproxy" > "$STATE_DIR/fails_npproxy"

if [ "$status" = "ok" ]; then
  log "ok squid=$squid_http npproxy=$npproxy_http"
  exit 0
fi
log "DOWN squid=$squid_http/$squid_state npproxy=$npproxy_http/$npproxy_state direct_card=$direct_card direct_pay=$direct_pay fails=$fails_squid/$fails_npproxy"
exit 1
