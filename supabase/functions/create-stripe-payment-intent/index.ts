// ============================================================
// TriciGo — Create Stripe PaymentIntent Edge Function
//
// Creates a Stripe PaymentIntent for wallet recharges (customer
// or driver quota). Returns the client_secret so the frontend
// can confirm the payment via Stripe Elements.
//
// IMPORTANT: Description sent to Stripe is GENERIC ("Wallet
// recharge") — never mentions Cuba, transport, or ride-hailing.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

// ── CORS ──
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
  amount_cup: number;
  /** 'customer' (default) or 'driver_quota' */
  recharge_type?: 'customer' | 'driver_quota';
  /** Optional corporate account ID */
  corporate_account_id?: string;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Reject oversized payloads
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_048_576) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
  }

  try {
    // Rate limit: 5 requests per IP per minute
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`create-stripe-pi:${clientIP}`, 5, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Parse request
    const body: CreateIntentRequest = await req.json();
    const { user_id, amount_cup, recharge_type = 'customer', corporate_account_id } = body;

    if (!user_id || !Number.isFinite(amount_cup) || amount_cup <= 0 || amount_cup > 10_000_000) {
      return new Response(
        JSON.stringify({ ok: false, error: 'invalid_params', detail: 'user_id required, amount_cup must be 1-10,000,000' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 2. Read Stripe config from platform_config
    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', [
        'stripe_enabled',
        'stripe_secret_key',
        'stripe_publishable_key',
        'stripe_min_recharge_cup',
        'stripe_max_recharge_cup',
        'stripe_fee_usd',
        'stripe_fee_type',
      ]);

    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => {
      const raw = c.value;
      configMap[c.key] = typeof raw === 'string' && raw.startsWith('"')
        ? JSON.parse(raw)
        : String(raw);
    });

    const stripeEnabled = configMap['stripe_enabled'] !== 'false';
    const stripeSecretKey = configMap['stripe_secret_key'] ?? '';
    const publishableKey = configMap['stripe_publishable_key'] ?? '';
    const minRecharge = parseInt(configMap['stripe_min_recharge_cup'] ?? '500', 10);
    const maxRecharge = parseInt(configMap['stripe_max_recharge_cup'] ?? '50000', 10);
    const feeUsd = parseFloat(configMap['stripe_fee_usd'] ?? '2.00');

    if (!stripeEnabled) {
      return new Response(
        JSON.stringify({ ok: false, error: 'stripe_disabled', detail: 'Stripe payments are currently disabled' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (!stripeSecretKey || stripeSecretKey.includes('REPLACE')) {
      return new Response(
        JSON.stringify({ ok: false, error: 'not_configured', detail: 'Stripe credentials not set in platform_config' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Validate amount range
    if (amount_cup < minRecharge) {
      return new Response(
        JSON.stringify({ ok: false, error: 'amount_too_low', min: minRecharge }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (amount_cup > maxRecharge) {
      return new Response(
        JSON.stringify({ ok: false, error: 'amount_too_high', max: maxRecharge }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 3. Get exchange rate
    const { data: rateRow } = await supabase
      .from('exchange_rates')
      .select('usd_cup_rate')
      .eq('is_current', true)
      .single();

    const exchangeRate = rateRow?.usd_cup_rate ?? 520;
    const amountUsd = Number((amount_cup / exchangeRate).toFixed(2));

    // Total charge in USD = amount + fee
    const totalChargeUsd = Number((amountUsd + feeUsd).toFixed(2));
    const totalChargeCents = Math.round(totalChargeUsd * 100);

    if (totalChargeCents < 50) {
      return new Response(
        JSON.stringify({ ok: false, error: 'amount_too_low_usd', min_usd: 0.50, calculated_usd: totalChargeUsd }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 4. Create payment intent record in DB first
    const intentRow: Record<string, unknown> = {
      user_id,
      amount_cup,
      amount_usd: amountUsd,
      exchange_rate: exchangeRate,
      fee_usd: feeUsd,
      status: 'created',
      payment_provider: 'stripe',
      intent_type: recharge_type === 'driver_quota' ? 'recharge' : 'recharge',
    };
    if (corporate_account_id) {
      intentRow.corporate_account_id = corporate_account_id;
    }

    const { data: intent, error: insertError } = await supabase
      .from('payment_intents')
      .insert(intentRow)
      .select()
      .single();

    if (insertError) {
      console.error('Error creating payment intent:', insertError);
      return new Response(
        JSON.stringify({ ok: false, error: 'db_error', detail: insertError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 5. Create Stripe PaymentIntent
    // IMPORTANT: Description is GENERIC — never mention Cuba/transport
    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-04-10' });

    let stripePaymentIntent;
    try {
      stripePaymentIntent = await stripe.paymentIntents.create({
        amount: totalChargeCents,
        currency: 'usd',
        description: 'Wallet recharge',
        metadata: {
          tricigo_intent_id: intent.id,
          user_id,
          amount_cup: String(amount_cup),
          recharge_type,
          fee_usd: String(feeUsd),
        },
        automatic_payment_methods: {
          enabled: true,
        },
      });
    } catch (stripeErr) {
      console.error(JSON.stringify({
        event: 'stripe_create_failed',
        intent_id: intent.id,
        user_id,
        amount_cup,
        error: String(stripeErr),
        timestamp: new Date().toISOString(),
      }));

      await supabase
        .from('payment_intents')
        .update({ status: 'failed', error_message: String(stripeErr), updated_at: new Date().toISOString() })
        .eq('id', intent.id);

      return new Response(
        JSON.stringify({ ok: false, error: 'stripe_error', detail: String(stripeErr) }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 6. Update payment intent with Stripe PI ID
    await supabase
      .from('payment_intents')
      .update({
        stripe_payment_intent_id: stripePaymentIntent.id,
        status: 'pending',
        updated_at: new Date().toISOString(),
      })
      .eq('id', intent.id);

    console.log(`Stripe PI created: ${stripePaymentIntent.id} for intent ${intent.id} ($${totalChargeUsd} USD)`);

    // 7. Return client_secret to frontend
    return new Response(
      JSON.stringify({
        ok: true,
        clientSecret: stripePaymentIntent.client_secret,
        intentId: intent.id,
        amountUsd,
        amountCup: amount_cup,
        feeUsd,
        exchangeRate,
        publishableKey,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Unexpected error in create-stripe-payment-intent:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
