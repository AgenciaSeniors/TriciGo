// ============================================================
// TriciGo — Sync Exchange Rate Edge Function
// BUG-160 + BUG-201: service_role-only via JWT role claim.
// Verify the Authorization Bearer's payload contains role=service_role
// (Supabase gateway with verify_jwt=true already validated the
// signature). This avoids env-var-vs-cron drift.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function isServiceRoleJwt(authHeader: string): boolean {
  if (!authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

async function scrapeElToque(): Promise<number | null> {
  const res = await fetch('https://eltoque.com', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es,en;q=0.9',
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const statistics = data?.props?.pageProps?.money?.data?.api?.statistics;
      if (statistics?.USD?.median) {
        const rate = Number(statistics.USD.median);
        if (!isNaN(rate) && rate > 0) return rate;
      }
      if (statistics?.USD?.avg) {
        const rate = Number(statistics.USD.avg);
        if (!isNaN(rate) && rate > 0) return rate;
      }
    } catch {}
  }
  for (const pattern of [
    /1\s*USD[^0-9]{0,50}([\d]{2,4}(?:\.[\d]{1,2})?)\s*CUP/i,
    /USD[^0-9]{0,30}([\d]{2,4}(?:\.[\d]{1,2})?)\s*(?:CUP|pesos)/i,
  ]) {
    const match = html.match(pattern);
    if (match) {
      const rate = parseFloat(match[1]);
      if (!isNaN(rate) && rate > 50 && rate < 10000) return rate;
    }
  }
  return null;
}

async function fetchFromAPI(token: string): Promise<number | null> {
  const eltoqueRes = await fetch('https://tasas.eltoque.com/v1/trmi', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!eltoqueRes.ok) return null;
  const eltoqueData = await eltoqueRes.json();
  if (eltoqueData?.tasas?.USD?.median) return Number(eltoqueData.tasas.USD.median);
  if (eltoqueData?.USD?.median) return Number(eltoqueData.USD.median);
  if (eltoqueData?.tasas?.USD?.venta) return Number(eltoqueData.tasas.USD.venta);
  if (typeof eltoqueData?.USD === 'number') return eltoqueData.USD;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // BUG-160 + BUG-201: only service_role JWTs allowed.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!isServiceRoleJwt(authHeader)) {
    return new Response(
      JSON.stringify({ error: 'Forbidden: sync-exchange-rate is internal-only' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: configs } = await supabase.from('platform_config').select('key, value').in('key', ['eltoque_api_token', 'exchange_rate_auto_update']);
    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => { configMap[c.key] = c.value; });

    const token = configMap['eltoque_api_token'] ?? '';
    const autoUpdate = configMap['exchange_rate_auto_update'] ?? 'true';

    if (autoUpdate === 'false') {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'auto_update_disabled' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let usdCupRate: number | null = null;
    let source = '';
    if (token && token.trim() !== '') {
      usdCupRate = await fetchFromAPI(token);
      if (usdCupRate) source = 'eltoque_api';
    }
    if (!usdCupRate) {
      usdCupRate = await scrapeElToque();
      if (usdCupRate) source = 'eltoque_scraping';
    }
    if (!usdCupRate || isNaN(usdCupRate) || usdCupRate <= 0) {
      return new Response(JSON.stringify({ ok: false, error: 'all_methods_failed' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    await supabase.from('exchange_rates').update({ is_current: false }).eq('is_current', true);
    const { error: insertError } = await supabase.from('exchange_rates').insert({
      source, usd_cup_rate: usdCupRate, fetched_at: new Date().toISOString(), is_current: true,
    });
    if (insertError) return new Response(JSON.stringify({ ok: false, error: 'insert_error', detail: insertError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    return new Response(JSON.stringify({ ok: true, usd_cup_rate: usdCupRate, source }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
