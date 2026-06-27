// create-stripe-recharge-intent — PUBLIC (verify_jwt=false).
// Diaspora recharge: someone abroad funds a Cuban user's wallet. Resolves the
// recipient by phone SERVER-SIDE (authoritative), validates, inserts a
// payment_intents row with user_id = the recipient, and creates a Stripe
// Checkout Session. Payer pays the fee additively (3% min $0.50). Built for
// Stripe test mode now; live keys swapped after KYC.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { getStripe } from '../_shared/stripe.ts';
import { sanitizePayerName } from '../_shared/sanitize.ts';

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

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const J = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = await rateLimit(`create-stripe-recharge:${clientIP}`, 5, 60 * 1000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  // OFAC region block: the payer must NOT be in a sanctioned country.
  const country = (req.headers.get('cf-ipcountry') ?? 'XX').toUpperCase();
  if (SANCTIONED_REGIONS.has(country)) {
    return J(451, { ok: false, error: 'region_unsupported', detail: 'Card payments are not available from this region.' });
  }

  try {
    const { phone, amount_usd, payer_email, payer_name } = (await req.json()) as {
      phone?: string; amount_usd?: number; payer_email?: string; payer_name?: string;
    };
    // payer_name is shown in the recipient's email/push and the payer's receipt —
    // sanitize it (control chars, HTML metacharacters, length) before persisting.
    const payerName = sanitizePayerName(payer_name);
    if (
      !phone ||
      !Number.isFinite(amount_usd as number) || (amount_usd as number) <= 0 ||
      !payer_email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payer_email) ||
      payerName.length < 2
    ) {
      return J(400, { ok: false, error: 'invalid_params' });
    }
    const amt = amount_usd as number;
    if (amt < MIN_USD) return J(400, { ok: false, error: 'amount_too_low', min_usd: MIN_USD });
    if (amt > MAX_USD) return J(400, { ok: false, error: 'amount_too_high', max_usd: MAX_USD });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Authoritative recipient resolution (server-side; client cannot forge it).
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

    // Fee math: payer pays the fee additively (same model as the NETOPIA recharge).
    const feeUsd = Math.max(Number((amt * 0.03).toFixed(2)), 0.50);
    const chargeUsd = Number((amt + feeUsd).toFixed(2));
    const amountCupCredited = Math.round(amt * exchangeRate);

    // payment_intents: user_id = RECIPIENT. payer email + masked phone in metadata.
    const phoneDigits = phone.replace(/\D/g, '');
    const { data: intent, error: insErr } = await supabase
      .from('payment_intents')
      .insert({
        user_id: recipient.id,
        amount_usd: amt,
        amount_cup: amountCupCredited,
        exchange_rate: exchangeRate,
        fee_usd: feeUsd,
        status: 'created',
        payment_provider: 'stripe',
        intent_type: 'recharge',
        recharge_type: rechargeType,
        client_ip: clientIP,
        metadata: { source: 'diaspora', payer_name: payerName, payer_email, recipient_phone_masked: `***${phoneDigits.slice(-4)}` },
      })
      .select()
      .single();
    if (insErr || !intent) {
      console.error('[create-stripe-recharge] insert error:', insErr?.message);
      return J(500, { ok: false, error: 'db_error' });
    }

    // Stripe Checkout Session (hosted page). Amount in cents. Email → Stripe receipt.
    const siteUrl = Deno.env.get('PUBLIC_SITE_URL') ?? 'https://tricigo.com';
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: payer_email,
      client_reference_id: intent.id,
      success_url: `${siteUrl}/recargar?status=ok&intent=${intent.id}`,
      cancel_url: `${siteUrl}/recargar?status=cancel&intent=${intent.id}`,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(chargeUsd * 100),
          product_data: { name: `TriciGo — recarga para ${recipient.full_name ?? 'usuario'}` },
        },
      }],
      payment_intent_data: { metadata: { tricigo_intent_id: intent.id } },
      metadata: { tricigo_intent_id: intent.id },
    });

    await supabase
      .from('payment_intents')
      .update({ stripe_payment_intent_id: session.id, status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', intent.id);

    return J(200, {
      ok: true, provider: 'stripe', intentId: intent.id,
      amountUsdRequested: amt, feeUsd, chargeUsd, amountCupCredited, exchangeRate,
      redirectUrl: session.url,
    });
  } catch (err) {
    console.error('[create-stripe-recharge] error:', err);
    return J(500, { ok: false, error: 'internal_error' });
  }
});
