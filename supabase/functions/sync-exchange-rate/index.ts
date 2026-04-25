// BUG-160 + BUG-201 + BUG-199: apikey === env.SUPABASE_SERVICE_ROLE_KEY
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function scrapeElToque(): Promise<number | null> {
  const res = await fetch('https://eltoque.com', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html', 'Accept-Language': 'es,en;q=0.9',
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      const stats = data?.props?.pageProps?.money?.data?.api?.statistics;
      if (stats?.USD?.median) { const r = Number(stats.USD.median); if (!isNaN(r) && r > 0) return r; }
      if (stats?.USD?.avg)    { const r = Number(stats.USD.avg);    if (!isNaN(r) && r > 0) return r; }
    } catch {}
  }
  for (const re of [
    /1\s*USD[^0-9]{0,50}([\d]{2,4}(?:\.[\d]{1,2})?)\s*CUP/i,
    /USD[^0-9]{0,30}([\d]{2,4}(?:\.[\d]{1,2})?)\s*(?:CUP|pesos)/i,
  ]) {
    const x = html.match(re); if (x) { const r = parseFloat(x[1]); if (!isNaN(r) && r > 50 && r < 10000) return r; }
  }
  return null;
}

async function fetchFromAPI(token: string): Promise<number | null> {
  const res = await fetch('https://tasas.eltoque.com/v1/trmi', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) return null;
  const d = await res.json();
  if (d?.tasas?.USD?.median) return Number(d.tasas.USD.median);
  if (d?.USD?.median) return Number(d.USD.median);
  if (d?.tasas?.USD?.venta) return Number(d.tasas.USD.venta);
  if (typeof d?.USD === 'number') return d.USD;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const presented = req.headers.get('apikey') ?? '';
  if (!serviceRoleKey || presented !== serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Forbidden: sync-exchange-rate is internal-only' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: configs } = await supabase.from('platform_config').select('key, value').in('key', ['eltoque_api_token', 'exchange_rate_auto_update']);
    const cfg: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => { cfg[c.key] = c.value; });

    const token = cfg['eltoque_api_token'] ?? '';
    if (cfg['exchange_rate_auto_update'] === 'false') {
      return new Response(JSON.stringify({ ok: true, skipped: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let rate: number | null = null;
    let source = '';
    if (token && token.trim() !== '') { rate = await fetchFromAPI(token); if (rate) source = 'eltoque_api'; }
    if (!rate) { rate = await scrapeElToque(); if (rate) source = 'eltoque_scraping'; }
    if (!rate || isNaN(rate) || rate <= 0) {
      return new Response(JSON.stringify({ ok: false, error: 'all_methods_failed' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    await supabase.from('exchange_rates').update({ is_current: false }).eq('is_current', true);
    const { error: insertError } = await supabase.from('exchange_rates').insert({ source, usd_cup_rate: rate, fetched_at: new Date().toISOString(), is_current: true });
    if (insertError) return new Response(JSON.stringify({ ok: false, error: insertError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    return new Response(JSON.stringify({ ok: true, usd_cup_rate: rate, source }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
