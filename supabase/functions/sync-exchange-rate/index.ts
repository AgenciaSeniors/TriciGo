// BUG-160 + BUG-201 + BUG-199: apikey === env.SUPABASE_SERVICE_ROLE_KEY
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

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

// The trmi endpoint returns USD as a bare number today:
//   {"tasas":{"MLC":429.14,"USD":665.0,...},"date":"2026-07-18",...}
// Older/other tiers nest it as an object ({median,avg,venta}). The previous version of
// this parser only handled the NESTED shape, so it returned null on every call and the
// EF silently fell through to scrapeElToque() -- all 2771 historical rows landed with
// source='eltoque_scraping' and zero with 'eltoque_api'. That masked the breakage until
// eltoque.com started answering 403 to the scraper on 2026-07-15, at which point BOTH
// sources failed and the rate froze. Accept either shape so neither can regress silently.
function pickRate(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (v && typeof v === 'object') {
    for (const k of ['median', 'avg', 'venta', 'value']) {
      const n = Number((v as Record<string, unknown>)[k]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

async function fetchFromAPI(token: string): Promise<number | null> {
  let res: Response;
  try {
    res = await fetch('https://tasas.eltoque.com/v1/trmi', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Network error / timeout. Distinct from a non-2xx so the retry loop can log it.
    console.error(`[sync-exchange-rate] trmi API fetch failed: ${err}`);
    return null;
  }
  if (!res.ok) {
    console.error(`[sync-exchange-rate] trmi API HTTP ${res.status}`);
    return null;
  }
  const d = await res.json().catch(() => null);
  const rate = pickRate(d?.tasas?.USD) ?? pickRate(d?.USD);
  if (rate === null) {
    console.error(`[sync-exchange-rate] trmi API 200 but USD unparseable; keys=${JSON.stringify(Object.keys(d?.tasas ?? d ?? {}))}`);
  }
  return rate;
}

// tasas.eltoque.com sits behind Cloudflare, which intermittently challenges Supabase
// Edge's datacenter egress: observed 2026-07-19 with three identical calls minutes
// apart returning 200, 502(all_methods_failed), 200. A single transient miss used to
// throw away that whole hour's sync, because the scraper fallback is dead (403) and
// there was no retry. A miss is not dangerous on its own — the freshness window is 24h
// and this runs hourly, so it takes 24 consecutive failures to block recharges — but
// retrying is nearly free and keeps the feed from developing holes.
// Bounded on purpose: 3 attempts, ~2s of added worst-case latency.
async function fetchFromAPIWithRetry(token: string, attempts = 3): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    const rate = await fetchFromAPI(token);
    if (rate !== null) {
      if (i > 0) console.log(`[sync-exchange-rate] trmi API recovered on attempt ${i + 1}/${attempts}`);
      return rate;
    }
    if (i < attempts - 1) {
      const backoffMs = 500 * (i + 1) ** 2; // 500ms, 2000ms
      console.warn(`[sync-exchange-rate] trmi attempt ${i + 1}/${attempts} failed; retrying in ${backoffMs}ms`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  console.error(`[sync-exchange-rate] trmi API failed all ${attempts} attempts`);
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
    if (token && token.trim() !== '') { rate = await fetchFromAPIWithRetry(token); if (rate) source = 'eltoque_api'; }
    if (!rate) { rate = await scrapeElToque(); if (rate) source = 'eltoque_scraping'; }
    if (!rate || isNaN(rate) || rate <= 0) {
      // This branch used to return silently. pg_cron cannot see it either -- job 23 runs
      // SELECT net.http_post(...), which only ENQUEUES and returns a request_id, so
      // cron.job_run_details logged 91 consecutive 'succeeded' runs while every one of
      // them 502'd. With no log line there was nothing to grep or alert on, and the rate
      // sat frozen for 4 days. Make the failure loud.
      console.error('[sync-exchange-rate] all_methods_failed: trmi API and eltoque.com scrape both returned null');
      return new Response(JSON.stringify({ ok: false, error: 'all_methods_failed' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // CRON-02: sanity-bound the fetched rate before writing it as is_current. The
    // NETOPIA recharge path credits round(amount_usd * rate), and the 24h
    // staleness check does NOT catch a wrong but FRESH value — so a malformed-but-
    // positive reading from eltoque (inverted, wrong magnitude, parse glitch) would
    // mis-credit wallets. Cuban informal USD→CUP sits in the low hundreds (~660
    // today); reject anything implausible (matches scrapeElToque's own bounds).
    if (rate < 100 || rate > 5000) {
      console.error(`[sync-exchange-rate] rejected out-of-range rate ${rate} from ${source}`);
      return new Response(JSON.stringify({ ok: false, error: 'rate_out_of_sane_range', rate, source }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // CRON-02: atomic upsert (mig 00052) instead of the two-step update-then-insert,
    // which left a brief window with ZERO is_current rows — a concurrent recharge
    // read could find no current rate. upsert_exchange_rate flips old→false and
    // inserts the new current row in a single transaction.
    const { error: upsertError } = await supabase.rpc('upsert_exchange_rate', {
      p_source: source,
      p_usd_cup_rate: rate,
      p_fetched_at: new Date().toISOString(),
    });
    if (upsertError) return new Response(JSON.stringify({ ok: false, error: upsertError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // FX audit Tema A: keep the emergency fallback (exchange_rate_fallback_cup, read
    // only if the is_current row ever disappears) tracking the latest known rate, so a
    // fallback can never silently undervalue ~19% the way the hardcoded 520 would have.
    // Best-effort — a failure here must not fail the sync.
    await supabase.from('platform_config').upsert({ key: 'exchange_rate_fallback_cup', value: rate }, { onConflict: 'key' });

    return new Response(JSON.stringify({ ok: true, usd_cup_rate: rate, source }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
