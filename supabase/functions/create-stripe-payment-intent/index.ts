// ============================================================
// TriciGo — Create Stripe Payment Intent Edge Function
//
// AUTHENTICATED self-recharge (verify_jwt=true). The signed-in user
// funds THEIR OWN wallet via Stripe Checkout. This is the Stripe
// sibling of create-netopia-payment-intent and is used as the
// in-app FALLBACK when NETOPIA's hosted page is geo-blocked (Cloud
// Armor 403 from Cuba): the recharge WebView auto-detects the NETOPIA
// load failure and re-creates the intent with provider='stripe'.
//
// Distinct from create-stripe-recharge-intent (PUBLIC, diaspora,
// recipient-by-phone). Here user_id = the authenticated caller.
// Both share _shared/stripe.ts and the same process-stripe-webhook.
//
// Mirrors create-netopia-payment-intent for auth / OFAC region block /
// rate limit / fee math / FX staleness / velocity / payment_intents
// insert, and differs only at the provider call (Stripe Checkout
// Session instead of NETOPIA hosted page).
//
// Status: gated OFF by platform_config.stripe_enabled until KYC + live
// keys. Built for Stripe test mode now.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { getStripe } from '../_shared/stripe.ts';
import { realEmail } from '../_shared/email-guard.ts';
import { getFreshFx, FX_UNAVAILABLE_DETAIL } from '../_shared/fx-freshness.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

const SANCTIONED_REGIONS = new Set(['CU', 'IR', 'KP', 'SY']);

/**
 * Stripe Checkout `success_url`/`cancel_url` MUST be http(s) URLs — Stripe
 * rejects custom schemes (tricigo://). So unlike the NETOPIA EF (which also
 * allows tricigo:// / tricigo-driver://), this whitelist is https-only. The
 * mobile recharge WebView passes an https://tricigo.com/ return URL it can
 * detect to dismiss + pollIntentStatus.
 */
const RETURN_URL_ALLOWED_PREFIXES = ['https://tricigo.com/'];
function isAllowedReturnUrl(value: string | undefined): value is string {
  if (!value || typeof value !== 'string') return false;
  if (value.length > 512) return false;
  return RETURN_URL_ALLOWED_PREFIXES.some((p) => value.startsWith(p));
}

interface CreateIntentRequest {
  user_id: string;
  amount_usd: number;
  recharge_type?: 'customer' | 'driver_quota' | 'tricicoin';
  corporate_account_id?: string;
  device_fingerprint?: string;
  return_url_base?: string;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const J = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_048_576) return J(413, { ok: false, error: 'payload_too_large' });

  try {
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`create-stripe-pi:${clientIP}`, 5, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs, corsHeaders);

    // OFAC region block (same policy as the NETOPIA / diaspora paths).
    const country = (req.headers.get('cf-ipcountry') ?? 'XX').toUpperCase();
    if (SANCTIONED_REGIONS.has(country)) {
      return J(451, {
        ok: false,
        error: 'region_unsupported',
        detail: 'Card payments are not available from this region. ' +
          'Ask a contact abroad to top-up the wallet on your behalf.',
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // ── Auth: the caller must present a valid user JWT ──────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return J(401, { ok: false, error: 'missing_auth' });
    const supabaseAuth = createClient(supabaseUrl, serviceRoleKey);
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !user) return J(401, { ok: false, error: 'invalid_token' });

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body: CreateIntentRequest = await req.json();
    const { user_id, amount_usd, recharge_type = 'customer', corporate_account_id, device_fingerprint, return_url_base } = body;
    const isCorporate = !!corporate_account_id;

    // Reject open-redirect-y return URLs BEFORE burning an intent row.
    if (return_url_base !== undefined && !isAllowedReturnUrl(return_url_base)) {
      return J(400, {
        ok: false,
        error: 'invalid_return_url',
        detail: 'return_url_base must start with https://tricigo.com/ (Stripe Checkout requires an https return URL).',
      });
    }

    // USD-typed limits (same as the NETOPIA path): customer $20..$500,
    // corporate $100..$10000. Policy, not config.
    const MIN_USD = isCorporate ? 100 : 20;
    const MAX_USD = isCorporate ? 10_000 : 500;

    if (!user_id || !Number.isFinite(amount_usd) || amount_usd <= 0) {
      return J(400, { ok: false, error: 'invalid_params', detail: 'user_id required, amount_usd must be positive' });
    }

    // Self-recharge: the caller may only fund their OWN wallet (admins exempt).
    const { data: roleRow } = await supabase.from('users').select('role, full_name, email').eq('id', user.id).single();
    const isAdmin = roleRow && ['admin', 'super_admin'].includes(roleRow.role as string);
    if (!isAdmin && user.id !== user_id) {
      return J(403, { ok: false, error: 'forbidden', detail: 'can only recharge your own account' });
    }

    // ── Provider gate: OFF until KYC + live keys ────────────────────
    // platform_config.value is JSONB → supabase-js returns it PARSED
    // (boolean `false` today, set by 00281). Fail CLOSED: only an explicit
    // true enables Stripe; a missing row, a DB error, or false stays
    // disabled. No migration needed — the row already exists.
    const { data: cfgRow, error: cfgErr } = await supabase
      .from('platform_config').select('value').eq('key', 'stripe_enabled').maybeSingle();
    const cfgRaw = (cfgRow as { value?: unknown } | null)?.value;
    const cfgParsed = typeof cfgRaw === 'string' && cfgRaw.startsWith('"') ? JSON.parse(cfgRaw) : cfgRaw;
    const stripeEnabled = !cfgErr && (cfgParsed === true || cfgParsed === 'true');
    if (!stripeEnabled) {
      return J(503, { ok: false, error: 'stripe_disabled', detail: 'Stripe payments are not enabled yet.' });
    }

    if (amount_usd < MIN_USD) {
      return J(400, { ok: false, error: 'amount_too_low', min_usd: MIN_USD, kind: isCorporate ? 'corporate' : 'customer' });
    }
    if (amount_usd > MAX_USD) {
      return J(400, { ok: false, error: 'amount_too_high', max_usd: MAX_USD, kind: isCorporate ? 'corporate' : 'customer' });
    }

    // FX is MANDATORY and fails closed if missing / stale — never credit the
    // wallet with the wrong amount of CUP. Window from getFreshFx (shared).
    const fx = await getFreshFx(supabase);
    if (!fx.ok) {
      console.error(`[create-stripe-payment-intent] fx_unavailable reason=${fx.reason} ageHours=${fx.ageHours?.toFixed(1) ?? 'n/a'} maxAgeHours=${fx.maxAgeHours}`);
      return J(503, { ok: false, error: 'fx_unavailable', detail: FX_UNAVAILABLE_DETAIL });
    }
    const exchangeRate = fx.rate as number;

    // Fee math (locked): payer pays the fee ADDITIVELY; only the NET is
    // credited as CUP. feeUsd = MAX(amt×3%, $0.50); charge = amt + fee.
    const feeUsd = Math.max(Number((amount_usd * 0.03).toFixed(2)), 0.50);
    const chargeUsd = Number((amount_usd + feeUsd).toFixed(2));
    const amountCupCredited = Math.round(amount_usd * exchangeRate);

    // Per-user top-up velocity control (customers only; corporate exempt;
    // fail-open so an unavailable check never blocks a legit recharge).
    if (!isCorporate) {
      try {
        const { data: velocity, error: velocityError } = await supabase.rpc(
          'check_topup_velocity', { p_user_id: user_id, p_amount_usd: amount_usd },
        );
        if (velocityError) {
          console.error('Velocity check unavailable, allowing recharge:', velocityError.message);
        } else if (velocity?.allowed === false) {
          return J(429, { ok: false, error: 'velocity_limit', reason: velocity.reason, detail: 'You have reached the recharge limit. Please try again later.' });
        }
      } catch (velErr) {
        console.error('Velocity check threw, allowing recharge:', velErr);
      }
    }

    // payment_intents row: user_id = the authenticated caller.
    const intentRow: Record<string, unknown> = {
      user_id,
      amount_usd,
      amount_cup: amountCupCredited,
      exchange_rate: exchangeRate,
      fee_usd: feeUsd,
      status: 'created',
      payment_provider: 'stripe',
      intent_type: 'recharge',
      // 00300 routing: 'customer' → customer_cash, 'tricicoin' → tricicoin
      // (driver single-wallet), 'driver_quota' → tricicoin (legacy alias).
      recharge_type:
        recharge_type === 'tricicoin' ? 'tricicoin' :
        recharge_type === 'driver_quota' ? 'driver_quota' :
        'customer',
      client_ip: clientIP,
    };
    if (corporate_account_id) intentRow.corporate_account_id = corporate_account_id;

    const { data: intent, error: insertError } = await supabase
      .from('payment_intents').insert(intentRow).select().single();
    if (insertError || !intent) {
      console.error('[create-stripe-pi] insert error:', insertError?.message);
      return J(500, { ok: false, error: 'db_error', detail: insertError?.message });
    }

    // Device metadata (fail-open).
    try {
      await supabase.from('payment_intents')
        .update({ user_agent: req.headers.get('user-agent') ?? null, device_fingerprint: device_fingerprint ?? null })
        .eq('id', intent.id);
    } catch (fpErr) {
      console.error('Device metadata update skipped:', fpErr);
    }

    // Return URL the recharge WebView detects to dismiss + poll. Mobile
    // passes an https://tricigo.com/ universal link; web omits it → wallet.
    const returnBase = return_url_base ?? `${Deno.env.get('PUBLIC_SITE_URL') ?? 'https://tricigo.com'}/wallet`;
    const sep = returnBase.includes('?') ? '&' : '?';
    const successUrl = `${returnBase}${sep}intent=${intent.id}&status=ok`;
    const cancelUrl = `${returnBase}${sep}intent=${intent.id}&status=cancel`;

    // Stripe receipt email: the caller's real email (drop synthetic OTP
    // placeholders); omit customer_email when only a placeholder exists.
    const receiptEmail = realEmail(roleRow?.email) ?? realEmail(user.email);

    const stripe = getStripe();
    const sessionParams: Record<string, unknown> = {
      mode: 'payment',
      client_reference_id: intent.id,
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(chargeUsd * 100),
          product_data: { name: 'TriciGo — recarga de billetera' },
        },
      }],
      payment_intent_data: { metadata: { tricigo_intent_id: intent.id } },
      metadata: { tricigo_intent_id: intent.id },
    };
    if (receiptEmail) sessionParams.customer_email = receiptEmail;

    let session;
    try {
      // deno-lint-ignore no-explicit-any
      session = await stripe.checkout.sessions.create(sessionParams as any);
    } catch (stripeErr) {
      await supabase.from('payment_intents')
        .update({ status: 'failed', error_message: `stripe: ${String(stripeErr)}`, updated_at: new Date().toISOString() })
        .eq('id', intent.id);
      return J(502, { ok: false, error: 'stripe_error', detail: String(stripeErr) });
    }

    await supabase.from('payment_intents')
      .update({ stripe_payment_intent_id: session.id, status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', intent.id);

    return J(200, {
      ok: true,
      provider: 'stripe',
      intentId: intent.id,
      amountUsdRequested: amount_usd,
      feeUsd,
      chargeUsd,
      amountCupCredited,
      exchangeRate,
      redirectUrl: session.url,
    });
  } catch (err) {
    console.error('Unexpected error in create-stripe-payment-intent:', err);
    return J(500, { ok: false, error: 'unexpected', detail: String(err) });
  }
});
