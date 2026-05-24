// ============================================================
// TriciGo — Create NETOPIA Payment Intent Edge Function
//
// Phase D2. Provider-agnostic recharge entrypoint for NETOPIA
// Payments. Mirrors create-stripe-payment-intent in structure
// (JWT auth, OFAC region block, rate limit, velocity check,
// payment_intents insert) and differs only at the provider call:
// NETOPIA uses a hosted payment page (redirect-based) instead of
// Stripe Elements (clientSecret-based).
//
// Status: SANDBOX-READY — the real NETOPIA v2.x Payments API
// is wired. v2.x auth is a raw API KEY in the `Authorization`
// header (not RSA-signed bodies; that was the v1.x legacy flow).
// The API KEY is generated in NETOPIA admin → Profile → Security
// and lives in Deno env (NETOPIA_*_API_KEY). The POS signature
// from the dashboard (`Semnătură`, e.g. 3E0W-SECV-NYE1-RE28-TKBX)
// lives in platform_config and is sent in the request body as
// `order.posSignature`.
//
// Spec: https://secure.sandbox.netopia-payments.com/spec
// Contract: docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md §1
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

interface CreateIntentRequest {
  user_id: string;
  /**
   * RECARGA V2: the user picks the NET amount in USD that they want to
   * receive as wallet credit. The fee is applied ADDITIVELY on top —
   * the actual charge to the card is `amount_usd + fee_usd`. NETOPIA
   * sees the total charge. Wallet is credited with
   * `amount_usd × exchange_rate` (in CUP).
   *
   * Previously this field was `amount_cup` (the wallet credit was the
   * input). The semantic flip was decided in the design rounds locked
   * Oct 2026 — see docs/payment-processor/PROGRESS.md.
   */
  amount_usd: number;
  // 00300: 'tricicoin' es el nombre canónico post-migración. 'driver_quota'
  // queda como alias legacy (clients pre-00300) — el RPC los rutea al mismo
  // account_type='tricicoin'.
  recharge_type?: 'customer' | 'driver_quota' | 'tricicoin';
  corporate_account_id?: string;
  device_fingerprint?: string;
  /**
   * Optional base URL the processor redirects to after settlement; the edge
   * function appends `?intent=<id>` server-side. Used by mobile apps so the
   * user lands back inside the app (universal link or custom scheme) instead
   * of in the system browser. Whitelisted to known TriciGo prefixes.
   */
  return_url_base?: string;
  /**
   * 2-char ISO 639-1 code for the NETOPIA hosted-page UI. Defaults to 'es'
   * for the TriciGo Hispanic audience. NETOPIA documented support: 'ro',
   * 'en' — unsupported codes silently fall back to Romanian (default) or
   * English depending on the POS configuration. If 'es' is not honored,
   * change the default below to 'en'.
   */
  language?: string;
}

/**
 * Whitelist of acceptable return URL prefixes. Anything else is rejected to
 * prevent open-redirect via a tampered request body.
 *
 *   - `https://tricigo.com/`  → web wallet + universal-link landings
 *     under /app/client/ and /app/driver/.
 *   - `tricigo://`            → custom scheme of the customer app.
 *   - `tricigo-driver://`     → custom scheme of the driver app.
 */
const RETURN_URL_ALLOWED_PREFIXES = [
  'https://tricigo.com/',
  'tricigo://',
  'tricigo-driver://',
];

function isAllowedReturnUrl(value: string | undefined): value is string {
  if (!value || typeof value !== 'string') return false;
  if (value.length > 512) return false;
  return RETURN_URL_ALLOWED_PREFIXES.some((p) => value.startsWith(p));
}

/** NETOPIA v2.x `/payment/card/start` response shape (subset we consume). */
interface NetopiaStartResponse {
  payment?: {
    ntpID?: string;
    paymentURL?: string;
    status?: number;
    method?: string;
    amount?: number;
    currency?: string;
  };
  customerAction?: {
    type?: string;
    url?: string;
    returnUrl?: string;
    authenticationToken?: string;
    formData?: Record<string, string>;
  };
  error?: {
    code?: string;
    message?: string;
    details?: Array<{ code?: string; message?: string; field?: string }>;
  };
}

/** Maps NETOPIA API base URL by environment. */
function netopiaApiBase(env: 'sandbox' | 'live'): string {
  // The OpenAPI spec lists secure.mobilpay.ro/pay for production, but the
  // generally-published v2.x base is secure.netopia-payments.com. Use the
  // documented sandbox host and the documented live host; if the operator
  // sees 404s in live, override via NETOPIA_LIVE_API_BASE env var.
  if (env === 'live') {
    return Deno.env.get('NETOPIA_LIVE_API_BASE') ?? 'https://secure.netopia-payments.com';
  }
  return Deno.env.get('NETOPIA_SANDBOX_API_BASE') ?? 'https://secure.sandbox.netopia-payments.com';
}

/**
 * POST a card-payment start request to NETOPIA v2.x.
 *
 * Auth: `Authorization: <api-key>` (raw, no Bearer prefix). Body shape
 * matches the OpenAPI spec (config + order + payment). Returns the parsed
 * response or throws on network / non-2xx.
 */
async function callNetopiaCardStart(args: {
  env: 'sandbox' | 'live';
  apiKey: string;
  posSignature: string;
  intentId: string;
  amountUsd: number;
  currency: string;
  description: string;
  notifyUrl: string;
  redirectUrl: string;
  language: string;
  billing: {
    email: string;
    phone: string;
    firstName: string;
    lastName: string;
    city: string;
    country: number;
    countryName: string;
    state: string;
    postalCode: string;
    details: string;
  };
}): Promise<NetopiaStartResponse> {
  const base = netopiaApiBase(args.env);
  const url = `${base}/payment/card/start`;

  const body = {
    config: {
      notifyUrl: args.notifyUrl,
      redirectUrl: args.redirectUrl,
      language: args.language,
    },
    payment: {
      options: { installments: 0, bonus: 0 },
      instrument: { type: 'card' },
      data: {},
    },
    order: {
      posSignature: args.posSignature,
      dateTime: new Date().toISOString(),
      description: args.description,
      orderID: args.intentId,
      amount: args.amountUsd,
      currency: args.currency,
      billing: args.billing,
      shipping: args.billing,
      products: [
        {
          name: 'TriciGo wallet recharge',
          code: 'WALLET_RECHARGE',
          category: 'service',
          price: args.amountUsd,
          vat: 0,
        },
      ],
      data: { tricigo_intent_id: args.intentId },
    },
  };

  // 15s hard timeout: NETOPIA TLS/network hangs would otherwise reach
  // Supabase's gateway timeout (~10–25s), producing a generic 502 with
  // no body. With this, we surface a clean error and our handler can
  // mark the intent failed and return a structured response.
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // v2.x: raw API key, no "Bearer" prefix (per OpenAPI spec).
        'Authorization': args.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('netopia request timed out after 15s');
    }
    throw err;
  }

  const text = await resp.text();
  let parsed: NetopiaStartResponse = {};
  try {
    parsed = text ? JSON.parse(text) as NetopiaStartResponse : {};
  } catch (_err) {
    throw new Error(`netopia returned non-JSON response (HTTP ${resp.status}): ${text.slice(0, 500)}`);
  }
  // Only fail hard on non-2xx WITHOUT a parsed body. NETOPIA v2.x often
  // returns 200 with both `payment.paymentURL` AND an `error` object
  // whose code is informational (see handler below); the parser must
  // not reject that case.
  if (!resp.ok && !parsed.error && !parsed.payment) {
    throw new Error(`netopia HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  return parsed;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_048_576) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
  }

  try {
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`create-netopia-pi:${clientIP}`, 5, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    // OFAC region block (same policy as Stripe path).
    const SANCTIONED_REGIONS = new Set(['CU', 'IR', 'KP', 'SY']);
    const country = (req.headers.get('cf-ipcountry') ?? 'XX').toUpperCase();
    if (SANCTIONED_REGIONS.has(country)) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'region_unsupported',
          detail: 'Card payments are not available from this region. ' +
            'Ask a contact abroad to top-up the wallet on your behalf.',
        }),
        {
          status: 451,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const supabaseAuth = createClient(supabaseUrl, serviceRoleKey);
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
      authHeader.replace('Bearer ', ''),
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body: CreateIntentRequest = await req.json();
    const { user_id, amount_usd, recharge_type = 'customer', corporate_account_id, device_fingerprint, return_url_base, language } = body;
    // NETOPIA documents support for these checkout languages (per support
    // article 44148357382033 — Cum pot afișa pagina de plată într-o altă
    // limbă decât româna). Default to Spanish for the TriciGo audience.
    // If the v2.x API silently falls back to Romanian for the 'Pay' button
    // despite an officially-supported code, that's a NETOPIA-side issue
    // (open ticket); the code keeps doing the right thing.
    const NETOPIA_SUPPORTED_LANGS = new Set(['ro', 'en', 'it', 'hu', 'bg', 'ru', 'es', 'fr', 'de']);
    const requested = language?.toLowerCase();
    const uiLanguage = requested && NETOPIA_SUPPORTED_LANGS.has(requested) ? requested : 'es';
    const isCorporate = !!corporate_account_id;

    // Reject obviously-bad return URLs early so the caller learns
    // BEFORE we burn a payment_intents row + NETOPIA call.
    if (return_url_base !== undefined && !isAllowedReturnUrl(return_url_base)) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'invalid_return_url',
          detail: 'return_url_base must start with https://tricigo.com/, tricigo://, or tricigo-driver://',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // RECARGA V2 limits (USD-denominated, type-aware):
    //   - Customer: $20 .. $500
    //   - Corporate: $100 .. $10000
    // Decided in design round 3 / round 4. Hardcoded on purpose — the
    // product floors and ceilings are policy, not operational config.
    const MIN_USD = isCorporate ? 100 : 20;
    const MAX_USD = isCorporate ? 10_000 : 500;

    if (!user_id || !Number.isFinite(amount_usd) || amount_usd <= 0) {
      return new Response(
        JSON.stringify({ ok: false, error: 'invalid_params', detail: 'user_id required, amount_usd must be positive' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: roleRow } = await supabase.from('users').select('role, full_name, email, phone').eq('id', user.id).single();
    const isAdmin = roleRow && ['admin', 'super_admin'].includes(roleRow.role as string);
    if (!isAdmin && user.id !== user_id) {
      return new Response(JSON.stringify({ error: 'Forbidden: can only create PI for your own account' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Load NETOPIA config from platform_config + Deno env ───────
    // netopia_fee_usd / netopia_fee_type / netopia_*_recharge_cup are no
    // longer read — the fee model (3% min $0.50) is hardcoded in code
    // and the min/max are USD-typed above. Those config rows are kept
    // in the DB for now (cosmetic cleanup deferred); they're inert.
    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', [
        'netopia_enabled', 'netopia_environment',
        'netopia_sandbox_signature', 'netopia_live_signature',
      ]);

    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => {
      const raw = c.value;
      configMap[c.key] = typeof raw === 'string' && raw.startsWith('"') ? JSON.parse(raw) : String(raw);
    });

    const netopiaEnabled = configMap['netopia_enabled'] !== 'false';
    const env: 'sandbox' | 'live' = (configMap['netopia_environment'] as 'sandbox' | 'live') ?? 'sandbox';
    const posSignature = env === 'live'
      ? (configMap['netopia_live_signature'] ?? '')
      : (configMap['netopia_sandbox_signature'] ?? '');
    const apiKey = env === 'live'
      ? (Deno.env.get('NETOPIA_LIVE_API_KEY') ?? '')
      : (Deno.env.get('NETOPIA_SANDBOX_API_KEY') ?? '');

    if (!netopiaEnabled) {
      return new Response(
        JSON.stringify({ ok: false, error: 'netopia_disabled', detail: 'NETOPIA payments are currently disabled' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (!posSignature || !apiKey) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'not_configured',
          detail: `NETOPIA ${env} credentials not set ` +
            '(platform_config posSignature and/or Deno env API key are empty)',
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (amount_usd < MIN_USD) {
      return new Response(
        JSON.stringify({ ok: false, error: 'amount_too_low', min_usd: MIN_USD, kind: isCorporate ? 'corporate' : 'customer' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (amount_usd > MAX_USD) {
      return new Response(
        JSON.stringify({ ok: false, error: 'amount_too_high', max_usd: MAX_USD, kind: isCorporate ? 'corporate' : 'customer' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // FX rate is MANDATORY (round 3 decision). Block the recharge if
    // missing or stale (> 24h). Forces the operator to monitor the
    // sync-exchange-rate cron — failing closed is better than crediting
    // the wallet with the wrong amount of CUP.
    const { data: rateRow } = await supabase
      .from('exchange_rates')
      .select('usd_cup_rate, created_at')
      .eq('is_current', true)
      .single();

    const FX_STALE_MS = 24 * 60 * 60 * 1000;
    const fxTooOld = !rateRow?.created_at
      || (Date.now() - new Date(rateRow.created_at).getTime()) > FX_STALE_MS;
    if (!rateRow?.usd_cup_rate || fxTooOld) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'fx_unavailable',
          detail: 'Tipo de cambio USD→CUP no disponible o desactualizado. Intentalo más tarde.',
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    const exchangeRate = rateRow.usd_cup_rate;

    // RECARGA V2 math (locked in design rounds 1 & 2):
    //   amount_usd   = the NET that the user picked (input).
    //   fee_usd      = MAX(amount_usd × 3%, $0.50) — additive, NOT deducted.
    //   charge_usd   = amount_usd + fee_usd     — the actual card charge.
    //   amount_cup   = amount_usd × exchange_rate — TC credited to wallet
    //                  (TC = CUP, 1 TC = 1 CUP, by design round 1).
    const feeUsd = Math.max(Number((amount_usd * 0.03).toFixed(2)), 0.50);
    const chargeUsd = Number((amount_usd + feeUsd).toFixed(2));
    const amountCupCredited = Math.round(amount_usd * exchangeRate);

    // ── Phase B1: per-user top-up velocity control (fail-open) ───
    // Customers are subject to limits. Corporate is EXEMPT (round 4):
    // a B2B account may legitimately recharge $5k in one shot.
    if (!isCorporate) {
      try {
        const { data: velocity, error: velocityError } = await supabase.rpc(
          'check_topup_velocity',
          { p_user_id: user_id, p_amount_usd: amount_usd },
        );
        if (velocityError) {
          console.error('Velocity check unavailable, allowing recharge:', velocityError.message);
        } else if (velocity?.allowed === false) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: 'velocity_limit',
              reason: velocity.reason,
              detail: 'You have reached the recharge limit. Please try again later.',
            }),
            { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
      } catch (velErr) {
        console.error('Velocity check threw, allowing recharge:', velErr);
      }
    }

    const intentRow: Record<string, unknown> = {
      user_id,
      // RECARGA V2 semantic:
      //   amount_usd = what the user REQUESTED (net, before fee).
      //   fee_usd    = the additive fee.
      //   amount_cup = TC credited to the wallet (CUP).
      // The card charge is derived as amount_usd + fee_usd; we do NOT
      // persist it separately. NETOPIA receives the derived total.
      amount_usd,
      amount_cup: amountCupCredited,
      exchange_rate: exchangeRate,
      fee_usd: feeUsd,
      status: 'created',
      payment_provider: 'netopia',
      intent_type: 'recharge',
      // 00300 routing: 'customer' → customer_cash (default),
      // 'tricicoin' → tricicoin (driver single-wallet model),
      // 'driver_quota' → tricicoin (legacy alias, preserved for back-compat
      // with apps pre-00300). Whitelist avoids bad data.
      recharge_type:
        recharge_type === 'tricicoin' ? 'tricicoin' :
        recharge_type === 'driver_quota' ? 'driver_quota' :
        'customer',
    };
    if (corporate_account_id) {
      intentRow.corporate_account_id = corporate_account_id;
    }

    const { data: intent, error: insertError } = await supabase
      .from('payment_intents').insert(intentRow).select().single();

    if (insertError) {
      console.error('Error creating payment intent:', insertError);
      return new Response(
        JSON.stringify({ ok: false, error: 'db_error', detail: insertError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Phase B6: device fingerprinting (fail-open) ─────────────
    try {
      const userAgent = req.headers.get('user-agent') ?? null;
      const { error: fpError } = await supabase.from('payment_intents')
        .update({
          client_ip: clientIP,
          user_agent: userAgent,
          device_fingerprint: device_fingerprint ?? null,
        })
        .eq('id', intent.id);
      if (fpError) {
        console.error('Device metadata update skipped:', fpError.message);
      }
    } catch (fpErr) {
      console.error('Device metadata update threw:', fpErr);
    }

    // ── Build billing block from `users` row + sensible defaults ─
    // NETOPIA requires a complete billing object. We use the caller's
    // own row (email, phone, full_name) and pad missing fields with
    // placeholders. Country defaults to Romania (642 ISO 3166-1 num)
    // because the merchant is Romanian and the user is a diaspora
    // depositor (Cuba is blocked above by the OFAC region check).
    const fullName = String(roleRow?.full_name ?? 'TriciGo User');
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] ?? 'TriciGo';
    const lastName = nameParts.slice(1).join(' ') || 'User';

    const billing = {
      email: String(roleRow?.email ?? user.email ?? 'noreply@tricigo.com'),
      phone: String(roleRow?.phone ?? '+40000000000'),
      firstName,
      lastName,
      city: 'București',
      country: 642, // ISO 3166-1 numeric for Romania
      countryName: 'Romania',
      state: 'București',
      postalCode: '010000',
      details: 'TriciGo wallet recharge',
    };

    // ── Call NETOPIA v2.x ───────────────────────────────────────
    const notifyUrl = `${supabaseUrl}/functions/v1/process-netopia-webhook`;
    // Where NETOPIA sends the user after settlement. Mobile apps pass a
    // universal link (or custom scheme) so the user lands back in the app;
    // web callers omit it and we default to the web wallet.
    const returnBase = return_url_base
      ?? `${Deno.env.get('PUBLIC_SITE_URL') ?? 'https://tricigo.com'}/wallet`;
    const returnSeparator = returnBase.includes('?') ? '&' : '?';
    const returnUrl = `${returnBase}${returnSeparator}intent=${intent.id}`;

    let netopiaResp: NetopiaStartResponse;
    try {
      netopiaResp = await callNetopiaCardStart({
        env,
        apiKey,
        posSignature,
        intentId: intent.id,
        // RECARGA V2: NETOPIA charges the user the FULL amount including
        // the additive fee (user pays amount + fee on the card).
        amountUsd: chargeUsd,
        // NETOPIA accepts ISO 4217 codes; Romanian processor primarily
        // RON/EUR/USD. USD matches TriciGo's snapshot column and avoids
        // an extra FX hop. Eduardo/Maria enable USD in the POS dashboard
        // — without that, NETOPIA converts internally to RON on display.
        currency: 'USD',
        description: `TriciGo wallet recharge ${intent.id.slice(0, 8)}`,
        notifyUrl,
        redirectUrl: returnUrl,
        language: uiLanguage,
        billing,
      });
    } catch (netopiaErr) {
      await supabase.from('payment_intents')
        .update({ status: 'failed', error_message: String(netopiaErr), updated_at: new Date().toISOString() })
        .eq('id', intent.id);
      return new Response(
        JSON.stringify({ ok: false, error: 'netopia_error', detail: String(netopiaErr) }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Breadcrumb for future debugging without leaking PII / secrets.
    // Body of the response (billing, full customerAction) is NOT logged;
    // just the fields needed to triage 502s.
    console.log('[netopia] response summary', {
      hasPaymentURL: !!netopiaResp.payment?.paymentURL,
      ntpID: netopiaResp.payment?.ntpID,
      status: netopiaResp.payment?.status,
      errorCode: netopiaResp.error?.code,
      errorMessage: netopiaResp.error?.message,
      customerActionType: netopiaResp.customerAction?.type,
    });

    // Decision: paymentURL is the SOLE source of truth for success.
    // NETOPIA v2.x's `/payment/card/start` always returns an `error`
    // object — code "0"/"00"/"100"/"101" are all informational hints
    // ("Redirect user to payment page" with code 101 is the standard
    // response for hosted-page flow). Whitelisting codes is brittle;
    // NETOPIA can introduce new ones tomorrow. So: if paymentURL is
    // present, treat it as success and log `error` only for diagnostics.
    const paymentURL = netopiaResp.payment?.paymentURL;

    if (!paymentURL) {
      // No URL → can't redirect the user → real failure. error.message
      // (if present) is the genuine error from NETOPIA worth surfacing.
      const msg = netopiaResp.error?.message
        ?? netopiaResp.error?.code
        ?? 'NETOPIA did not return a paymentURL';
      await supabase.from('payment_intents')
        .update({
          status: 'failed',
          error_message: `netopia: ${msg}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', intent.id);
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'netopia_error',
          detail: msg,
          netopia_code: netopiaResp.error?.code,
          netopia_details: netopiaResp.error?.details,
        }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (netopiaResp.error?.code) {
      // Informational code alongside a valid URL — log and proceed.
      console.log(
        `[netopia] code ${netopiaResp.error.code} with paymentURL ` +
        `(status=${netopiaResp.payment?.status}): ${netopiaResp.error.message ?? '(no message)'}`,
      );
    }

    // Defensive: at this point paymentURL must exist (early-return covers
    // the empty case). The legacy guard below is kept for paranoia.
    if (!netopiaResp.payment?.paymentURL) {
      await supabase.from('payment_intents')
        .update({
          status: 'failed',
          error_message: 'NETOPIA did not return a paymentURL',
          updated_at: new Date().toISOString(),
        })
        .eq('id', intent.id);
      return new Response(
        JSON.stringify({ ok: false, error: 'netopia_error', detail: 'NETOPIA did not return a payment URL' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Store NETOPIA's ntpID alongside the existing column (today the
    // generic "external provider intent id" column). A follow-up
    // migration may rename it to provider_intent_id for clarity.
    await supabase.from('payment_intents')
      .update({
        stripe_payment_intent_id: netopiaResp.payment.ntpID ?? null,
        status: 'pending',
        updated_at: new Date().toISOString(),
      })
      .eq('id', intent.id);

    // RECARGA V2 response shape — see RechargeIntentResult in
    // packages/types/src/payment.ts.
    return new Response(
      JSON.stringify({
        ok: true,
        provider: 'netopia',
        intentId: intent.id,
        amountUsdRequested: amount_usd,
        feeUsd,
        chargeUsd,
        amountCupCredited,
        exchangeRate,
        redirectUrl: netopiaResp.payment.paymentURL,
        environment: env,
        netopiaNtpId: netopiaResp.payment.ntpID,
        netopiaStatus: netopiaResp.payment.status,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Unexpected error in create-netopia-payment-intent:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
