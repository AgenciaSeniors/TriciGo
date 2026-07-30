// BUG-160 + BUG-201 + BUG-199: apikey === env.SUPABASE_SERVICE_ROLE_KEY
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { getFreshFx } from '../_shared/fx-freshness.ts';
import { configFlag, resolveFxSyncFailure, resolveSoftLimitHours } from '../_shared/fx-sync-outcome.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// elToque's trmi endpoint is rate-limited to ONE REQUEST PER SECOND PER SOURCE IP.
// Verified against production on 2026-07-29: five simultaneous calls every one came
// back as
//     HTTP 429   <title>429 Too Many Requests</title> ... <p>1 per 1 second</p>
// (Flask-Limiter's default rejection page), while the same call issued on its own
// returned 200 with the rate. Two consequences produced the 20-hour freeze that day:
//
//   1. The old ladder backed off 500ms, then 2000ms. 500ms is BELOW the published
//      limit, so attempt 2 was GUARANTEED to be rejected -- the "retry" spent the very
//      budget it was contending for instead of buying a second chance.
//   2. Supabase Edge Functions egress from a SHARED pool of datacenter IPs, so that
//      1 req/s budget is shared with every other tenant calling the same popular Cuban
//      rate endpoint. Our own traffic (<=3 requests/hour) cannot exhaust a per-second
//      budget by itself, so a rejection is normally caused by traffic we do not
//      control -- and trying harder *within the same second* cannot fix it.
//
// Hence: FEWER attempts, spaced ABOVE the limit. Retrying is now a cheap hedge against
// a single unlucky collision, not the main defence. What actually decorrelates the
// misses is spreading the *runs* over time -- mig 00523 moves cron 23 from hourly to
// every 15 minutes, so one unlucky moment costs 15 minutes instead of a whole hour.
//
// ---------------------------------------------------------------------------------
// REVISED 2026-07-30, against 24 production runs (6h of the every-15-minutes schedule):
//
//     6 x 200 (25%)  -- five of them [200] on the first attempt, one [429, 200]
//    18 x 502 (75%)  -- every single one [429, 429] + scraper 403
//
// The 1.5s retry recovered exactly ONE of 18 failures (5.6%). If the rejection were the
// momentary 1-req/s collision modelled above, waiting 1.5s -- comfortably past a 1 second
// window -- should clear it almost every time. It does not. Whatever blocks us stays
// blocked for considerably longer than a second, so a 1.5s retry is close to worthless:
// it spends a request and 1.5s of the run's budget to buy ~6%.
//
// Two changes follow from that, and BOTH are hypotheses this code now measures rather
// than assumes (jitter_ms and the attempt spacing ride along in the response body, which
// pg_net persists, so `SELECT content FROM net._http_response` settles it with data):
//
//   1. SPACING widened well past the point where a retry demonstrably does nothing.
//   2. JITTER before the first attempt. pg_cron fires job 23 at :00 of the minute, and
//      the response lands 30-200ms later -- every other cron-driven consumer of this
//      popular Cuban endpoint is doing the same thing at the same instant. A random
//      offset moves us out of that thundering herd. Cheap, and it cannot make things
//      worse; whether it makes them better is what jitter_ms is there to tell us.
//
// HARD CEILING: cron_http_post passes timeout_milliseconds := 30000 (its default). Past
// that, pg_net records status_code NULL and the response body is LOST -- taking with it
// the api_attempts diagnostics that make this function debuggable at all, and tripping
// the watchdog's timeout branch. Every wait below is therefore fenced by a wall-clock
// deadline rather than trusted to add up.
const RATE_LIMIT_SPACING_MS = 5_000;
const API_ATTEMPTS = 3;
const JITTER_MAX_MS = 2_500;
const API_TIMEOUT_MS = 6_000;
/** Wall-clock ceiling for the whole API phase, leaving room for the scraper + overhead. */
const API_PHASE_BUDGET_MS = 17_000;
const SCRAPE_TIMEOUT_MS = 5_000;

// What each attempt actually returned. Surfaced in the response body (see below) so the
// reason for a failure is queryable from SQL forever after.
type AttemptOutcome = number | 'network_error' | 'unparseable';

async function scrapeElToque(): Promise<{ rate: number | null; status: AttemptOutcome }> {
  // eltoque.com has been behind a Cloudflare managed challenge since 2026-07-28 05:00
  // (403 "Just a moment..."), which is what removed the safety net under the API. Kept
  // wired up because the challenge may lift, but it is NOT a working fallback today --
  // treat the trmi API as the only live source when reasoning about resilience.
  // Timeout added 2026-07-29: this fetch had none, so a hanging eltoque.com could stall
  // the whole sync until the platform wall-clock killed it.
  let res: Response;
  try {
    res = await fetch('https://eltoque.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html', 'Accept-Language': 'es,en;q=0.9',
      },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[sync-exchange-rate] eltoque.com scrape fetch failed: ${err}`);
    return { rate: null, status: 'network_error' };
  }
  if (!res.ok) {
    console.error(`[sync-exchange-rate] eltoque.com scrape HTTP ${res.status}`);
    return { rate: null, status: res.status };
  }
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      const stats = data?.props?.pageProps?.money?.data?.api?.statistics;
      if (stats?.USD?.median) { const r = Number(stats.USD.median); if (!isNaN(r) && r > 0) return { rate: r, status: res.status }; }
      if (stats?.USD?.avg)    { const r = Number(stats.USD.avg);    if (!isNaN(r) && r > 0) return { rate: r, status: res.status }; }
    } catch {}
  }
  for (const re of [
    /1\s*USD[^0-9]{0,50}([\d]{2,4}(?:\.[\d]{1,2})?)\s*CUP/i,
    /USD[^0-9]{0,30}([\d]{2,4}(?:\.[\d]{1,2})?)\s*(?:CUP|pesos)/i,
  ]) {
    const x = html.match(re); if (x) { const r = parseFloat(x[1]); if (!isNaN(r) && r > 50 && r < 10000) return { rate: r, status: res.status }; }
  }
  console.error('[sync-exchange-rate] eltoque.com returned 200 but no USD rate could be extracted');
  return { rate: null, status: 'unparseable' };
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

async function fetchFromAPI(token: string, log: AttemptOutcome[]): Promise<number | null> {
  let res: Response;
  try {
    res = await fetch('https://tasas.eltoque.com/v1/trmi', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error / timeout. Distinct from a non-2xx so the retry loop can log it.
    log.push('network_error');
    console.error(`[sync-exchange-rate] trmi API fetch failed: ${err}`);
    return null;
  }
  if (!res.ok) {
    log.push(res.status);
    console.error(`[sync-exchange-rate] trmi API HTTP ${res.status}`);
    return null;
  }
  const d = await res.json().catch(() => null);
  const rate = pickRate(d?.tasas?.USD) ?? pickRate(d?.USD);
  if (rate === null) {
    log.push('unparseable');
    console.error(`[sync-exchange-rate] trmi API 200 but USD unparseable; keys=${JSON.stringify(Object.keys(d?.tasas ?? d ?? {}))}`);
    return null;
  }
  log.push(res.status);
  return rate;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Flask-Limiter also sends Retry-After on its 429s, but we deliberately do not read it:
// the published limit is 1 second while the observed block outlasts several, so the
// header can only ever ask us to wait LESS than the spacing above. Honouring it would
// make the ladder worse, not better.
//
// The loop stops early rather than overrun `deadline`: an attempt is only started if a
// full API_TIMEOUT_MS still fits, and a wait is only taken if the attempt it buys fits
// too. Better to return one attempt short with the diagnostics intact than to be killed
// by pg_net at 30s and record nothing at all.
async function fetchFromAPIWithRetry(
  token: string,
  log: AttemptOutcome[],
  deadline: number,
): Promise<number | null> {
  for (let i = 0; i < API_ATTEMPTS; i++) {
    if (Date.now() + API_TIMEOUT_MS > deadline) {
      console.warn(`[sync-exchange-rate] budget exhausted before attempt ${i + 1}/${API_ATTEMPTS}`);
      break;
    }
    const rate = await fetchFromAPI(token, log);
    if (rate !== null) {
      if (i > 0) console.log(`[sync-exchange-rate] trmi API recovered on attempt ${i + 1}/${API_ATTEMPTS}`);
      return rate;
    }
    const isLast = i === API_ATTEMPTS - 1;
    if (isLast) break;
    if (Date.now() + RATE_LIMIT_SPACING_MS + API_TIMEOUT_MS > deadline) {
      console.warn(`[sync-exchange-rate] no budget left to retry after attempt ${i + 1}`);
      break;
    }
    console.warn(`[sync-exchange-rate] trmi attempt ${i + 1}/${API_ATTEMPTS} failed (${log[log.length - 1]}); retrying in ${RATE_LIMIT_SPACING_MS}ms`);
    await sleep(RATE_LIMIT_SPACING_MS);
  }
  console.error(`[sync-exchange-rate] trmi API failed all attempts: ${JSON.stringify(log)}`);
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

  const apiAttempts: AttemptOutcome[] = [];
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: configs, error: configError } = await supabase.from('platform_config').select('key, value').in('key', ['eltoque_api_token', 'exchange_rate_auto_update', 'fx_stale_alert_hours']);
    const cfg: Record<string, unknown> = {};
    (configs ?? []).forEach((c: { key: string; value: unknown }) => { cfg[c.key] = c.value; });

    const token = String(cfg['eltoque_api_token'] ?? '');
    // configFlag, not `=== 'false'`: platform_config.value is jsonb and this key is a
    // jsonb BOOLEAN in production, so the old string comparison could never match and the
    // FX kill switch was inoperative. See fx-sync-outcome.ts.
    if (!configFlag(cfg['exchange_rate_auto_update'], true)) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Step off the :00 boundary that every cron in the world shares. Taken before the
    // first attempt so the whole ladder shifts, and reported below so its effect is
    // measurable instead of assumed.
    const jitterMs = Math.floor(Math.random() * JITTER_MAX_MS);
    if (jitterMs > 0) await sleep(jitterMs);
    const apiDeadline = Date.now() + API_PHASE_BUDGET_MS;

    let rate: number | null = null;
    let source = '';
    // The config read used to discard its error. On a failure `token` came back empty,
    // the API branch was skipped entirely, and the run died in the (dead) scraper with a
    // bare all_methods_failed -- indistinguishable from an upstream rejection. Name the
    // two config-side reasons explicitly so they can never masquerade as an elToque
    // outage again.
    const tokenPresent = token.trim() !== '';
    if (tokenPresent) { rate = await fetchFromAPIWithRetry(token, apiAttempts, apiDeadline); if (rate) source = 'eltoque_api'; }

    let scrapeStatus: AttemptOutcome | 'skipped' = 'skipped';
    if (!rate) { const s = await scrapeElToque(); scrapeStatus = s.status; rate = s.rate; if (rate) source = 'eltoque_scraping'; }
    if (!rate || isNaN(rate) || rate <= 0) {
      // This branch used to return silently. pg_cron cannot see it either -- job 23 runs
      // SELECT net.http_post(...), which only ENQUEUES and returns a request_id, so
      // cron.job_run_details logged 91 consecutive 'succeeded' runs while every one of
      // them 502'd. With no log line there was nothing to grep or alert on, and the rate
      // sat frozen for 4 days. Make the failure loud.
      //
      // Loud was still not ENOUGH: on 2026-07-29 the body said only 'all_methods_failed',
      // and pinning the cause down took an hour of black-box probing because Edge console
      // logs are not reachable from SQL or the MCP. The per-attempt status codes now ride
      // along in the body, which pg_net persists in net._http_response.content -- so
      //   SELECT c.jobname, r.status_code, r.content
      //   FROM cron_http_calls c JOIN net._http_response r ON r.id = c.request_id
      // answers "why did the sync fail?" directly. 429 => rate limited (expected, retry
      // next run); 403 => Cloudflare challenge; config_* => our own misconfiguration.
      const reason = !tokenPresent
        ? (configError ? 'config_read_failed' : 'config_token_missing')
        : 'all_methods_failed';

      // Is this an incident, or just a run that did not land? The rate we already hold
      // decides. See fx-sync-outcome.ts for why this is a status-code decision and not a
      // cron_http_expectations row.
      const fx = await getFreshFx(supabase);
      const hasCurrentRate = fx.reason !== 'no_rate' && fx.reason !== 'error';
      const rateAgeHours = fx.ageHours ?? null;
      const softLimitHours = resolveSoftLimitHours(cfg['fx_stale_alert_hours'], fx.maxAgeHours);
      const { httpStatus, degraded } = resolveFxSyncFailure({
        reason, hasCurrentRate, rateAgeHours, softLimitHours,
      });

      const body = {
        ok: degraded,
        // `degraded` runs did not refresh anything; say so rather than let ok:true imply
        // a rate was written.
        refreshed: false,
        error: reason,
        api_attempts: apiAttempts,
        scrape_status: scrapeStatus,
        config_error: configError?.message ?? null,
        jitter_ms: jitterMs,
        attempt_spacing_ms: RATE_LIMIT_SPACING_MS,
        rate_age_h: rateAgeHours === null ? null : Math.round(rateAgeHours * 100) / 100,
        soft_limit_h: softLimitHours,
      };

      if (degraded) {
        // Deliberately not console.error: this is the expected outcome of an upstream
        // rate-limit while the stored rate is fine, and it happens ~75% of runs today.
        console.warn(`[sync-exchange-rate] not refreshed (${reason}) but rate is ${body.rate_age_h}h old (< ${softLimitHours}h) -- reporting healthy: api=${JSON.stringify(apiAttempts)} scrape=${scrapeStatus}`);
      } else {
        console.error(`[sync-exchange-rate] ${reason}: api=${JSON.stringify(apiAttempts)} scrape=${scrapeStatus} rate_age=${body.rate_age_h}h limit=${softLimitHours}h`);
      }
      return new Response(JSON.stringify(body), { status: httpStatus, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // CRON-02: sanity-bound the fetched rate before writing it as is_current. The
    // NETOPIA recharge path credits round(amount_usd * rate), and the 24h
    // staleness check does NOT catch a wrong but FRESH value — so a malformed-but-
    // positive reading from eltoque (inverted, wrong magnitude, parse glitch) would
    // mis-credit wallets. Cuban informal USD→CUP sits in the low hundreds (~675
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

    // jitter_ms rides along on success too -- comparing its distribution across 200s and
    // 502s is what will confirm or kill the thundering-herd hypothesis.
    return new Response(JSON.stringify({ ok: true, refreshed: true, usd_cup_rate: rate, source, api_attempts: apiAttempts, jitter_ms: jitterMs }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err), api_attempts: apiAttempts }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
