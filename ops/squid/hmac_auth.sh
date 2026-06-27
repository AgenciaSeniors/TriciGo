#!/bin/bash
# Squid Basic-auth helper for the NETOPIA in-app payment proxy.
# Reads "username password" lines on stdin, replies "OK" / "ERR" (squid basic
# auth helper protocol). Accepts EITHER:
#   (a) the static cred  tricigo:<pass>  — delegated to the existing htpasswd via
#       basic_ncsa_auth (transition + dev/curl; rotatable).
#   (b) an EPHEMERAL token minted by the mint-netopia-proxy-credential EF:
#         username = <expiry-unix-epoch>   (>=10 digit seconds)
#         password = hex( HMAC-SHA256( username, NETOPIA_PROXY_HMAC_SECRET ) )
# Ephemeral tokens are STATELESS (no shared store): the helper re-derives the HMAC
# and checks the embedded expiry, so a leaked token dies at its expiry. The HMAC
# secret lives only in /etc/squid/hmac_secret (root, 600) and the EF's Supabase
# secret NETOPIA_PROXY_HMAC_SECRET. CONNECT is still restricted to :443 in squid.conf.
#
# Deploy: see ops/squid/README.md. Install to /etc/squid/hmac_auth.sh (chmod 755).
exec 2>/dev/null
SECRET=$(cat /etc/squid/hmac_secret 2>/dev/null)
STATIC_USER=tricigo
NCSA=/usr/lib/squid/basic_ncsa_auth
PASSWD=/etc/squid/passwd

while read -r u p; do
  # (a) static cred -> existing htpasswd
  if [ "$u" = "$STATIC_USER" ] && [ -x "$NCSA" ]; then
    if [ "$(printf '%s %s\n' "$u" "$p" | "$NCSA" "$PASSWD" 2>/dev/null | head -1)" = "OK" ]; then
      echo "OK"; continue
    fi
  fi
  # (b) ephemeral HMAC token: username is a 10+ digit epoch, still in the future
  if [ -n "$SECRET" ] && printf '%s' "$u" | grep -qE '^[0-9]{10,}$'; then
    now=$(date +%s)
    if [ "$u" -ge "$now" ]; then
      exp=$(printf '%s' "$u" | openssl dgst -sha256 -hmac "$SECRET" -r 2>/dev/null | cut -d' ' -f1)
      if [ -n "$exp" ] && [ "$p" = "$exp" ]; then echo "OK"; continue; fi
    fi
  fi
  echo "ERR"
done
