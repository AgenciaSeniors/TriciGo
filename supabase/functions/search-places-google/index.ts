// ============================================================
// search-places-google — Edge Function (PR 4 of POI parity)
//
// Proxies Google Places Autocomplete (New) API on behalf of authenticated
// users. Provides:
//   - 30-day Postgres cache (TOS-compliant, hit-rate target 60%+)
//   - Daily budget cap ($500/mo target; soft-degrade to Mapbox when hit)
//   - API key hidden server-side (never exposed to clients)
//
// Auth: requires Authorization: Bearer <user_jwt>. Anon users blocked.
// Wired by: packages/utils/src/geo.ts → searchAddressGoogle()
// Fallback path: caller falls back to Mapbox SearchBox if this returns
//   { fallback: 'mapbox' } or HTTP 5xx.
//
// Configuration (Supabase secrets):
//   - GOOGLE_PLACES_API_KEY  (required — see docs/SETUP_GOOGLE_PLACES.md)
//   - GOOGLE_DAILY_CAP       (optional, default 1000)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { computeCacheKey, googlePlacesAutocomplete, type SearchBoxResult } from './_shared/google.ts';

const DEFAULT_DAILY_CAP = 1000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface RequestBody {
  query: string;
  proximity?: { latitude: number; longitude: number };
  limit?: number;
  /**
   * Opaque token (UUID-ish) generated client-side at the start of a
   * typeahead session. When present, the EF forwards it to Google's
   * Autocomplete AND Place Details endpoints so the full session bills
   * as one "Autocomplete - Per Session" SKU instead of N per-request
   * calls + 1 Place Details. Caller is responsible for reusing the same
   * token across every keystroke until the user selects or aborts; on
   * select/abort the caller MUST generate a new token for the next session.
   */
  session_token?: string;
}

interface ResponseBody {
  data: SearchBoxResult[];
  source: 'google' | 'cache';
  cached?: boolean;
  fallback?: 'mapbox';
  reason?: 'budget_cap' | 'api_not_configured' | 'google_error';
  cap_remaining?: number;
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ data: [], source: 'google', reason: 'google_error' }, 405);
  }

  // ── Auth check ──
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ data: [], source: 'google', reason: 'google_error' }, 401);
  }

  // ── Parse + validate ──
  let body: RequestBody;
  try {
    body = await req.json() as RequestBody;
  } catch {
    return jsonResponse({ data: [], source: 'google', reason: 'google_error' }, 400);
  }
  const query = (body.query ?? '').trim();
  if (query.length < 2) {
    return jsonResponse({ data: [], source: 'google' }, 200);
  }
  const proximity = body.proximity ?? null;
  const limit = Math.min(Math.max(body.limit ?? 10, 1), 20);
  // Session token is passed through opaque — we don't validate the shape,
  // just forward it. Empty string is treated as absent so a buggy caller
  // can't break the request.
  const sessionToken = (body.session_token ?? '').trim() || undefined;

  // ── Setup ──
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const googleApiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');

  if (!supabaseUrl || !supabaseServiceRole) {
    console.error('[search-places-google] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return jsonResponse({ data: [], source: 'google', reason: 'google_error' }, 503);
  }

  // If Google not configured → graceful fallback (deployment without key still works)
  if (!googleApiKey) {
    return jsonResponse({
      data: [],
      source: 'google',
      fallback: 'mapbox',
      reason: 'api_not_configured',
    }, 200);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRole, {
    auth: { persistSession: false },
  });

  // ── Cache check ──
  const { hash, proximityKey } = await computeCacheKey(query, proximity);
  try {
    const { data: cached, error: cacheErr } = await supabase.rpc('google_cache_get', {
      p_query_hash: hash,
    });
    if (!cacheErr && cached) {
      // PR I (2026-05-25): log cache hits with count so we can detect a
      // cache serving an empty/stale response that's hiding a real venue.
      // Previously this branch was silent — a cached "[]" for "hotel
      // boutique malecon 663" would keep returning nothing for 30 days
      // without any signal in the logs.
      const cachedArr = cached as SearchBoxResult[];
      const n = Array.isArray(cachedArr) ? cachedArr.length : 0;
      console.info('[search-places-google] cache_hit query=%s n=%d', query, n);
      return jsonResponse({
        data: cachedArr,
        source: 'cache',
        cached: true,
      }, 200);
    }
  } catch (e) {
    // Cache miss or RPC error — fall through to live call
    console.warn('[search-places-google] cache_get failed:', e);
  }

  // ── Budget cap check ──
  try {
    const { data: dailyCount, error: capErr } = await supabase.rpc('google_cache_daily_count');
    const cap = parseInt(Deno.env.get('GOOGLE_DAILY_CAP') ?? String(DEFAULT_DAILY_CAP), 10);
    if (!capErr && typeof dailyCount === 'number' && dailyCount >= cap) {
      console.warn(`[search-places-google] daily cap reached: ${dailyCount}/${cap} → fallback`);
      return jsonResponse({
        data: [],
        source: 'google',
        fallback: 'mapbox',
        reason: 'budget_cap',
        cap_remaining: 0,
      }, 200);
    }
  } catch (e) {
    console.warn('[search-places-google] daily_count check failed:', e);
    // Don't block on counter errors — fail open (call Google anyway)
  }

  // ── Call Google ──
  let results: SearchBoxResult[];
  try {
    results = await googlePlacesAutocomplete(
      query,
      { apiKey: googleApiKey },
      proximity ?? undefined,
      limit,
      sessionToken,
    );
  } catch (e) {
    console.error('[search-places-google] Google API call failed:', e);
    return jsonResponse({
      data: [],
      source: 'google',
      fallback: 'mapbox',
      reason: 'google_error',
    }, 200);
  }

  // ── Cache it + increment counter ──
  // PR I (2026-05-25): SKIP cache_put when results.length === 0.
  // The 30-day TTL on an empty response sticks the failure for a month
  // even after the missing venue gets indexed by Google the next day.
  // We still increment the daily call counter so budget cap stays
  // accurate, but the next caller will re-hit Google (~1 extra call/day
  // per missing query — acceptable tradeoff vs sticky-empty bug).
  console.info(
    '[search-places-google] live_call query=%s n=%d cache=%s session=%s',
    query, results.length, results.length === 0 ? 'skipped_empty' : 'will_cache',
    sessionToken ? 'present' : 'absent',
  );
  try {
    const ops: Promise<unknown>[] = [supabase.rpc('google_cache_increment_call')];
    if (results.length > 0) {
      ops.push(supabase.rpc('google_cache_put', {
        p_query_hash: hash,
        p_query: query,
        p_proximity_key: proximityKey,
        p_response_json: results,
      }));
    }
    await Promise.all(ops);
  } catch (e) {
    console.warn('[search-places-google] cache_put / increment failed:', e);
    // Non-fatal — return the results to the user anyway
  }

  // ── Lazy cleanup: 1% chance to trigger >30d row deletion ──
  if (Math.random() < 0.01) {
    supabase.rpc('google_cache_cleanup').catch(() => { /* best effort */ });
  }

  return jsonResponse({ data: results, source: 'google' }, 200);
});

function jsonResponse(body: ResponseBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
