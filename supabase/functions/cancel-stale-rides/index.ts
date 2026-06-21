// supabase/functions/cancel-stale-rides/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

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

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // BUG-036 + BUG-199: cron auth. A cron presents the service-role key in the
  // `apikey` header (Authorization carries only the anon JWT), so the old
  // `authHeader.includes(SERVICE_ROLE_KEY)` check always failed. Authorize on the
  // `apikey` header like auto-admin/sync-weather; keep the x-cron-secret fallback.
  // (No cron drives this EF today — the SQL cron cleanup_orphan_searching_rides
  // covers it — but fix the check for parity / future use.)
  const cronSecret = Deno.env.get('CRON_SECRET');
  const requestSecret = req.headers.get('x-cron-secret');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const isServiceRole = serviceRoleKey !== '' && (req.headers.get('apikey') ?? '') === serviceRoleKey;
  if (!isServiceRole && (!cronSecret || requestSecret !== cronSecret)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await supabase.rpc('auto_cancel_stale_searching_rides');

    if (error) throw error;

    return new Response(
      JSON.stringify({
        message: 'Stale rides cleanup completed',
        canceled_count: data ?? 0,
        timestamp: new Date().toISOString(),
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
