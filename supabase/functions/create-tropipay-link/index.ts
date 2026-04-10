// ============================================================
// TriciGo — Create TropiPay Payment Link Edge Function
//
// Creates a TropiPay payment card (link) for wallet recharges.
// Follows the same pattern as sync-exchange-rate:
//  - Reads config from platform_config
//  - Calls external API with fetch()
//  - Stores result in database
//
// TropiPay API docs: https://doc.tropipay.com
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

// ── CORS: restrict to allowed origins ──
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

interface CreateLinkRequest {
  user_id: string;
  amount_cup: number; // Amount in CUP centavos
  corporate_account_id?: string; // Optional: if set, credits corporate wallet
}

/** Get TropiPay API base URL based on server mode */
function getTropiPayBaseUrl(mode: string): string {
  return mode === 'Production'
    ? 'https://www.tropipay.com'
    : 'https://tropipay-dev.herokuapp.com';
}

/** Authenticate with TropiPay OAuth2 and get access token */
async function getTropiPayToken(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v2/access/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TropiPay auth failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.access_token;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // BUG-083: Reject oversized payloads (1 MB limit)
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_048_576) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
  }

  try {
    // Rate limit: 5 requests per IP per minute
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`create-tropipay-link:${clientIP}`, 5, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Parse request body
    const body: CreateLinkRequest = await req.json();
    const { user_id, amount_cup, corporate_account_id } = body;

    if (!user_id || !Number.isFinite(amount_cup) || amount_cup <= 0 || amount_cup > 10_000_000) {
      return new Response(
        JSON.stringify({ ok: false, error: 'invalid_params', detail: 'user_id required and amount_cup must be a finite number between 1 and 10,000,000' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 2. Read TropiPay config from platform_config
    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', [
        'tropipay_client_id',
        'tropipay_client_secret',
        'tropipay_server_mode',
        'tropipay_min_recharge_cup',
        'tropipay_max_recharge_cup',
      ]);

    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => {
      // JSONB values are stored as quoted strings, parse them
      const raw = c.value;
      configMap[c.key] = typeof raw === 'string' && raw.startsWith('"')
        ? JSON.parse(raw)
        : String(raw);
    });

    const clientId = configMap['tropipay_client_id'] ?? '';
    const clientSecret = configMap['tropipay_client_secret'] ?? '';
    const serverMode = configMap['tropipay_server_mode'] ?? 'Development';
    const minRecharge = parseInt(configMap['tropipay_min_recharge_cup'] ?? '500', 10);
    const maxRecharge = parseInt(configMap['tropipay_max_recharge_cup'] ?? '50000', 10);

    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({ ok: false, error: 'not_configured', detail: 'TropiPay credentials not set in platform_config' }),
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

    // 3. Get current exchange rate
    const { data: rateRow } = await supabase
      .from('exchange_rates')
      .select('usd_cup_rate')
      .eq('is_current', true)
      .single();

    const exchangeRate = rateRow?.usd_cup_rate ?? 520;
    const amountUsd = Number((amount_cup / exchangeRate).toFixed(2));

    // Ensure minimum $1 USD for TropiPay
    if (amountUsd < 1) {
      return new Response(
        JSON.stringify({ ok: false, error: 'amount_too_low_usd', min_usd: 1, calculated_usd: amountUsd }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 4. Create payment intent record first (to get the ID for the reference)
    const reference = `tg-recharge-${crypto.randomUUID().slice(0, 12)}`;

    const intentRow: Record<string, unknown> = {
      user_id,
      amount_cup,
      amount_usd: amountUsd,
      exchange_rate: exchangeRate,
      status: 'created',
      tropipay_reference: reference,
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

    // 5. Authenticate with TropiPay
    const baseUrl = getTropiPayBaseUrl(serverMode);
    let accessToken: string;
    try {
      accessToken = await getTropiPayToken(baseUrl, clientId, clientSecret);
    } catch (err) {
      // BUG-092: Structured logging for failed payment intent (auth phase)
      console.error(JSON.stringify({
        event: 'payment_intent_failed',
        phase: 'tropipay_auth',
        intent_id: intent.id,
        reference,
        user_id,
        amount_cup,
        amount_usd: amountUsd,
        error: String(err),
        timestamp: new Date().toISOString(),
      }));

      // Update intent with error
      await supabase
        .from('payment_intents')
        .update({ status: 'failed', error_message: String(err), updated_at: new Date().toISOString() })
        .eq('id', intent.id);

      return new Response(
        JSON.stringify({ ok: false, error: 'tropipay_auth_failed', detail: String(err) }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 6. Create TropiPay payment card (link)
    const webhookUrl = `${supabaseUrl}/functions/v1/process-tropipay-webhook`;

    const paymentCardRes = await fetch(`${baseUrl}/api/v2/paymentcards`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        reference,
        concept: corporate_account_id ? 'Recarga Corporativa TriciGo' : 'Recarga TriciGo Wallet',
        description: `Recarga${corporate_account_id ? ' corporativa' : ''} de ${amount_cup} CUP (~$${amountUsd} USD)`,
        amount: Math.round(amountUsd * 100), // TropiPay expects cents
        currency: 'USD',
        singleUse: true,
        reasonId: 4, // "Services" category
        lang: 'es',
        urlSuccess: `${supabaseUrl}/functions/v1/process-tropipay-webhook?event=success&ref=${reference}`,
        urlFailed: `${supabaseUrl}/functions/v1/process-tropipay-webhook?event=failed&ref=${reference}`,
        urlNotification: webhookUrl,
        directCharge: true,
        favorite: false,
        serviceDate: new Date().toISOString().split('T')[0],
      }),
    });

    if (!paymentCardRes.ok) {
      const errorBody = await paymentCardRes.text();
      // BUG-092: Structured logging for failed payment intents
      console.error(JSON.stringify({
        event: 'payment_intent_failed',
        intent_id: intent.id,
        reference,
        user_id,
        amount_cup,
        amount_usd: amountUsd,
        tropipay_status: paymentCardRes.status,
        error: errorBody,
        timestamp: new Date().toISOString(),
      }));

      // Update intent with error
      await supabase
        .from('payment_intents')
        .update({
          status: 'failed',
          error_message: `TropiPay API ${paymentCardRes.status}: ${errorBody}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', intent.id);

      return new Response(
        JSON.stringify({ ok: false, error: 'tropipay_create_failed', status: paymentCardRes.status, detail: errorBody }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const paymentCard = await paymentCardRes.json();

    // 7. Update payment intent with TropiPay response
    const paymentUrl = paymentCard.shortUrl || paymentCard.paymentUrl || `${baseUrl}/paymentcard/${paymentCard.id}`;
    const shortUrl = paymentCard.shortUrl || paymentUrl;

    await supabase
      .from('payment_intents')
      .update({
        tropipay_id: String(paymentCard.id ?? ''),
        payment_url: paymentUrl,
        short_url: shortUrl,
        status: 'pending',
        tropipay_response: paymentCard,
        updated_at: new Date().toISOString(),
      })
      .eq('id', intent.id);

    console.log(`TropiPay link created: ${reference} → ${shortUrl} (${amountUsd} USD)`);

    // 8. Return payment URL to client
    return new Response(
      JSON.stringify({
        ok: true,
        paymentUrl,
        shortUrl,
        intentId: intent.id,
        amountUsd,
        exchangeRate,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Unexpected error in create-tropipay-link:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
