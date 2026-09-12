// ============================================================
// TriciGo — track-competitor-prices
//
// Quotes the competitor apps (La Nave, Cinco) over the FIXED route basket and
// stores each quote PAIRED with TriciGo's own price for the same route in the
// same cycle. Called only by the pg_cron job (00588) via cron_http_post.
//
// Design notes (see docs/superpowers/specs — competitor price observatory):
//   * verify_jwt=false + apikey === SERVICE_ROLE_KEY (internal-only), the
//     sync-exchange-rate pattern.
//   * Optional { competitor } body param → process just that one. Lets the cron
//     split the basket across two invocations if both don't fit in 30s.
//   * Own price via the parity-tested mirror (tricigo-fare.ts), from the route's
//     FROZEN geometry + live configs/rules/surge/FX.
//   * Status expresses the INVARIANT, not the luck of one request (fx-sync-outcome
//     rule): 200 when we captured at least one row or the competitor is simply
//     unavailable; 502 when the session credential is missing/expired (our own
//     config, doesn't self-heal) or the WHOLE basket failed. Fail-closed.
//   * Adapters never throw; one competitor down doesn't stop the other.
//
// Scope: PRICES ONLY, quotes only — no real ride is ever requested.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { configFlag } from '../_shared/fx-sync-outcome.ts';
import { computeOwnFare } from '../_shared/tricigo-fare.ts';
import type { ServiceTypeConfigRow } from '../_shared/tricigo-fare.ts';
import type { PricingRuleMatch } from '../_shared/fare-calculator.ts';
import { laNaveAdapter } from '../_shared/competitors/la-nave.ts';
import { cincoAdapter } from '../_shared/competitors/cinco.ts';
import type { CompetitorAdapter } from '../_shared/competitors/types.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ADAPTERS: Record<string, CompetitorAdapter> = {
  la_nave: laNaveAdapter,
  cinco: cincoAdapter,
};

// Wall-clock budget for the quoting phase, well under cron_http_post's 30s ceiling.
const PHASE_BUDGET_MS = 24_000;
const CONCURRENCY = 8;
const JITTER_MAX_MS = 2_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

interface RouteRow {
  id: string;
  pickup_lat: number; pickup_lng: number;
  dropoff_lat: number; dropoff_lng: number;
  distance_m: number | null; duration_s: number | null;
}
interface CategoryMapRow { competitor: string; competitor_category: string; tricigo_service_type: string; }

// Bounded-concurrency map with a wall-clock deadline. Tasks not started by the
// deadline are skipped (recorded as not captured), never queued past 30s.
async function runBounded<T>(items: T[], limit: number, deadline: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && Date.now() < deadline) {
      const item = items[i++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const presented = req.headers.get('apikey') ?? '';
  if (!serviceRoleKey || presented !== serviceRoleKey) {
    return json({ error: 'Forbidden: track-competitor-prices is internal-only' }, 401);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Which competitor(s)?
    let onlyCompetitor: string | null = null;
    try {
      const body = await req.json();
      if (body && typeof body.competitor === 'string') onlyCompetitor = body.competitor;
    } catch { /* no body → both */ }
    const competitors = onlyCompetitor ? [onlyCompetitor] : ['la_nave', 'cinco'];

    // Kill switch + cadence.
    const { data: cfgRows } = await supabase
      .from('platform_config').select('key, value')
      .in('key', ['competitor_tracking_enabled', 'competitor_tracking_interval_min']);
    const cfg: Record<string, unknown> = {};
    (cfgRows ?? []).forEach((c: { key: string; value: unknown }) => { cfg[c.key] = c.value; });
    if (!configFlag(cfg['competitor_tracking_enabled'], true)) {
      return json({ ok: true, skipped: true, reason: 'disabled' }, 200);
    }
    // Self-throttle: if the interval was lowered without rescheduling the cron,
    // skip cycles that come too soon after the last capture.
    const intervalMin = Number(cfg['competitor_tracking_interval_min'] ?? 15);
    if (Number.isFinite(intervalMin) && intervalMin > 0) {
      const { data: last } = await supabase
        .from('competitor_quotes').select('captured_at').order('captured_at', { ascending: false }).limit(1);
      const lastAt = last?.[0]?.captured_at ? new Date(last[0].captured_at).getTime() : 0;
      if (lastAt && Date.now() - lastAt < intervalMin * 60_000 * 0.9) {
        return json({ ok: true, skipped: true, reason: 'too_soon' }, 200);
      }
    }

    // Basket (skip routes without frozen geometry — can't price them).
    const { data: routesRaw, error: routesErr } = await supabase
      .from('competitor_routes')
      .select('id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_m, duration_s')
      .eq('is_active', true);
    if (routesErr) return json({ ok: false, error: 'routes_read_failed', detail: routesErr.message }, 502);
    const routes: RouteRow[] = (routesRaw ?? []).filter((r: RouteRow) => r.distance_m != null && r.duration_s != null);
    if (routes.length === 0) return json({ ok: false, error: 'no_priceable_routes' }, 502);

    // Category map.
    const { data: mapRaw } = await supabase
      .from('competitor_category_map').select('competitor, competitor_category, tricigo_service_type').eq('is_active', true);
    const catMap: CategoryMapRow[] = mapRaw ?? [];

    // Live own-price inputs: configs, active rules, weather surge, FX.
    const { data: configsRaw } = await supabase
      .from('service_type_configs').select('slug, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup');
    const configBySlug = new Map<string, ServiceTypeConfigRow>();
    (configsRaw ?? []).forEach((c: ServiceTypeConfigRow) => configBySlug.set(c.slug, c));

    const { data: rulesRaw } = await supabase
      .from('pricing_rules')
      .select('id, service_type, time_window_start, time_window_end, day_of_week, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup')
      .eq('is_active', true);
    const rulesByType = new Map<string, PricingRuleMatch[]>();
    (rulesRaw ?? []).forEach((r: PricingRuleMatch & { service_type: string }) => {
      const list = rulesByType.get(r.service_type) ?? [];
      list.push(r);
      rulesByType.set(r.service_type, list);
    });

    const { data: surgeData } = await supabase.rpc('get_weather_surge');
    const surge = typeof surgeData === 'number' ? surgeData : 1.0;

    const { data: fxRow } = await supabase
      .from('exchange_rates').select('usd_cup_rate').eq('is_current', true).maybeSingle();
    const fx = fxRow?.usd_cup_rate ?? null;

    // Jitter off the :NN boundary, then quote.
    const jitterMs = Math.floor(Math.random() * JITTER_MAX_MS);
    if (jitterMs > 0) await sleep(jitterMs);
    const deadline = Date.now() + PHASE_BUDGET_MS;

    const summary: Record<string, { captured: number; unavailable: number; auth_failed: boolean; errors: number }> = {};
    const rowsToInsert: Record<string, unknown>[] = [];

    for (const competitor of competitors) {
      const adapter = ADAPTERS[competitor];
      summary[competitor] = { captured: 0, unavailable: 0, auth_failed: false, errors: 0 };
      if (!adapter) { summary[competitor].errors++; continue; }

      // Credential for this competitor.
      const { data: sess } = await supabase
        .from('competitor_sessions').select('credential, expires_at').eq('competitor', competitor).maybeSingle();
      const credential = sess?.credential ?? '';
      if (!credential) { summary[competitor].auth_failed = true; continue; }

      // Which category pairs apply to this competitor.
      const pairs = catMap.filter((m) => m.competitor === competitor);

      await runBounded(routes, CONCURRENCY, deadline, async (route) => {
        const result = await adapter.quoteAll(
          { id: route.id, pickup_lat: route.pickup_lat, pickup_lng: route.pickup_lng, dropoff_lat: route.dropoff_lat, dropoff_lng: route.dropoff_lng },
          credential,
        );

        if (!result.ok) {
          if (result.reason === 'auth') summary[competitor].auth_failed = true;
          else if (result.reason === 'not_implemented') summary[competitor].unavailable++;
          else summary[competitor].errors++;
          // Still record a NULL competitor price for each mapped pair, so the
          // series has our own price and a documented "not available".
          for (const pair of pairs) {
            const config = configBySlug.get(pair.tricigo_service_type);
            if (!config) continue;
            rowsToInsert.push({
              route_id: route.id, competitor, competitor_price_cup: null,
              competitor_category: pair.competitor_category,
              tricigo_price_cup: computeOwnFare({ serviceType: pair.tricigo_service_type, distanceM: route.distance_m!, durationS: route.duration_s!, config, rules: rulesByType.get(pair.tricigo_service_type) ?? [], surge }),
              tricigo_service_type: pair.tricigo_service_type,
              exchange_rate_usd_cup: fx, weather_surge: surge,
            });
          }
          return;
        }

        // Success: emit one row per active category pair.
        const priceByCat = new Map<string, number | null>();
        for (const c of result.categories) priceByCat.set(c.category, c.price_cup);
        for (const pair of pairs) {
          const config = configBySlug.get(pair.tricigo_service_type);
          if (!config) continue;
          const competitorPrice = priceByCat.has(pair.competitor_category) ? priceByCat.get(pair.competitor_category)! : null;
          if (competitorPrice != null) summary[competitor].captured++; else summary[competitor].unavailable++;
          rowsToInsert.push({
            route_id: route.id, competitor, competitor_price_cup: competitorPrice,
            competitor_category: pair.competitor_category,
            tricigo_price_cup: computeOwnFare({ serviceType: pair.tricigo_service_type, distanceM: route.distance_m!, durationS: route.duration_s!, config, rules: rulesByType.get(pair.tricigo_service_type) ?? [], surge }),
            tricigo_service_type: pair.tricigo_service_type,
            exchange_rate_usd_cup: fx, weather_surge: surge,
            raw: result.raw ?? null,
          });
        }
      });

      // Update session health from what happened.
      if (summary[competitor].auth_failed) {
        await supabase.from('competitor_sessions').update({ status: 'expired' }).eq('competitor', competitor);
      } else if (summary[competitor].captured > 0) {
        await supabase.from('competitor_sessions').update({ status: 'ok', last_ok_at: new Date().toISOString() }).eq('competitor', competitor);
      }
    }

    if (rowsToInsert.length > 0) {
      const { error: insErr } = await supabase.from('competitor_quotes').insert(rowsToInsert);
      if (insErr) return json({ ok: false, error: 'insert_failed', detail: insErr.message }, 500);
    }

    const totalCaptured = Object.values(summary).reduce((s, c) => s + c.captured, 0);
    const anyAuthFailed = Object.values(summary).some((c) => c.auth_failed);
    const rowsWritten = rowsToInsert.length;

    // Status by invariant. A missing/expired credential is OUR config broken and
    // doesn't self-heal → 502. Nothing written at all → 502. Otherwise 200, even
    // if a competitor is merely unavailable this cycle.
    if (anyAuthFailed && totalCaptured === 0) {
      return json({ ok: false, error: 'session_expired_or_missing', summary, rows_written: rowsWritten, jitter_ms: jitterMs }, 502);
    }
    if (rowsWritten === 0) {
      return json({ ok: false, error: 'nothing_captured', summary, jitter_ms: jitterMs }, 502);
    }
    return json({ ok: true, captured: totalCaptured, rows_written: rowsWritten, summary, jitter_ms: jitterMs }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: 'unhandled', detail: msg }, 500);
  }
});
