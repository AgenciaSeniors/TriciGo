// DEPRECATED: TropiPay removed. Will be replaced by Stripe.
// BUG-188 fix: requires JWT and asserts auth.uid() = p_user_id.
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

interface CreateLinkRequest {
  user_id: string;
  amount_cup: number;
  corporate_account_id?: string;
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

  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_048_576) return new Response(JSON.stringify({ error: 'Payload too large' }), { status: 413 });

  try {
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`create-tropipay-link:${clientIP}`, 5, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // BUG-188: require JWT and ownership check.
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

    const body: CreateLinkRequest = await req.json();
    const { user_id, amount_cup, corporate_account_id } = body;

    if (!user_id || !Number.isFinite(amount_cup) || amount_cup <= 0 || amount_cup > 10_000_000) {
      return new Response(
        JSON.stringify({ ok: false, error: 'invalid_params' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { data: roleRow } = await supabase.from('users').select('role').eq('id', user.id).single();
    const isAdmin = roleRow && ['admin', 'super_admin'].includes(roleRow.role as string);
    if (!isAdmin && user.id !== user_id) {
      return new Response(JSON.stringify({ error: 'Forbidden: can only create link for your own account' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: configs } = await supabase
      .from('platform_config').select('key, value')
      .in('key', ['tropipay_client_id','tropipay_client_secret','tropipay_server_mode','tropipay_min_recharge_cup','tropipay_max_recharge_cup']);

    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => {
      const raw = c.value;
      configMap[c.key] = typeof raw === 'string' && raw.startsWith('"') ? JSON.parse(raw) : String(raw);
    });

    const clientId = configMap['tropipay_client_id'] ?? '';
    const clientSecret = configMap['tropipay_client_secret'] ?? '';
    const serverMode = configMap['tropipay_server_mode'] ?? 'Development';
    const minRecharge = parseInt(configMap['tropipay_min_recharge_cup'] ?? '500', 10);
    const maxRecharge = parseInt(configMap['tropipay_max_recharge_cup'] ?? '50000', 10);

    if (!clientId || !clientSecret) {
      return new Response(JSON.stringify({ ok: false, error: 'not_configured' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (amount_cup < minRecharge) return new Response(JSON.stringify({ ok: false, error: 'amount_too_low', min: minRecharge }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (amount_cup > maxRecharge) return new Response(JSON.stringify({ ok: false, error: 'amount_too_high', max: maxRecharge }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { data: rateRow } = await supabase.from('exchange_rates').select('usd_cup_rate').eq('is_current', true).single();
    const exchangeRate = rateRow?.usd_cup_rate ?? 520;
    const amountUsd = Number((amount_cup / exchangeRate).toFixed(2));

    if (amountUsd < 1) return new Response(JSON.stringify({ ok: false, error: 'amount_too_low_usd', min_usd: 1, calculated_usd: amountUsd }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const reference = `tg-recharge-${crypto.randomUUID().slice(0, 12)}`;
    const intentRow: Record<string, unknown> = {
      user_id, amount_cup, amount_usd: amountUsd, exchange_rate: exchangeRate, status: 'created', tropipay_reference: reference,
    };
    if (corporate_account_id) intentRow.corporate_account_id = corporate_account_id;

    const { data: intent, error: insertError } = await supabase.from('payment_intents').insert(intentRow).select().single();
    if (insertError) return new Response(JSON.stringify({ ok: false, error: 'db_error', detail: insertError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const baseUrl = getTropiPayBaseUrl(serverMode);
    let accessToken: string;
    try {
      accessToken = await getTropiPayToken(baseUrl, clientId, clientSecret);
    } catch (err) {
      await supabase.from('payment_intents').update({ status: 'failed', error_message: String(err), updated_at: new Date().toISOString() }).eq('id', intent.id);
      return new Response(JSON.stringify({ ok: false, error: 'tropipay_auth_failed', detail: String(err) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const webhookUrl = `${supabaseUrl}/functions/v1/process-tropipay-webhook`;
    const paymentCardRes = await fetch(`${baseUrl}/api/v2/paymentcards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        reference,
        concept: corporate_account_id ? 'Recarga Corporativa TriciGo' : 'Recarga TriciGo Wallet',
        description: `Recarga de ${amount_cup} CUP`,
        amount: Math.round(amountUsd * 100),
        currency: 'USD',
        singleUse: true,
        reasonId: 4,
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
      await supabase.from('payment_intents').update({ status: 'failed', error_message: errorBody, updated_at: new Date().toISOString() }).eq('id', intent.id);
      return new Response(JSON.stringify({ ok: false, error: 'tropipay_create_failed', status: paymentCardRes.status, detail: errorBody }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const paymentCard = await paymentCardRes.json();
    const paymentUrl = paymentCard.shortUrl || paymentCard.paymentUrl || `${baseUrl}/paymentcard/${paymentCard.id}`;
    const shortUrl = paymentCard.shortUrl || paymentUrl;

    await supabase.from('payment_intents')
      .update({ tropipay_id: String(paymentCard.id ?? ''), payment_url: paymentUrl, short_url: shortUrl, status: 'pending', tropipay_response: paymentCard, updated_at: new Date().toISOString() })
      .eq('id', intent.id);

    return new Response(JSON.stringify({ ok: true, paymentUrl, shortUrl, intentId: intent.id, amountUsd, exchangeRate }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
