// resolve-recharge-recipient — PUBLIC (verify_jwt=false).
// Given a Cuban phone, returns the recipient's display name for the public
// /recargar page. Normalized lookup (00461 fix) via find_recipient_for_recharge.
// Anti-enumeration guard: per-IP rate-limit (the public path's protection).
// Returns ONLY the name — never the user id (create-stripe-recharge-intent
// re-resolves server-side so the client cannot forge the recipient).
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

function json(corsHeaders: Record<string, string>, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = await rateLimit(`resolve-recipient:${clientIP}`, 20, 60 * 1000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const { phone } = (await req.json()) as { phone?: string };
    if (!phone || typeof phone !== 'string' || phone.replace(/\D/g, '').length < 8) {
      return json(corsHeaders, 200, { found: false });
    }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await supabase.rpc('find_recipient_for_recharge', { p_phone: phone });
    if (error) {
      console.warn('[resolve-recipient] rpc error (treating as not found):', error.message);
      return json(corsHeaders, 200, { found: false });
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.id) return json(corsHeaders, 200, { found: false });
    return json(corsHeaders, 200, { found: true, fullName: row.full_name ?? '' });
  } catch (err) {
    console.error('[resolve-recipient] error:', err);
    return json(corsHeaders, 200, { found: false });
  }
});
