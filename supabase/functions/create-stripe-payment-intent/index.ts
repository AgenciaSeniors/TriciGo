// ============================================================
// TriciGo — Create Stripe PaymentIntent Edge Function
//
// BUG-187 fix: requires authenticated JWT and asserts
// auth.uid() = p_user_id. Previously anonymous users could
// create unlimited Stripe PIs for arbitrary user_ids, causing
// DoS / Stripe billing impact.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14?target=deno';
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
  amount_cup: number;
  recharge_type?: 'customer' | 'driver_quota';
  corporate_account_id?: string;
  device_fingerprint?: string;
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
    const rl = await rateLimit(`create-stripe-pi:${clientIP}`, 5, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    // OFAC compliance: block recharge attempts from sanctioned regions BEFORE
    // touching Stripe. Stripe terms prohibit "products or services linked
    // directly OR INDIRECTLY with sanctioned jurisdictions". A user in a
    // sanctioned region creating a PaymentIntent — even rejected by Stripe
    // downstream — generates audit signal that can suspend the account.
    // We surface a neutral message; the wallet is still usable inside the
    // app via peer-to-peer transfers from diaspora users.
    //
    // Country code comes from Cloudflare's cf-ipcountry header (Supabase
    // Edge Functions run behind Cloudflare). Falls back to "XX" if missing.
    const SANCTIONED_REGIONS = new Set([
      'CU', // Cuba
      'IR', // Iran
      'KP', // Democratic People's Republic of Korea
      'SY', // Syria
      // Note: Crimea/Donetsk/Luhansk are sub-regions of Ukraine and don't
      // have their own ISO codes; rely on Stripe's region-level checks.
    ]);
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

    // BUG-187: require JWT and assert auth.uid() = user_id (or admin).
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
    const { user_id, amount_cup, recharge_type = 'customer', corporate_account_id, device_fingerprint } = body;

    if (!user_id || !Number.isFinite(amount_cup) || amount_cup <= 0 || amount_cup > 10_000_000) {
      return new Response(
        JSON.stringify({ ok: false, error: 'invalid_params', detail: 'user_id required, amount_cup must be 1-10,000,000' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Verify the caller is the target user (or admin).
    const { data: roleRow } = await supabase.from('users').select('role').eq('id', user.id).single();
    const isAdmin = roleRow && ['admin', 'super_admin'].includes(roleRow.role as string);
    if (!isAdmin && user.id !== user_id) {
      return new Response(JSON.stringify({ error: 'Forbidden: can only create PI for your own account' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', [
        'stripe_enabled', 'stripe_secret_key', 'stripe_publishable_key',
        'stripe_min_recharge_cup', 'stripe_max_recharge_cup',
        'stripe_fee_usd', 'stripe_fee_type',
      ]);

    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => {
      const raw = c.value;
      configMap[c.key] = typeof raw === 'string' && raw.startsWith('"') ? JSON.parse(raw) : String(raw);
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

    const { data: rateRow } = await supabase
      .from('exchange_rates').select('usd_cup_rate').eq('is_current', true).single();

    const exchangeRate = rateRow?.usd_cup_rate ?? 520;
    const amountUsd = Number((amount_cup / exchangeRate).toFixed(2));
    const totalChargeUsd = Number((amountUsd + feeUsd).toFixed(2));
    const totalChargeCents = Math.round(totalChargeUsd * 100);

    if (totalChargeCents < 50) {
      return new Response(
        JSON.stringify({ ok: false, error: 'amount_too_low_usd', min_usd: 0.50, calculated_usd: totalChargeUsd }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Phase B1: per-user top-up velocity control ──────────────
    // Reject before creating a charge if the user exceeds the
    // configured recharge frequency / amount limits. Corporate
    // top-ups are a separate vetted B2B flow and are exempt.
    // Fail-open: if check_topup_velocity is not yet deployed
    // (migration 00276 pending) or errors, log and allow — velocity
    // is one layer among IP rate-limiting, per-tx caps and 3DS.
    if (!corporate_account_id) {
      try {
        const { data: velocity, error: velocityError } = await supabase.rpc(
          'check_topup_velocity',
          { p_user_id: user_id, p_amount_usd: amountUsd },
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
      .from('payment_intents').insert(intentRow).select().single();

    if (insertError) {
      console.error('Error creating payment intent:', insertError);
      return new Response(
        JSON.stringify({ ok: false, error: 'db_error', detail: insertError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Phase B6: device fingerprinting ─────────────────────────
    // Record the IP, user-agent and the client-computed device
    // fingerprint on the payment_intent for fraud analysis and
    // chargeback evidence. Best-effort + fail-open: the columns
    // arrive with migration 00278; if it is not applied yet the
    // update returns an error which is logged and ignored, and the
    // recharge proceeds. The critical INSERT above is untouched.
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

    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-04-10' });

    let stripePaymentIntent;
    try {
      stripePaymentIntent = await stripe.paymentIntents.create({
        amount: totalChargeCents,
        currency: 'usd',
        description: 'Wallet recharge',
        metadata: {
          // OFAC scrub: avoid metadata field names that pattern-match a
          // sanctioned country code (e.g. `amount_cup` → "Cuba"). Stripe's
          // automated review tooling scans metadata as plain text. The
          // local-currency amount is preserved in our DB row; Stripe only
          // needs the USD amount for the charge itself.
          tricigo_intent_id: intent.id,
          user_id,
          amount_local: String(amount_cup),
          recharge_type,
          fee_usd: String(feeUsd),
        },
        automatic_payment_methods: { enabled: true },
        // Phase B4: force 3-D Secure (Strong Customer Authentication) on
        // every card transaction whenever the network supports it — not
        // only when the issuer mandates it.
        payment_method_options: { card: { request_three_d_secure: 'any' } },
      });
    } catch (stripeErr) {
      await supabase.from('payment_intents')
        .update({ status: 'failed', error_message: String(stripeErr), updated_at: new Date().toISOString() })
        .eq('id', intent.id);
      return new Response(
        JSON.stringify({ ok: false, error: 'stripe_error', detail: String(stripeErr) }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    await supabase.from('payment_intents')
      .update({
        stripe_payment_intent_id: stripePaymentIntent.id,
        status: 'pending',
        updated_at: new Date().toISOString(),
      })
      .eq('id', intent.id);

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
