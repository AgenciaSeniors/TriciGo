# NETOPIA in-app payment proxy — VPS squid

The NETOPIA hosted card page (`secure.mobilpay.ro/ui/card`) returns **HTTP 403**
(Google Cloud Armor) to reputation-flagged client IPs (Cuban ETECSA, etc.). The
in-app payment WebView (`NetopiaCheckout`, gated by `platform_config.netopia_proxy_enabled`)
routes through a **CONNECT proxy on the VPS** (`187.77.214.236:13128`, clean IP),
so NETOPIA's edge sees the VPS IP. TLS passthrough (no SSL-bump) → the VPS never
sees the card → stays **PCI SAQ-A**. **NEVER enable `ssl_bump`.**

## Authentication (so it isn't an open proxy)

Android's `ProxyController` can't carry proxy credentials. The intended auth path
is: the squid is an **HTTP proxy** (`http_port`), so the `407` *should* surface to
the WebView's `onReceivedHttpAuthRequest` → answered by the `basicAuthCredential`
prop.

> ⚠️ **UNVERIFIED on Android — device-test this BEFORE activation.** Android may
> handle a CONNECT-proxy `407` internally (no public WebView hook), in which case
> an auth-required squid would **brick** the in-app checkout on Android (the very
> platform this feature targets). If the on-device test fails, the squid must run
> **no-auth** and be protected another way (e.g. a dst-allowlist that still permits
> the unpredictable 3DS bank ACS domains). iOS 17+ is fine either way
> (`ProxyConfiguration.applyCredential`).

`hmac_auth.sh` (this dir) is the squid Basic-auth helper. It accepts:

- **(a) static cred** `tricigo:<pass>` — validated against the existing
  `/etc/squid/passwd` via `basic_ncsa_auth`. **squid-side curl/dev smoke ONLY** —
  the APP no longer sends a static cred (it was removed from getNetopiaProxyConfig
  because `platform_config` is client-readable; do NOT set `netopia_proxy_user/_pass`).
- **(b) ephemeral token** minted by the `mint-netopia-proxy-credential` EF:
  - `username = <expiry-unix-epoch>` · `password = hex(HMAC-SHA256(username, SECRET))`
  - Stateless: the helper re-derives the HMAC + checks expiry. A leaked token
    dies at expiry (~10 min). Secret lives only in `/etc/squid/hmac_secret` and
    the EF secret `NETOPIA_PROXY_HMAC_SECRET` (same value). Verified: the EF's
    `crypto.subtle` HMAC == the helper's `openssl dgst -sha256 -hmac`.

## Activation runbook (manual — touches the prod VPS + EF; authorize each)

1. **Install the helper + generate the secret on the VPS:**
   ```sh
   scp ops/squid/hmac_auth.sh root@187.77.214.236:/etc/squid/hmac_auth.sh
   ssh root@187.77.214.236 'chmod 755 /etc/squid/hmac_auth.sh
     [ -s /etc/squid/hmac_secret ] || openssl rand -hex 32 > /etc/squid/hmac_secret
     # squid spawns auth helpers as the cache_effective_user (proxy on Debian/Ubuntu),
     # so the secret MUST be readable by that user — root:root + 600 makes the helper
     # read it empty and ALL ephemeral tokens silently 407. chown to proxy:
     chown proxy:proxy /etc/squid/hmac_secret && chmod 600 /etc/squid/hmac_secret'
   ```
   ⚠️ The static-cred `curl` smoke (below) returns 200 even if the HMAC secret is
   unreadable — so ALSO run the helper unit-test (below) to confirm the EPHEMERAL
   path before flipping the flag.
2. **Point squid at the helper** — set `/etc/squid/squid.conf`:
   ```
   http_port 13128
   auth_param basic program /etc/squid/hmac_auth.sh
   auth_param basic children 5
   auth_param basic realm tricigo
   auth_param basic credentialsttl 2 minutes
   acl authed proxy_auth REQUIRED
   acl SSL_ports port 443
   acl CONNECT method CONNECT
   http_access deny CONNECT !SSL_ports
   http_access allow CONNECT SSL_ports authed
   http_access deny all
   cache deny all
   ```
   Then `squid -k parse && squid -k reconfigure`. (Back up the old conf first.)
3. **Give the EF the same secret:** `supabase secrets set NETOPIA_PROXY_HMAC_SECRET=<the value of /etc/squid/hmac_secret>` (run from an empty dir). Optionally `NETOPIA_PROXY_HOST` / `NETOPIA_PROXY_PORT`.
4. **Deploy the EF:** `npx supabase functions deploy mint-netopia-proxy-credential --project-ref lqaufszburqvlslpcuac` (config.toml pins `verify_jwt = false`; it does its own `auth.getUser`).
5. **Flip the client flag:** `platform_config.netopia_proxy_enabled = 'true'`. (The app uses ONLY the ephemeral mint EF for proxy auth — the static `netopia_proxy_user`/`_pass` keys were removed from the app, so do NOT set them.)
6. **Rebuild the apps** (the `webview-proxy` native module must be in the APK — driver + store builds don't have it yet) and run the on-device validation (below).

## Validation (no app needed)

```sh
# squid auth required (no creds -> rejected; static cred -> tunnels)
curl -s -x http://187.77.214.236:13128 -o /dev/null -w '%{http_code}\n' https://secure.mobilpay.ro/ui/card        # 000 (denied)
curl -s -x "http://tricigo:<pass>@187.77.214.236:13128" -o /dev/null -w '%{http_code}\n' https://secure.mobilpay.ro/ui/card  # 200

# helper unit-test (on the VPS): fresh token OK, expired/forged ERR
ssh root@187.77.214.236 'S=$(cat /etc/squid/hmac_secret); E=$(( $(date +%s)+600 ));
  P=$(printf %s "$E" | openssl dgst -sha256 -hmac "$S" -r | cut -d" " -f1);
  printf "%s %s\n" "$E" "$P" | /etc/squid/hmac_auth.sh;          # OK
  printf "%s %s\n" 1000000000 "$P" | /etc/squid/hmac_auth.sh;    # ERR (expired)
  printf "%s %s\n" "$E" deadbeef | /etc/squid/hmac_auth.sh'      # ERR (bad sig)
```

On-device (Android): open `/dev/proxy-test`, fill `user`+`pass` (static cred for a
quick check, or leave blank for no-auth if testing the no-auth path), Proxy ON +
Load → the squid `access.log` shows the CONNECT with the authenticated user.

## Status (2026-06-26)

Code shipped on branch `claude/netopia-ack-errorcode` (PR #664), **NOT activated**:
the EF + helper + app wiring exist; the prod squid still uses the static
`basic_ncsa_auth` (auth-required, validated by curl). The crypto match
(openssl ⇄ crypto.subtle) is verified. Pending: the on-device proxy-auth
validation (basicAuthCredential answers the 407), then the activation steps above.
