// DEPRECATED: TropiPay removed.
// BUG-189 fix: requires JWT and asserts auth.uid() = ride.customer_id.
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

function getTropiPayBaseUrl(mode: string): string {
  return mode === 'Production' ? 'https://www.tropipay.com' : 'https://tropipay-dev.herokuapp.com';
}

async function getTropiPayToken(baseUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v2/access/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) { const body = await res.text(); throw new Error(`TropiPay auth failed (${res.status}): ${body}`); }
  const data = await res.json();
  return data.access_token;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`create-ride-payment-link:${clientIP}`, 5, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // BUG-189: require JWT.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const supabaseAuth = createClient(supabaseUrl, serviceRoleKey);
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json();
    const { ride_id } = body;
    if (!ride_id) return new Response(JSON.stringify({ ok: false, error: 'invalid_params', detail: 'ride_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { data: ride, error: rideError } = await supabase.from('rides').select('*').eq('id', ride_id).single();
    if (rideError || !ride) return new Response(JSON.stringify({ ok: false, error: 'ride_not_found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Caller must be the ride customer or admin.
    const { data: roleRow } = await supabase.from('users').select('role').eq('id', user.id).single();
    const isAdmin = roleRow && ['admin', 'super_admin'].includes(roleRow.role as string);
    if (!isAdmin && ride.customer_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden: only the ride customer can create the payment link' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (ride.payment_method !== 'tropipay') return new Response(JSON.stringify({ ok: false, error: 'invalid_payment_method' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (ride.status !== 'completed') return new Response(JSON.stringify({ ok: false, error: 'ride_not_completed' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (ride.payment_status !== 'pending') return new Response(JSON.stringify({ ok: false, error: 'payment_not_pending' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    if (ride.payment_intent_id) {
      const { data: existingIntent } = await supabase.from('payment_intents').select('*').eq('id', ride.payment_intent_id).single();
      if (existingIntent && existingIntent.status !== 'failed') {
        return new Response(JSON.stringify({ ok: true, paymentUrl: existingIntent.payment_url, shortUrl: existingIntent.short_url, intentId: existingIntent.id, amountCup: existingIntent.amount_cup, amountUsd: existingIntent.amount_usd }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    const { data: configs } = await supabase.from('platform_config').select('key, value').in('key', ['tropipay_client_id','tropipay_client_secret','tropipay_server_mode']);
    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => { const raw = c.value; configMap[c.key] = typeof raw === 'string' && raw.startsWith('"') ? JSON.parse(raw) : String(raw); });

    const clientId = configMap['tropipay_client_id'] ?? '';
    const clientSecret = configMap['tropipay_client_secret'] ?? '';
    const serverMode = configMap['tropipay_server_mode'] ?? 'Development';
    if (!clientId || !clientSecret) return new Response(JSON.stringify({ ok: false, error: 'not_configured' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const fareCup = ride.final_fare_cup;
    const exchangeRate = ride.exchange_rate_usd_cup ?? 520;
    const amountUsd = Number((fareCup / exchangeRate).toFixed(2));

    if (amountUsd < 1) return new Response(JSON.stringify({ ok: false, error: 'amount_too_low_usd', min_usd: 1, calculated_usd: amountUsd }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const reference = `tg-ride-${ride_id.slice(0, 12)}`;
    const { data: intent, error: insertError } = await supabase.from('payment_intents').insert({
      user_id: ride.customer_id, amount_cup: fareCup, amount_usd: amountUsd, exchange_rate: exchangeRate,
      status: 'created', tropipay_reference: reference, intent_type: 'ride_payment', ride_id: ride_id,
    }).select().single();

    if (insertError) {
      if (insertError.code === '23505') {
        const { data: existing } = await supabase.from('payment_intents').select('*').eq('tropipay_reference', reference).single();
        if (existing && existing.payment_url) {
          return new Response(JSON.stringify({ ok: true, paymentUrl: existing.payment_url, shortUrl: existing.short_url, intentId: existing.id, amountCup: fareCup, amountUsd }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
      return new Response(JSON.stringify({ ok: false, error: 'db_error', detail: insertError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const baseUrl = getTropiPayBaseUrl(serverMode);
    let accessToken: string;
    try { accessToken = await getTropiPayToken(baseUrl, clientId, clientSecret); }
    catch (err) {
      await supabase.from('payment_intents').update({ status: 'failed', error_message: String(err), updated_at: new Date().toISOString() }).eq('id', intent.id);
      return new Response(JSON.stringify({ ok: false, error: 'tropipay_auth_failed', detail: String(err) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const webhookUrl = `${supabaseUrl}/functions/v1/process-tropipay-webhook`;
    const paymentCardRes = await fetch(`${baseUrl}/api/v2/paymentcards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        reference, concept: 'Pago viaje TriciGo',
        description: `Pago de viaje ${fareCup} CUP`,
        amount: Math.round(amountUsd * 100), currency: 'USD', singleUse: true, reasonId: 4, lang: 'es',
        urlSuccess: `${supabaseUrl}/functions/v1/process-tropipay-webhook?event=success&ref=${reference}`,
        urlFailed: `${supabaseUrl}/functions/v1/process-tropipay-webhook?event=failed&ref=${reference}`,
        urlNotification: webhookUrl, directCharge: true, favorite: false,
        serviceDate: new Date().toISOString().split('T')[0],
      }),
    });

    if (!paymentCardRes.ok) {
      const errorBody = await paymentCardRes.text();
      await supabase.from('payment_intents').update({ status: 'failed', error_message: errorBody, updated_at: new Date().toISOString() }).eq('id', intent.id);
      return new Response(JSON.stringify({ ok: false, error: 'tropipay_create_failed', status: paymentCardRes.status, detail: errorBody }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const paymentCard = await paymentCardRes.json();
    const paymentUrl = paymentCard.shortUrl || paymentCard.paymentUrl || `${baseUrl}/paymentcard/${paymentCard.id}`;
    const shortUrl = paymentCard.shortUrl || paymentUrl;

    await supabase.from('payment_intents').update({ tropipay_id: String(paymentCard.id ?? ''), payment_url: paymentUrl, short_url: shortUrl, status: 'pending', tropipay_response: paymentCard, updated_at: new Date().toISOString() }).eq('id', intent.id);
    await supabase.from('rides').update({ payment_intent_id: intent.id }).eq('id', ride_id);

    return new Response(JSON.stringify({ ok: true, paymentUrl, shortUrl, intentId: intent.id, amountCup: fareCup, amountUsd }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
