// ============================================================
// TriciGo — Process NETOPIA Webhook (IPN) Edge Function
//
// Phase D2. Receives NETOPIA's Instant Payment Notification after
// a hosted-payment-page transaction settles, identifies our
// payment_intent by the orderID NETOPIA echoes back (= our UUID,
// non-guessable), claims atomically (idempotent), calls the credit
// RPC, and ACKs with the NETOPIA-required `{ "errorCode": 0 }`.
//
// Status: SANDBOX-READY — wired to the real NETOPIA v2.x IPN shape
// (see https://secure.sandbox.netopia-payments.com/spec). Status
// codes: 3=paid, 5=confirmed, 12=invalid account, 15=3DS required.
//
// SECURITY MODEL (WPS-01 / AUD-001):
//   The orderID UUID alone is NOT a sufficient defense — the legitimate user gets
//   that UUID from create-netopia-payment-intent, so a forged paid IPN for a
//   self-created intent could mint free top-ups. Authenticity is therefore enforced
//   by an authoritative server-to-server re-query (requeryNetopiaStatus): before
//   moving money on a state-changing IPN we POST /operation/status to NETOPIA with
//   our secret API key and require NETOPIA's own payment.status to confirm it
//   (3/5 = paid; 8/17 = refund/reversal). A forger can't make NETOPIA report a
//   transaction it never processed. Defense layers:
//     1. Re-query gate: LIVE always fails closed if NETOPIA doesn't confirm; sandbox
//        is log-only until platform_config netopia_ipn_enforce_sandbox='true'.
//     2. JWT (Verification-token) is also checked (verifyNetopiaIpnToken) as
//        best-effort defense-in-depth + logging; NOT the gate yet because the POS
//        public key NETOPIA provides does not verify the IPN signature (follow-up).
//     3. Atomic claim: pending|created|failed|expired → processing in one UPDATE; a
//        replay sees 0 rows and exits (no double-credit). Amount is server-side
//        (intent.amount_cup), so amount-tampering is blocked.
//
// Contract: docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md §2
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { decodeProtectedHeader, importX509 } from 'https://esm.sh/jose@5.9.6';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { translateNetopiaError } from '../_shared/netopia-errors.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

/** NETOPIA v2.x IPN body subset we consume. */
interface NetopiaIPNBody {
  payment?: {
    ntpID?: string;
    status?: number;
    method?: string;
    amount?: number;
    currency?: string;
    code?: string;
    message?: string;
    instrument?: {
      panMasked?: string;
      panCategory?: string;
      issuer?: string;
      country?: number;
    };
    token?: string;
    binding?: { token?: string; expireMonth?: number; expireYear?: number };
    data?: Record<string, string>;
  };
  order?: {
    orderID?: string;
    data?: Record<string, string>;
  };
}

/**
 * ACK body NETOPIA expects on a successfully-received IPN. NETOPIA support
 * (2026-06-25) confirmed the notifyURL response MUST be exactly `{"errorCode": 0}`
 * with Content-Type application/json — otherwise it logs
 * IDS_Model_Purchase_Sms_Online_INVALID_RESPONSE_FORMAT and treats the
 * notification as failed (and retries). (Earlier `{code:"0",message:"OK"}` was
 * the v2 SDK shape but this POS/account expects errorCode.)
 */
const ACK_OK = { errorCode: 0 };

/** Map NETOPIA numeric status to our payment_intents.status. */
function mapNetopiaStatus(s: number | undefined): 'paid' | 'failed' | 'pending' | 'refunded' | 'unknown' {
  // NETOPIA v2 status codes (official PHP SDK constants): 3=PAID, 5=CONFIRMED,
  // 4=CANCELED, 8=CREDIT(refund), 12=DECLINED, 13=FRAUD, 14=PENDING_AUTH,
  // 15=3D_AUTH, 17=REVERSED. AUD-010: 4 is CANCELED (not a refund) — refunds/
  // reversals are 8/17. A wallet debit (refunded) is additionally gated behind the
  // server-to-server re-query before it runs.
  if (s === 3 || s === 5) return 'paid';
  if (s === 8 || s === 17) return 'refunded'; // credit / reversal
  if (s === 4 || s === 12 || s === 13) return 'failed'; // canceled / declined / fraud
  if (s === 14 || s === 15) return 'pending'; // pending auth / 3DS still in flight
  return 'unknown';
}

/** UUID v4 sanity check (matches our payment_intents.id format). */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Verify the authenticity of a NETOPIA v2.x IPN (WPS-01 fix).
 *
 * NETOPIA signs every IPN with a JWT carried in the `Verification-token`
 * HTTP header. The JWT is RSA-signed (RS256/384/512) with NETOPIA's private
 * key; we verify it with the POS public certificate downloaded from the admin
 * "Setări tehnice" panel (stored as the NETOPIA_{SANDBOX,LIVE}_PUBLIC_KEY env
 * secret). Three claims must hold:
 *   - iss === "NETOPIA Payments"
 *   - aud === our POS signature (binds the IPN to this POS)
 *   - sub === base64( SHA-512(raw request body) ) (integrity-binds the token to
 *     the exact body received, so a captured token can't be replayed over a
 *     tampered body).
 *
 * A forged IPN can't produce a valid token (no NETOPIA private key); a replayed
 * token over a changed body fails the sub hash. Never throws — any error maps to
 * `{ verified: false }` so the caller decides whether to fail closed.
 *
 * Spec/source: NETOPIA Go SDK ipn.go; docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md §2.
 */
/** Decode a base64url string (JWT segment) to bytes. */
function base64UrlToBytes(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyNetopiaIpnToken(args: {
  token: string | null | undefined;
  rawBody: string;
  posSignature: string;
  publicCertPem: string;
}): Promise<{ verified: boolean; reason: string; alg?: string }> {
  try {
    if (!args.token) return { verified: false, reason: 'missing Verification-token header' };
    if (!args.publicCertPem) return { verified: false, reason: 'public certificate not configured' };
    if (!args.posSignature) return { verified: false, reason: 'POS signature not configured' };

    // Secrets may be stored with literal "\n"; normalize to real newlines for PEM parsing.
    const pem = args.publicCertPem.includes('\\n')
      ? args.publicCertPem.replace(/\\n/g, '\n')
      : args.publicCertPem;

    const parts = args.token.split('.');
    if (parts.length !== 3) return { verified: false, reason: 'malformed JWT (expected 3 parts)' };
    const [headerB64, payloadB64, sigB64] = parts;

    const header = decodeProtectedHeader(args.token);
    const alg = String(header.alg ?? '');
    if (!['RS256', 'RS384', 'RS512'].includes(alg)) {
      return { verified: false, reason: `unexpected JWT alg: ${alg || '(none)'}`, alg };
    }

    // Import the POS public key from the X.509 cert (jose parses the ASN.1 → a
    // WebCrypto RSASSA-PKCS1-v1_5 CryptoKey with the alg's hash). We then verify
    // with crypto.subtle.verify directly rather than jose.jwtVerify because
    // NETOPIA's POS keys are 1024-bit and jose enforces a 2048-bit minimum for
    // RS*; WebCrypto has no such floor and a signature made with NETOPIA's own
    // 1024-bit private key is still authentic.
    const key = await importX509(pem, alg);
    const signature = base64UrlToBytes(sigB64);
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigOk = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, signingInput);
    if (!sigOk) return { verified: false, reason: 'signature verification failed', alg };

    // Decode and validate the claims ourselves (we bypassed jwtVerify above).
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
    } catch {
      return { verified: false, reason: 'payload is not valid JSON', alg };
    }
    if (payload.iss !== 'NETOPIA Payments') {
      return { verified: false, reason: `unexpected iss: ${String(payload.iss)}`, alg };
    }
    const aud = payload.aud;
    const audOk = aud === args.posSignature || (Array.isArray(aud) && aud.includes(args.posSignature));
    if (!audOk) {
      return { verified: false, reason: 'aud does not match POS signature', alg };
    }

    // sub MUST equal base64( SHA-512(raw body) ). Accept standard and url-safe
    // base64, with or without padding, to be tolerant of NETOPIA's encoding.
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-512', new TextEncoder().encode(args.rawBody)),
    );
    let bin = '';
    for (const b of digest) bin += String.fromCharCode(b);
    const b64 = btoa(bin);
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    const subStripped = sub.replace(/=+$/, '');
    if (sub !== b64 && sub !== b64url && subStripped !== b64.replace(/=+$/, '') && subStripped !== b64url) {
      // sub is a SHA-512 hash, not a secret — log both sides to diagnose any
      // encoding mismatch against a real IPN during sandbox validation.
      console.warn(`[netopia] IPN sub mismatch — claimed="${sub.slice(0, 120)}" computed_b64="${b64}" computed_b64url="${b64url}"`);
      return { verified: false, reason: 'body hash (sub) mismatch', alg };
    }

    return { verified: true, reason: 'ok', alg };
  } catch (err) {
    return { verified: false, reason: `verify error: ${String((err as Error)?.message ?? err)}` };
  }
}

/** Base URL for the NETOPIA v2 status re-query, per environment (env-overridable). */
function netopiaStatusBase(env: 'sandbox' | 'live'): string {
  // Match create-netopia-payment-intent's host per environment. LIVE routes
  // through the VPS nginx proxy (tricigo.com/np-proxy/* → secure.mobilpay.ro/pay/*)
  // because NETOPIA's live edge blocks Supabase's datacenter IPs with a 403; the
  // VPS static IP is not blocked. Guarded by x-proxy-secret (see requeryNetopiaStatus).
  // SANDBOX stays direct (secure.sandbox.netopia-payments.com, no proxy). Both
  // overridable via env var.
  if (env === 'live') {
    return Deno.env.get('NETOPIA_LIVE_STATUS_BASE') ?? 'https://tricigo.com/np-proxy';
  }
  return Deno.env.get('NETOPIA_SANDBOX_STATUS_BASE') ?? 'https://secure.sandbox.netopia-payments.com';
}

/**
 * Server-to-server re-query of a payment's authoritative status (WPS-01 gate).
 *
 * POST {base}/operation/status with the RAW secret API key in the Authorization
 * header (no "Bearer") and body { posID, ntpID, orderID }. The trusted response's
 * payment.status is what we gate on (3=paid, 5=confirmed). This is forgery-proof:
 * an attacker cannot make NETOPIA report a paid transaction it never processed.
 * Never throws — any failure maps to confirmedPaid=false so the caller fails closed.
 *
 * Source: NETOPIA Go/PHP/Python SDKs (client.GetStatus / Status::getStatus).
 */
async function requeryNetopiaStatus(args: {
  env: 'sandbox' | 'live';
  apiKey: string;
  posSignature: string;
  ntpId: string;
  orderId: string;
}): Promise<{ status: number | null; confirmedPaid: boolean; reason: string; httpStatus?: number }> {
  try {
    if (!args.apiKey) return { status: null, confirmedPaid: false, reason: 'api key not configured' };
    if (!args.posSignature) return { status: null, confirmedPaid: false, reason: 'POS signature not configured' };
    const url = `${netopiaStatusBase(args.env)}/operation/status`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': args.apiKey, // raw API key, no "Bearer" (v2.x scheme)
          // LIVE routes through the VPS nginx proxy (see netopiaStatusBase); the
          // proxy forwards only when this shared secret matches. No-op in sandbox.
          ...(args.env === 'live' && Deno.env.get('NETOPIA_PROXY_SECRET')
            ? { 'x-proxy-secret': Deno.env.get('NETOPIA_PROXY_SECRET')! }
            : {}),
        },
        body: JSON.stringify({ posID: args.posSignature, ntpID: args.ntpId, orderID: args.orderId }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return { status: null, confirmedPaid: false, reason: 'status re-query timed out after 15s' };
      }
      throw err;
    }

    const text = await resp.text();
    let parsed: { payment?: { status?: number }; error?: { code?: string; message?: string } } = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      return {
        status: null,
        confirmedPaid: false,
        reason: `non-JSON status response (HTTP ${resp.status}): ${text.slice(0, 200)}`,
        httpStatus: resp.status,
      };
    }
    const st = typeof parsed?.payment?.status === 'number' ? parsed.payment.status : null;
    if (st === null) {
      const errInfo = parsed?.error?.code ?? parsed?.error?.message ?? 'none';
      return { status: null, confirmedPaid: false, reason: `no payment.status (HTTP ${resp.status}, error=${errInfo})`, httpStatus: resp.status };
    }
    return { status: st, confirmedPaid: st === 3 || st === 5, reason: 'ok', httpStatus: resp.status };
  } catch (err) {
    return { status: null, confirmedPaid: false, reason: `status re-query error: ${String((err as Error)?.message ?? err)}` };
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_048_576) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
  }

  try {
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`process-netopia-webhook:${clientIP}`, 50, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── 1. Parse body ──
    const rawBody = await req.text();
    let ipn: NetopiaIPNBody;
    try {
      ipn = JSON.parse(rawBody) as NetopiaIPNBody;
    } catch (err) {
      console.error('[netopia] IPN body is not JSON:', err, rawBody.slice(0, 200));
      return new Response(
        JSON.stringify({ error: 'Invalid JSON' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const orderId = ipn.order?.orderID ?? '';
    const ntpId = ipn.payment?.ntpID ?? '';
    const status = mapNetopiaStatus(ipn.payment?.status);

    if (!orderId || !isUuid(orderId)) {
      console.error('[netopia] IPN orderID missing or not a UUID:', orderId);
      return new Response(
        JSON.stringify({ error: 'Missing/invalid orderID' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (!ntpId) {
      console.error('[netopia] IPN ntpID missing');
      return new Response(
        JSON.stringify({ error: 'Missing ntpID' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`[netopia] IPN received: intent=${orderId} ntp=${ntpId} status=${ipn.payment?.status} mapped=${status} ip=${clientIP}`);

    // Log the source IP for future allowlist tightening.

    // ── 2. Lookup our intent ──
    // `stripe_payment_intent_id` here is NETOPIA's ntpID (column name
    // is legacy from the Stripe era). We need it for the failed→paid
    // recovery check below: if a prior IPN already stamped a different
    // ntpID we treat the second IPN as a separate transaction and
    // refuse the recovery.
    const { data: existingIntent } = await supabase
      .from('payment_intents')
      .select('id, status, user_id, amount_cup, intent_type, corporate_account_id, payment_provider, stripe_payment_intent_id')
      .eq('id', orderId)
      .single();

    if (!existingIntent) {
      // Unknown orderID → can't be ours. UUIDs are non-guessable so
      // this is either a misrouted IPN or an attempted forgery.
      console.error(`[netopia] payment_intent not found: ${orderId} (ip=${clientIP})`);
      return new Response(
        JSON.stringify({ error: 'Unknown orderID' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (existingIntent.payment_provider !== 'netopia') {
      console.error(`[netopia] payment_intent ${orderId} belongs to ${existingIntent.payment_provider}, not netopia`);
      return new Response(
        JSON.stringify({ error: 'Provider mismatch' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 2b. AUTHENTICITY VERIFICATION (WPS-01 / AUD-001 fix) ──
    // Primary gate = server-to-server status re-query (requeryNetopiaStatus): ask
    // NETOPIA directly, with our secret API key, whether this ntpID/orderID is
    // genuinely paid. A forged IPN can't make NETOPIA report a paid transaction it
    // never processed, so this is authenticity-by-authority and needs no signing key.
    // The Verification-token JWT is ALSO checked (verifyNetopiaIpnToken) but only as
    // best-effort defense-in-depth + logging — it is NOT the gate today because the
    // POS public key NETOPIA provides does not verify the IPN signature (open
    // follow-up). See docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md §2.
    const { data: envRows } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', ['netopia_environment', 'netopia_sandbox_signature', 'netopia_live_signature', 'netopia_ipn_enforce_sandbox']);
    const ntpCfg: Record<string, string> = {};
    (envRows ?? []).forEach((r: { key: string; value: unknown }) => {
      const v = r.value;
      ntpCfg[r.key] = typeof v === 'string' && v.startsWith('"') ? JSON.parse(v) : String(v ?? '');
    });
    const netopiaEnv: 'sandbox' | 'live' = ntpCfg['netopia_environment'] === 'live' ? 'live' : 'sandbox';
    const posSignature = netopiaEnv === 'live'
      ? (ntpCfg['netopia_live_signature'] ?? '')
      : (ntpCfg['netopia_sandbox_signature'] ?? '');
    const publicCertPem = netopiaEnv === 'live'
      ? (Deno.env.get('NETOPIA_LIVE_PUBLIC_KEY') ?? '')
      : (Deno.env.get('NETOPIA_SANDBOX_PUBLIC_KEY') ?? '');
    const apiKey = netopiaEnv === 'live'
      ? (Deno.env.get('NETOPIA_LIVE_API_KEY') ?? '')
      : (Deno.env.get('NETOPIA_SANDBOX_API_KEY') ?? '');
    const enforceSandbox = ntpCfg['netopia_ipn_enforce_sandbox'] === 'true';
    const verificationToken = req.headers.get('Verification-token') ?? req.headers.get('verification-token');

    // Best-effort JWT verification (logged, not the gate).
    const ipnAuth = await verifyNetopiaIpnToken({ token: verificationToken, rawBody, posSignature, publicCertPem });

    // Authoritative gate: re-query NETOPIA for state-changing IPNs only.
    const stateChanging = status === 'paid' || status === 'refunded';
    let requery: { status: number | null; confirmedPaid: boolean; reason: string; httpStatus?: number } =
      { status: null, confirmedPaid: false, reason: 'not-checked' };
    if (stateChanging) {
      requery = await requeryNetopiaStatus({ env: netopiaEnv, apiKey, posSignature, ntpId, orderId });
    }

    console.log('[netopia] IPN authenticity:', JSON.stringify({
      env: netopiaEnv,
      mapped: status,
      headerPresent: !!verificationToken,
      jwt: { verified: ipnAuth.verified, reason: ipnAuth.reason },
      requery: { status: requery.status, confirmedPaid: requery.confirmedPaid, reason: requery.reason, httpStatus: requery.httpStatus },
    }));

    // Persist both verdicts alongside the IPN body for audit/forensics (queryable as
    // payment_intents.webhook_payload._ipn_requery / _ipn_auth). NOTE: on the paid
    // success path the credit RPC overwrites webhook_payload, so the success signal is
    // status='completed'; the reject path below persists this verdict for diagnosis.
    const ipnStored = {
      ...(ipn as Record<string, unknown>),
      _ipn_requery: requery,
      _ipn_auth: ipnAuth,
      _ipn_header_present: !!verificationToken,
    } as Record<string, unknown>;

    // Gate: NETOPIA's authoritative re-query must independently confirm the IPN's
    // claimed state before we move money.
    //   paid     -> NETOPIA status 3 (paid) / 5 (confirmed)
    //   refunded -> NETOPIA status 8 (credit/refund) / 17 (reversed)
    // Always fail closed in LIVE; in sandbox, log-only until netopia_ipn_enforce_sandbox=true.
    if (stateChanging) {
      const gateOk = status === 'paid'
        ? requery.confirmedPaid
        : (requery.status === 8 || requery.status === 17);
      if (!gateOk) {
        if (netopiaEnv === 'live' || enforceSandbox) {
          console.error(
            `[netopia] CRITICAL (WPS-01): refusing to process intent ${orderId} — re-query did NOT confirm ` +
            `(mapped=${status}, requery.status=${requery.status}, reason=${requery.reason}). ` +
            `env=${netopiaEnv} ip=${clientIP} ntp=${ntpId}. Intent left untouched for reconciliation.`,
          );
          // Persist the verdict for forensics (status is NOT changed here).
          await supabase.from('payment_intents')
            .update({ webhook_payload: ipnStored, updated_at: new Date().toISOString() })
            .eq('id', orderId);
          return new Response(
            JSON.stringify({ error: 'ipn_authenticity_unverified', detail: requery.reason }),
            { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
        console.warn(
          `[netopia] SANDBOX log-only: processing intent ${orderId} despite re-query not confirming ` +
          `(requery.status=${requery.status}, reason=${requery.reason}). Set netopia_ipn_enforce_sandbox=true to enforce.`,
        );
      }
    }

    // ── 3. Branch on status ──

    if (status === 'paid') {
      if (existingIntent.status === 'completed') {
        console.log(`[netopia] Intent ${orderId} already completed — replay skipped`);
        return new Response(JSON.stringify(ACK_OK), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // BUG-FIX (2026-05-23, intent d3fc744f): NETOPIA observed sending
      // two IPNs for the same transaction — first an interim status=12
      // ("Invalid CVV"), then ~20s later the final status=3 (paid). The
      // first IPN marks our intent as 'failed'. The second IPN reaches
      // this branch but used to be silently skipped because the atomic
      // claim filter was `.in('status', ['pending', 'created'])` — it
      // refused to recover from 'failed'. Result: card was charged,
      // wallet was NEVER credited.
      //
      // Fix: allow the atomic claim to include 'failed' as a recoverable
      // prior state. Defensive ntpID check: if the prior 'failed' IPN
      // stamped a different ntpID than this paid IPN, we're looking at
      // two distinct NETOPIA transactions on the same orderID, which
      // would be a serious anomaly — refuse the recovery and signal
      // NETOPIA to retry so a human can investigate.
      if (existingIntent.status === 'failed') {
        const priorNtp = existingIntent.stripe_payment_intent_id;
        if (priorNtp && priorNtp !== ntpId) {
          console.error(
            `[netopia] DISCREPANCY: paid IPN for intent ${orderId} ntpID=${ntpId} ` +
            `but prior failed IPN had ntpID=${priorNtp} — refusing to credit, manual review needed`,
          );
          return new Response(
            JSON.stringify({ error: 'ntpid_mismatch_after_failure', detail: 'See logs' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
        console.warn(
          `[netopia] Recovering intent ${orderId} from 'failed' → 'paid' ` +
          `(ntpID=${ntpId}) — prior IPN was a non-final status from NETOPIA`,
        );
      }

      // Atomic idempotency claim. Includes 'failed' AND 'expired' as recoverable
      // states and clears any stale error_message from a prior interim IPN.
      // CRON-01 (audit 2026-06-14): the expire-stale-payment-intents cron flips
      // created|pending → 'expired' after 1h. A legitimately PAID IPN can arrive
      // later (3DS challenge, hosted-page abandon-then-complete, delayed
      // settlement, NETOPIA's documented interim-then-final two-IPN pattern). If
      // 'expired' were not recoverable, the card would be charged but the wallet
      // never credited and NETOPIA would never retry (same money-loss class as
      // the d3fc744f 'failed' fix). An expired intent has no prior ntpID, so it
      // skips the failed-recovery ntpID guard above.
      if (existingIntent.status === 'expired') {
        console.warn(`[netopia] Recovering intent ${orderId} from 'expired' → 'paid' (ntpID=${ntpId}) — paid IPN arrived after the 1h expiry cron`);
      }
      const { data: claimed, error: claimError } = await supabase
        .from('payment_intents')
        .update({
          status: 'processing',
          error_message: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .in('status', ['pending', 'created', 'failed', 'expired'])
        .select();

      if (claimError || !claimed || claimed.length === 0) {
        console.log(`[netopia] Intent ${orderId} already claimed — replay skipped`);
        return new Response(JSON.stringify(ACK_OK), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Persist NETOPIA's ntpID and card details before crediting.
      try {
        await supabase
          .from('payment_intents')
          .update({
            stripe_payment_intent_id: ntpId,
            card_brand: ipn.payment?.instrument?.issuer ?? null,
            card_last4: (ipn.payment?.instrument?.panMasked ?? '').slice(-4) || null,
            webhook_payload: ipnStored,
          })
          .eq('id', orderId);
      } catch (metaErr) {
        console.warn(`[netopia] Card metadata update skipped: ${metaErr}`);
      }

      // Call the credit RPC. As of migration 00282 the canonical name
      // is `process_recharge_payment`; `process_stripe_recharge` still
      // exists as a thin wrapper for backwards compat but should no
      // longer be referenced by new code.
      const webhookPayload = {
        netopia_ntp_id: ntpId,
        amount: ipn.payment?.amount,
        currency: ipn.payment?.currency,
        netopia_status: ipn.payment?.status,
      };

      const { data: txnId, error: processError } = await supabase.rpc(
        'process_recharge_payment',
        {
          p_payment_intent_id: orderId,
          p_webhook_payload: webhookPayload,
        },
      );

      if (processError) {
        console.error('[netopia] Error processing recharge:', processError);
        return new Response(
          JSON.stringify({ error: 'process_error', detail: processError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      console.log(`[netopia] Recharge processed: ${orderId} → txn ${txnId}`);

      await sendPaymentNotification(supabase, existingIntent.user_id, existingIntent.amount_cup, true);

      // Asynchronously trigger the receipt PDF. Mirror of the Stripe webhook
      // flow that was removed during the cutover (PR #137). The receipt EF
      // is idempotent on payment_intent_id (UNIQUE in wallet_receipts) so
      // re-invocation is safe. We do NOT await — receipt rendering takes a
      // few seconds and would push us past NETOPIA's IPN timeout window.
      // Gated by corporate_account_id because B2B recharges have their own
      // invoicing flow and don't get the individual PDF receipt.
      if (!existingIntent.corporate_account_id) {
        fetch(`${supabaseUrl}/functions/v1/generate-recharge-receipt`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': serviceRoleKey,
            'Authorization': `Bearer ${serviceRoleKey}`,
          },
          body: JSON.stringify({ payment_intent_id: orderId }),
        }).catch((efErr) => {
          console.error(`[netopia] generate-recharge-receipt trigger failed for ${orderId}:`, efErr);
        });
      }

      return new Response(JSON.stringify(ACK_OK), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (status === 'failed') {
      const failReason = ipn.payment?.message ?? `NETOPIA status ${ipn.payment?.status}`;
      const providerCode = ipn.payment?.code ?? null;

      // Best-effort update including the new provider_error_code column
      // (migration 00286). If the column doesn't exist yet in this env
      // (pre-migration deploy), retry without it so the webhook still
      // marks the intent failed and notifies the user.
      const { error: updateErr } = await supabase
        .from('payment_intents')
        .update({
          status: 'failed',
          error_message: failReason,
          provider_error_code: providerCode,
          webhook_payload: ipnStored,
          stripe_payment_intent_id: ntpId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .in('status', ['created', 'pending', 'processing']);

      if (updateErr && /provider_error_code|column.*does not exist|schema cache/i.test(updateErr.message)) {
        console.warn(`[netopia] provider_error_code column missing — retrying without it (apply migration 00286): ${updateErr.message}`);
        await supabase
          .from('payment_intents')
          .update({
            status: 'failed',
            error_message: failReason,
            webhook_payload: ipnStored,
            stripe_payment_intent_id: ntpId,
            updated_at: new Date().toISOString(),
          })
          .eq('id', orderId)
          .in('status', ['created', 'pending', 'processing']);
      } else if (updateErr) {
        console.error('[netopia] failed-branch update error:', updateErr);
      }

      await sendPaymentNotification(supabase, existingIntent.user_id, existingIntent.amount_cup, false, failReason);

      console.log(`[netopia] Payment failed: ${orderId} — ${failReason} (provider_code=${providerCode ?? 'none'})`);

      return new Response(JSON.stringify(ACK_OK), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (status === 'refunded') {
      // Admin-initiated refund from NETOPIA's POS dashboard. We can only
      // refund what was previously credited — if the intent never
      // completed, there's nothing to reverse.
      if (existingIntent.status !== 'completed') {
        console.warn(
          `[netopia] Refund IPN for non-completed intent ${orderId} (status=${existingIntent.status}) — ignoring`,
        );
        return new Response(JSON.stringify(ACK_OK), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // RPC is idempotent on idempotency_key='recharge_refund_<intent>'.
      // Replays of the same refund IPN are no-ops on the wallet side.
      const refundPayload = {
        netopia_ntp_id: ntpId,
        amount: ipn.payment?.amount,
        currency: ipn.payment?.currency,
        netopia_status: ipn.payment?.status,
        netopia_message: ipn.payment?.message,
      };

      const { error: refundError } = await supabase.rpc('process_recharge_refund', {
        p_payment_intent_id: orderId,
        p_webhook_payload: refundPayload,
      });

      if (refundError) {
        // If the RPC reports already-refunded, ACK and move on. Anything
        // else is an unexpected failure we want to retry by returning 5xx.
        if (/already refunded|idempotency/i.test(refundError.message)) {
          console.log(`[netopia] Refund replay for ${orderId} — already processed`);
          return new Response(JSON.stringify(ACK_OK), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        console.error('[netopia] Refund RPC failed:', refundError);
        return new Response(
          JSON.stringify({ error: 'refund_error', detail: refundError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Stash the webhook payload alongside the existing one — the
      // original 'paid' IPN is preserved by storing the refund under a
      // new column would be cleaner, but we don't have one yet, so we
      // overwrite. Acceptable for now; audit trail lives in the new
      // ledger_transactions row.
      await supabase
        .from('payment_intents')
        .update({
          webhook_payload: ipnStored,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      await sendRefundNotification(supabase, existingIntent.user_id, existingIntent.amount_cup);

      console.log(`[netopia] Refund processed for ${orderId}`);

      return new Response(JSON.stringify(ACK_OK), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // status === 'pending' (3DS still in flight) or 'unknown' — just ACK,
    // do not change wallet state. A subsequent IPN with status=paid/failed
    // will land here once 3DS resolves.
    console.log(`[netopia] IPN ack'd without state change for intent ${orderId} (mapped=${status})`);
    return new Response(JSON.stringify(ACK_OK), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Unexpected error in process-netopia-webhook:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

/**
 * Send a push notification about recharge result. Mirrors the Stripe
 * implementation so users get the same UX regardless of provider.
 *
 * The optional `failReason` argument is the raw NETOPIA message
 * (e.g. "Invalid CVV"). When present and `success=false`, the push
 * body includes the translated reason so the user knows WHY the
 * payment was rejected without opening the app.
 */
async function sendPaymentNotification(
  _supabase: ReturnType<typeof createClient>,
  userId: string,
  amountCup: number,
  success: boolean,
  failReason?: string | null,
): Promise<void> {
  try {
    const formattedAmount = amountCup.toLocaleString('es-CU');
    const title = success ? 'Recarga exitosa' : 'Recarga fallida';

    // For failed recharges, surface the translated reason in the push
    // body so the user immediately knows whether it was a CVV issue,
    // insufficient funds, etc. Trim to the first sentence so the body
    // stays under most platform truncation thresholds.
    let body: string;
    if (success) {
      body = `Tu recarga de ${formattedAmount} CUP ha sido acreditada a tu wallet.`;
    } else if (failReason) {
      const friendly = translateNetopiaError(failReason);
      const firstSentence = friendly.split('. ')[0] + (friendly.includes('. ') ? '.' : '');
      body = `Recarga de ${formattedAmount} CUP rechazada: ${firstSentence}`;
    } else {
      body = `Tu recarga de ${formattedAmount} CUP no pudo ser procesada.`;
    }

    // Route through send-push EF so the push gets:
    //   • dead token cleanup (DeviceNotRegistered tickets)
    //   • persistence to the `notifications` inbox table
    //   • category validation against VALID_CATEGORIES
    // Previously we called Expo's API directly and bypassed all three.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    await fetch(`${supabaseUrl}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        user_id: userId,
        title,
        body,
        category: 'wallet_recharge',
        data: { type: 'wallet_recharge', success: String(success), provider: 'netopia' },
      }),
    });
  } catch (err) {
    console.error('[netopia] Error sending payment notification:', err);
  }
}

/**
 * Send a push notification about a refunded recharge. The wallet has
 * already been debited by `process_recharge_refund` at this point —
 * this is just the user-facing announcement.
 */
async function sendRefundNotification(
  _supabase: ReturnType<typeof createClient>,
  userId: string,
  amountCup: number,
): Promise<void> {
  try {
    const formattedAmount = amountCup.toLocaleString('es-CU');

    // Route through send-push EF (same reasoning as sendPaymentNotification):
    // dead token cleanup + inbox persistence + category validation.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    await fetch(`${supabaseUrl}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        user_id: userId,
        title: 'Recarga reembolsada',
        body: `Tu recarga de ${formattedAmount} CUP fue reembolsada. Si tienes dudas, escríbenos a soporte@tricigo.com.`,
        category: 'wallet_recharge_refund',
        data: { type: 'wallet_recharge_refund', provider: 'netopia' },
      }),
    });
  } catch (err) {
    console.error('[netopia] Error sending refund notification:', err);
  }
}
