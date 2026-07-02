#!/bin/bash
# ============================================================
# TriciGo — squid destination anomaly digest (Track 3d, LOG-ONLY).
#
# The squid can't dst-restrict (3-D Secure bank ACS domains are unpredictable),
# so instead of BLOCKING we give VISIBILITY: summarize the CONNECT destinations
# seen in the last window and flag the ones that don't look payment-related, so
# a human can spot the VPS being abused as a general proxy. Never blocks.
#
# Run hourly/daily by systemd or cron. Emits to syslog and (optionally) reports
# a digest to the proxy-health EF. Config: /etc/tricigo/proxy-health.env
# (reuses PROXY_HEALTH_URL + PROXY_HEALTH_SECRET).
#
# Install: see ops/squid/README.md.
# ============================================================
set -u

ACCESS_LOG=/var/log/squid/access.log
ENV_FILE=/etc/tricigo/proxy-health.env
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

# Lax allowlist of expected payment-flow destination substrings. NOT exhaustive
# (ACS domains vary by issuing bank) — anything NOT matching is merely surfaced,
# not blocked.
KNOWN='netopia|mobilpay|3ds|acs|secure|visa|mastercard|amex|americanexpress|maestro|mpi|cardinal|arcot|entersekt|modirum|gpayments'

[ -s "$ACCESS_LOG" ] || { logger -t tricigo-proxy-anomaly "no access log"; exit 0; }

# Extract CONNECT destination hosts (strip :port), tally, split known/unknown.
hosts=$(grep -oE 'CONNECT [^ :]+' "$ACCESS_LOG" 2>/dev/null | awk '{print $2}')
total=$(printf '%s\n' "$hosts" | grep -c . || true)
unknown=$(printf '%s\n' "$hosts" | grep -viE "$KNOWN" | sort | uniq -c | sort -rn | head -20)
unknown_count=$(printf '%s\n' "$hosts" | grep -viE "$KNOWN" | grep -c . || true)

logger -t tricigo-proxy-anomaly "connects=$total unknown_dst=$unknown_count"
if [ -n "$unknown" ]; then
  printf '%s\n' "$unknown" | while read -r line; do
    logger -t tricigo-proxy-anomaly "unknown_dst: $line"
  done
fi

# Optional: report the digest (top unknown destinations) to the EF for the admin.
if [ -n "${PROXY_HEALTH_URL:-}" ] && [ -n "${PROXY_HEALTH_SECRET:-}" ] && [ "${unknown_count:-0}" -gt 0 ]; then
  top=$(printf '%s\n' "$unknown" | head -5 | tr '\n' ';' | sed 's/"/'"'"'/g')
  curl -s --max-time 15 -X POST "$PROXY_HEALTH_URL" \
    -H "Content-Type: application/json" \
    -H "x-proxy-alert-secret: $PROXY_HEALTH_SECRET" \
    -d "{\"source\":\"vps-anomaly\",\"status\":\"info\",\"unknown_dst_count\":$unknown_count,\"top_unknown\":\"$top\"}" \
    >/dev/null 2>&1 || true
fi
exit 0
