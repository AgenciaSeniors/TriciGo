// ============================================================
// mint-netopia-proxy-credential
//
// Mints a SHORT-LIVED Basic-auth credential for the in-app NETOPIA payment
// proxy (the VPS squid). Android's WebView ProxyController cannot carry proxy
// credentials, so the in-app WebView answers the proxy's 407 with the
// `basicAuthCredential` prop — this EF supplies an EPHEMERAL token instead of a
// static, client-readable password (which, if leaked, would be a standing
// open-ish tunnel to the VPS).
//
// Token format (validated STATELESSLY by the squid's hmac_auth.sh helper — no
// shared store):
//     username = <expiry-unix-epoch>                       (seconds, as a string)
//     password = hex( HMAC-SHA256( username, NETOPIA_PROXY_HMAC_SECRET ) )
// The squid re-derives the HMAC and checks the embedded expiry, so a leaked
// token simply dies at its expiry (~10 min, one checkout). The HMAC secret
// lives only in this EF's env (NETOPIA_PROXY_HMAC_SECRET) and /etc/squid/hmac_secret.
//
// verify_jwt = false at the gateway; we do our OWN Bearer-token auth via
// auth.getUser (only a logged-in user may mint a proxy credential).
//
// Returns: { ok:true, host, port, username, password, expiresAt }
//        | { ok:false, error } with a 4xx/5xx.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit } from '../_shared/rate-limiter.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);
const TTL_SECONDS = 600; // 10 min — covers one hosted-page checkout + 3DS.
const PROXY_HOST = Deno.env.get('NETOPIA_PROXY_HOST') || '187.77.214.236';
const PROXY_PORT = parseInt(Deno.env.get('NETOPIA_PROXY_PORT') || '13128', 10);

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

function jsonResponse(req: Request, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// HMAC-SHA256(message, secret) → lowercase hex. Matches the squid helper's
// `openssl dgst -sha256 -hmac "$SECRET"` (both RFC 2104 over the same UTF-8 bytes).
async function hmacHex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toHex(sig);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') return jsonResponse(req, { ok: false, error: 'method not allowed' }, 405);

  const secret = Deno.env.get('NETOPIA_PROXY_HMAC_SECRET');
  if (!secret) return jsonResponse(req, { ok: false, error: 'proxy auth not configured' }, 503);

  // Auth: require a logged-in user (verify_jwt=false → validate the Bearer here).
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return jsonResponse(req, { ok: false, error: 'unauthorized' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey =
    Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser(token);
  if (authErr || !user) return jsonResponse(req, { ok: false, error: 'unauthorized' }, 401);

  // Rate-limit per user: a token is a 10-min CONNECT-tunnel grant, so cap minting
  // so a compromised/automated account can't flood the proxy. 10/min is generous
  // for legit checkout retries.
  const rl = await rateLimit(`mint-netopia-proxy:${user.id}`, 10, 60_000);
  if (!rl.allowed) return jsonResponse(req, { ok: false, error: 'rate_limited' }, 429);

  const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const username = String(expiry);
  const password = await hmacHex(username, secret);

  return jsonResponse(
    req,
    { ok: true, host: PROXY_HOST, port: PROXY_PORT, username, password, expiresAt: expiry },
    200,
  );
});
