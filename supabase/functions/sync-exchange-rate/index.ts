// ============================================================
// TriciGo — Sync Exchange Rate Edge Function
// Fetches the current USD/CUP rate from ElToque and stores it
// in the exchange_rates table.
//
// Strategy (in order):
//   1. ElToque official API (if token configured)
//   2. Scraping eltoque.com (__NEXT_DATA__ JSON)
//   3. Keep last known rate (no update)
//
// Designed to be called via cron (pg_cron) or manually.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

// ── Scraping helper ─────────────────────────────────────────
// Fetches eltoque.com, extracts __NEXT_DATA__ JSON, and reads
// the informal-market median USD/CUP rate.
// Path: __NEXT_DATA__.props.pageProps.money.data.api.statistics.USD.median
// ─────────────────────────────────────────────────────────────
async function scrapeElToque(): Promise<number | null> {
  const res = await fetch('https://eltoque.com', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es,en;q=0.9',
    },
  });

  if (!res.ok) {
    console.error(`Scrape: eltoque.com returned ${res.status}`);
    return null;
  }

  const html = await res.text();

  // ── Strategy 1: Parse __NEXT_DATA__ JSON ──────────────────
  const nextDataMatch = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );

  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const statistics = data?.props?.pageProps?.money?.data?.api?.statistics;

      if (statistics?.USD?.median) {
        const rate = Number(statistics.USD.median);
        if (!isNaN(rate) && rate > 0) {
          console.log(`Scrape (__NEXT_DATA__): 1 USD = ${rate} CUP`);
          return rate;
        }
      }

      // Fallback: try other keys in statistics
      if (statistics?.USD?.avg) {
        const rate = Number(statistics.USD.avg);
        if (!isNaN(rate) && rate > 0) {
          console.log(`Scrape (__NEXT_DATA__ avg): 1 USD = ${rate} CUP`);
          return rate;
        }
      }
    } catch (e) {
      console.error('Scrape: failed to parse __NEXT_DATA__ JSON:', e);
    }
  }

  // ── Strategy 2: Regex fallback on raw HTML ────────────────
  // Look for patterns like "1 USD ... 513 ... CUP" in the page text
  const patterns = [
    /1\s*USD[^0-9]{0,50}([\d]{2,4}(?:\.[\d]{1,2})?)\s*CUP/i,
    /USD[^0-9]{0,30}([\d]{2,4}(?:\.[\d]{1,2})?)\s*(?:CUP|pesos)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const rate = parseFloat(match[1]);
      if (!isNaN(rate) && rate > 50 && rate < 2000) {
        console.log(`Scrape (regex): 1 USD = ${rate} CUP`);
        return rate;
      }
    }
  }

  console.error('Scrape: could not extract USD/CUP rate from eltoque.com');
  return null;
}

// ── Fetch from official ElToque API ─────────────────────────
async function fetchFromAPI(token: string): Promise<number | null> {
  const eltoqueRes = await fetch('https://tasas.eltoque.com/v1/trmi', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!eltoqueRes.ok) {
    const body = await eltoqueRes.text();
    console.error(`ElToque API error: ${eltoqueRes.status} - ${body}`);
    return null;
  }

  const eltoqueData = await eltoqueRes.json();

  // Try different response shapes the API may return
  if (eltoqueData?.tasas?.USD?.median) {
    return Number(eltoqueData.tasas.USD.median);
  } else if (eltoqueData?.USD?.median) {
    return Number(eltoqueData.USD.median);
  } else if (eltoqueData?.tasas?.USD?.venta) {
    return Number(eltoqueData.tasas.USD.venta);
  } else if (typeof eltoqueData?.USD === 'number') {
    return eltoqueData.USD;
  }

  console.error(
    'API: could not parse USD/CUP rate from response:',
    JSON.stringify(eltoqueData),
  );
  return null;
}

// ── Retry helper ────────────────────────────────────────────
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 2,
): Promise<T | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`Attempt ${attempt}/${maxAttempts} failed:`, err);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
  }
  return null;
}

// ── Main handler ────────────────────────────────────────────
Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Read config
    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', ['eltoque_api_token', 'exchange_rate_auto_update']);

    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => {
      configMap[c.key] = c.value;
    });

    const token = configMap['eltoque_api_token'] ?? '';
    const autoUpdate = configMap['exchange_rate_auto_update'] ?? 'true';

    if (autoUpdate === 'false') {
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: 'auto_update_disabled' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 2. Try to get the rate: API first, then scraping
    let usdCupRate: number | null = null;
    let source = '';

    // 2a. Try official API if token exists (with retry)
    if (token && token.trim() !== '') {
      console.log('Attempting ElToque API...');
      usdCupRate = await withRetry(() => fetchFromAPI(token));
      if (usdCupRate) source = 'eltoque_api';
    }

    // 2b. Fallback to scraping (with retry)
    if (!usdCupRate) {
      console.log('Falling back to scraping eltoque.com...');
      usdCupRate = await withRetry(() => scrapeElToque());
      if (usdCupRate) source = 'eltoque_scraping';
    }

    // 2c. No rate obtained — don't update, keep last known
    if (!usdCupRate || !isFinite(usdCupRate) || usdCupRate <= 0) {
      console.error('All methods failed to obtain USD/CUP rate');
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'all_methods_failed',
          detail: 'Neither API nor scraping returned a valid rate',
        }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 3. Check for large rate swings vs previous rate
    const { data: prevRate } = await supabase
      .from('exchange_rates')
      .select('usd_cup_rate')
      .eq('is_current', true)
      .single();

    if (prevRate?.usd_cup_rate) {
      const change = Math.abs(usdCupRate - prevRate.usd_cup_rate) / prevRate.usd_cup_rate;
      if (change > 0.3) {
        console.warn(
          `⚠️ Large rate swing detected: ${prevRate.usd_cup_rate} → ${usdCupRate} (${(change * 100).toFixed(1)}% change)`,
        );
      }
    }

    // 4. Atomically unset old rate and insert new one using a DB function (RPC)
    //    to prevent race condition where no rate is current between operations
    const { error: insertError } = await supabase.rpc('upsert_exchange_rate', {
      p_source: source,
      p_usd_cup_rate: usdCupRate,
      p_fetched_at: new Date().toISOString(),
    });

    // Fallback: if RPC doesn't exist yet, use sequential operations
    if (insertError?.message?.includes('function') && insertError?.message?.includes('does not exist')) {
      console.warn('upsert_exchange_rate RPC not found, using sequential fallback');
      await supabase
        .from('exchange_rates')
        .update({ is_current: false })
        .eq('is_current', true);

      const { error: fallbackError } = await supabase
        .from('exchange_rates')
        .insert({
          source,
          usd_cup_rate: usdCupRate,
          fetched_at: new Date().toISOString(),
          is_current: true,
        });

      if (fallbackError) {
        // Re-set last rate as current to avoid having no current rate
        if (prevRate) {
          await supabase
            .from('exchange_rates')
            .update({ is_current: true })
            .eq('id', prevRate.id);
        }
        throw fallbackError;
      }
    } else if (insertError) {
      // RPC exists but failed
      throw insertError;
    }
    // Error was already handled above (thrown or logged)

    console.log(`Exchange rate synced: 1 USD = ${usdCupRate} CUP (source: ${source})`);

    // Update fallback rate in platform_config so it stays current
    const { error: fallbackUpdateError } = await supabase
      .from('platform_config')
      .update({ value: String(usdCupRate) })
      .eq('key', 'exchange_rate_fallback_cup');

    if (fallbackUpdateError) {
      console.warn('Failed to update exchange_rate_fallback_cup:', fallbackUpdateError.message);
    } else {
      console.log(`Fallback rate updated to ${usdCupRate} CUP`);
    }

    return new Response(
      JSON.stringify({ ok: true, usd_cup_rate: usdCupRate, source }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Unexpected error in sync-exchange-rate:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
