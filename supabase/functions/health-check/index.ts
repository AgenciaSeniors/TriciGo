import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const start = Date.now();
  const checks: Record<string, string> = {};

  // Check database connection
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );
    const { error } = await supabase.from('platform_config').select('key').limit(1);
    checks.database = error ? `error: ${error.message}` : 'ok';
  } catch (err) {
    checks.database = `error: ${err instanceof Error ? err.message : 'unknown'}`;
  }

  // Check auth service
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    );
    const { error } = await supabase.auth.getSession();
    checks.auth = error ? `error: ${error.message}` : 'ok';
  } catch (err) {
    checks.auth = `error: ${err instanceof Error ? err.message : 'unknown'}`;
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');
  const duration = Date.now() - start;

  return new Response(
    JSON.stringify({
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      duration_ms: duration,
      checks,
    }),
    {
      status: allOk ? 200 : 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  );
});
