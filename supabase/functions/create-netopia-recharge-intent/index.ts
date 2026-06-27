// create-netopia-recharge-intent — PUBLIC (verify_jwt=false).
// Diaspora recharge via NETOPIA: someone abroad funds a Cuban user's wallet on
// the NETOPIA hosted card page. The NETOPIA sibling of
// create-stripe-recharge-intent — same public/recipient-by-phone structure
// (resolve recipient SERVER-SIDE, OFAC region block, rate limit, frozen-wallet
// check, FX fail-closed, additive fee), but opens NETOPIA's hosted page instead
// of Stripe Checkout. Settlement is handled by process-netopia-webhook (which
// credits payment_intents.user_id = the recipient — verified generic).
//
// The /recargar page picks this EF when platform_config.active_payment_provider
// = 'netopia'. NETOPIA is live and the diaspora payer is abroad (non-Cuban IP),
// so this works without the Stripe KYC. Does NOT write a `metadata` column (it
// doesn't exist in prod until migration 00463 — and we don't need it here).
//
// The NETOPIA call (callNetopiaCardStart / netopiaApiBase) is copied verbatim
// from create-netopia-payment-intent, including the live VPS np-proxy routing.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

const MIN_USD = 20;
const MAX_USD = 500;
const SANCTIONED_REGIONS = new Set(['CU', 'IR', 'KP', 'SY']);

/** NETOPIA v2.x `/payment/card/start` response shape (subset we consume). */
interface NetopiaStartResponse {
  payment?: { ntpID?: string; paymentURL?: string; status?: number; method?: string; amount?: number; currency?: string };
  customerAction?: { type?: string; url?: string; returnUrl?: string; authenticationToken?: string; formData?: Record<string, string> };
  error?: { code?: string; message?: string; details?: Array<{ code?: string; message?: string; field?: string }> };
}

/** Maps NETOPIA API base URL by environment (live routes through the VPS np-proxy). */
function netopiaApiBase(env: 'sandbox' | 'live'): string {
  // LIVE: NETOPIA's live API edge blocks Supabase Edge's datacenter egress with a
  // generic 403, while sandbox is open. Route live through the VPS nginx reverse-
  // proxy (static IP, not blocked): tricigo.com/np-proxy/* → secure.mobilpay.ro/pay/*,
  // guarded by the x-proxy-secret header (added in callNetopiaCardStart).
  if (env === 'live') {
    return Deno.env.get('NETOPIA_LIVE_API_BASE') ?? 'https://tricigo.com/np-proxy';
  }
  return Deno.env.get('NETOPIA_SANDBOX_API_BASE') ?? 'https://secure.sandbox.netopia-payments.com';
}

/** POST a card-payment start request to NETOPIA v2.x. Auth: raw API key (no Bearer). */
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
    email: string; phone: string; firstName: string; lastName: string;
    city: string; country: number; countryName: string; state: string; postalCode: string; details: string;
  };
}): Promise<NetopiaStartResponse> {
  const base = netopiaApiBase(args.env);
  const url = `${base}/payment/card/start`;

  const body = {
    config: { notifyUrl: args.notifyUrl, redirectUrl: args.redirectUrl, language: args.language },
    payment: { options: { installments: 0, bonus: 0 }, instrument: { type: 'card' }, data: {} },
    order: {
      posSignature: args.posSignature,
      dateTime: new Date().toISOString(),
      description: args.description,
      orderID: args.intentId,
      amount: args.amountUsd,
      currency: args.currency,
      billing: args.billing,
      shipping: args.billing,
      products: [{ name: 'TriciGo wallet recharge', code: 'WALLET_RECHARGE', category: 'service', price: args.amountUsd, vat: 0 }],
      data: { tricigo_intent_id: args.intentId },
    },
  };

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': args.apiKey, // v2.x: raw API key, no "Bearer" prefix
        ...(args.env === 'live' && Deno.env.get('NETOPIA_PROXY_SECRET')
          ? { 'x-proxy-secret': Deno.env.get('NETOPIA_PROXY_SECRET')! }
          : {}),
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
  if (!resp.ok && !parsed.error && !parsed.payment) {
    throw new Error(`netopia HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  return parsed;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const J = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_048_576) return J(413, { ok: false, error: 'payload_too_large' });

  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = await rateLimit(`create-netopia-recharge:${clientIP}`, 5, 60 * 1000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs, corsHeaders);

  // OFAC region block: the PAYER must NOT be in a sanctioned country (diaspora is abroad).
  const country = (req.headers.get('cf-ipcountry') ?? 'XX').toUpperCase();
  if (SANCTIONED_REGIONS.has(country)) {
    return J(451, {
      ok: false,
      error: 'region_unsupported',
      detail: 'Card payments are not available from this region. ' +
        'Ask a contact abroad to top-up the wallet on your behalf.',
    });
  }

  try {
    const { phone, amount_usd, payer_email } = (await req.json()) as {
      phone?: string; amount_usd?: number; payer_email?: string;
    };
    if (
      !phone ||
      !Number.isFinite(amount_usd as number) || (amount_usd as number) <= 0 ||
      !payer_email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payer_email)
    ) {
      return J(400, { ok: false, error: 'invalid_params' });
    }
    const amt = amount_usd as number;
    if (amt < MIN_USD) return J(400, { ok: false, error: 'amount_too_low', min_usd: MIN_USD });
    if (amt > MAX_USD) return J(400, { ok: false, error: 'amount_too_high', max_usd: MAX_USD });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Authoritative recipient resolution (server-side; the payer cannot forge it).
    const { data: recRows, error: recErr } = await supabase.rpc('find_recipient_for_recharge', { p_phone: phone });
    const recipient = Array.isArray(recRows) ? recRows[0] : recRows;
    if (recErr || !recipient?.id) {
      return J(404, { ok: false, error: 'recipient_not_found', detail: 'Este número no es usuario de TriciGo.' });
    }

    // recharge_type from role (driver → tricicoin, else customer). Wallet must not be frozen.
    const { data: roleRow } = await supabase.from('users').select('role').eq('id', recipient.id).single();
    const rechargeType = roleRow?.role === 'driver' ? 'tricicoin' : 'customer';
    const walletType = roleRow?.role === 'driver' ? 'tricicoin' : 'customer_cash';
    const { data: walletRow } = await supabase
      .from('wallet_accounts').select('is_frozen').eq('user_id', recipient.id).eq('account_type', walletType).maybeSingle();
    if (walletRow?.is_frozen) {
      return J(409, { ok: false, error: 'recipient_wallet_frozen', detail: 'La billetera del destinatario está suspendida.' });
    }

    // FX staleness (fail closed if missing / > 24h).
    const { data: rateRow } = await supabase.from('exchange_rates').select('usd_cup_rate, created_at').eq('is_current', true).single();
    const fxTooOld = !rateRow?.created_at || (Date.now() - new Date(rateRow.created_at).getTime()) > 24 * 60 * 60 * 1000;
    if (!rateRow?.usd_cup_rate || fxTooOld) {
      return J(503, { ok: false, error: 'fx_unavailable', detail: 'Tipo de cambio no disponible. Intentalo más tarde.' });
    }
    const exchangeRate = rateRow.usd_cup_rate as number;

    // Fee math: payer pays the fee additively (same model as the Stripe/NETOPIA recharge).
    const feeUsd = Math.max(Number((amt * 0.03).toFixed(2)), 0.50);
    const chargeUsd = Number((amt + feeUsd).toFixed(2));
    const amountCupCredited = Math.round(amt * exchangeRate);

    // ── NETOPIA config (platform_config + Deno env) ─────────────────
    const { data: configs } = await supabase
      .from('platform_config').select('key, value')
      .in('key', ['netopia_enabled', 'netopia_environment', 'netopia_sandbox_signature', 'netopia_live_signature']);
    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => {
      const raw = c.value;
      configMap[c.key] = typeof raw === 'string' && raw.startsWith('"') ? JSON.parse(raw) : String(raw);
    });
    const netopiaEnabled = configMap['netopia_enabled'] !== 'false';
    const env: 'sandbox' | 'live' = (configMap['netopia_environment'] as 'sandbox' | 'live') ?? 'sandbox';
    const posSignature = env === 'live' ? (configMap['netopia_live_signature'] ?? '') : (configMap['netopia_sandbox_signature'] ?? '');
    const apiKey = env === 'live' ? (Deno.env.get('NETOPIA_LIVE_API_KEY') ?? '') : (Deno.env.get('NETOPIA_SANDBOX_API_KEY') ?? '');
    if (!netopiaEnabled) {
      return J(503, { ok: false, error: 'netopia_disabled', detail: 'NETOPIA payments are currently disabled' });
    }
    if (!posSignature || !apiKey) {
      return J(503, { ok: false, error: 'not_configured', detail: `NETOPIA ${env} credentials not set` });
    }

    // payment_intents: user_id = RECIPIENT. NO metadata column (doesn't exist in prod).
    const { data: intent, error: insErr } = await supabase
      .from('payment_intents')
      .insert({
        user_id: recipient.id,
        amount_usd: amt,
        amount_cup: amountCupCredited,
        exchange_rate: exchangeRate,
        fee_usd: feeUsd,
        status: 'created',
        payment_provider: 'netopia',
        intent_type: 'recharge',
        recharge_type: rechargeType,
        client_ip: clientIP,
      })
      .select()
      .single();
    if (insErr || !intent) {
      console.error('[create-netopia-recharge] insert error:', insErr?.message);
      return J(500, { ok: false, error: 'db_error' });
    }

    // Billing block: the cardholder is the PAYER (abroad), NOT the recipient — and we
    // only collect the payer's email. Use a GENERIC billing name (the cardholder fills
    // their real name on the NETOPIA card form). Deliberately NOT the recipient's real
    // name: that would put it on the payer's hosted page and make this public EF a
    // phone→full-name enumeration vector. Romania placeholders because the merchant is
    // Romanian; the OFAC block already keeps Cuba out.
    const billing = {
      email: payer_email,
      phone: '+40000000000',
      firstName: 'TriciGo',
      lastName: 'Recarga',
      city: 'București',
      country: 642, // ISO 3166-1 numeric for Romania
      countryName: 'Romania',
      state: 'București',
      postalCode: '010000',
      details: 'TriciGo wallet recharge',
    };

    // Return URL: NETOPIA uses a single redirect (no ok/cancel distinction — the
    // real result arrives via the IPN). Land back on /recargar with a "processing"
    // marker so the page shows the right banner. The page polls nothing (anon).
    const notifyUrl = `${supabaseUrl}/functions/v1/process-netopia-webhook`;
    const returnBase = `${Deno.env.get('PUBLIC_SITE_URL') ?? 'https://tricigo.com'}/recargar?status=processing`;
    const redirectUrl = `${returnBase}&intent=${intent.id}`;

    let netopiaResp: NetopiaStartResponse;
    try {
      netopiaResp = await callNetopiaCardStart({
        env,
        apiKey,
        posSignature,
        intentId: intent.id,
        amountUsd: chargeUsd, // NETOPIA charges the full amount incl. the additive fee
        currency: 'USD',
        description: `TriciGo wallet recharge ${intent.id.slice(0, 8)}`,
        notifyUrl,
        redirectUrl,
        language: 'es',
        billing,
      });
    } catch (netopiaErr) {
      await supabase.from('payment_intents')
        .update({ status: 'failed', error_message: String(netopiaErr), updated_at: new Date().toISOString() })
        .eq('id', intent.id);
      return J(502, { ok: false, error: 'netopia_error', detail: String(netopiaErr) });
    }

    const paymentURL = netopiaResp.payment?.paymentURL;
    if (!paymentURL) {
      const msg = netopiaResp.error?.message ?? netopiaResp.error?.code ?? 'NETOPIA did not return a paymentURL';
      await supabase.from('payment_intents')
        .update({ status: 'failed', error_message: `netopia: ${msg}`, updated_at: new Date().toISOString() })
        .eq('id', intent.id);
      return J(502, { ok: false, error: 'netopia_error', detail: msg, netopia_code: netopiaResp.error?.code });
    }

    await supabase.from('payment_intents')
      .update({ stripe_payment_intent_id: netopiaResp.payment?.ntpID ?? null, status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', intent.id);

    return J(200, {
      ok: true,
      provider: 'netopia',
      intentId: intent.id,
      amountUsdRequested: amt,
      feeUsd,
      chargeUsd,
      amountCupCredited,
      exchangeRate,
      redirectUrl: paymentURL,
    });
  } catch (err) {
    console.error('[create-netopia-recharge] error:', err);
    return J(500, { ok: false, error: 'internal_error' });
  }
});
