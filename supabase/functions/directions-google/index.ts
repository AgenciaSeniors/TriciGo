// ============================================================
// directions-google — Edge Function (controlled experiment)
//
// Proxies the Google Directions API to (optionally) provide route geometry
// for the rider/driver maps, as an experiment vs Mapbox. Provides:
//   - 30-day Postgres cache (cuts cost on repeated routes)
//   - Daily budget cap (Directions is pay-per-use; over cap → Mapbox)
//   - platform_config flag `routing_google_enabled` (default OFF)
//   - Google API key hidden server-side
//
// verify_jwt = false (routing is not PII; the gateway still requires the
// anon/publishable key, and the daily cap is the budget guard). Defaults OFF
// so nothing happens until an admin sets routing_google_enabled=true AND the
// GOOGLE_DIRECTIONS_API_KEY secret is configured.
//
// Wired by: packages/utils/src/geo.ts → fetchGoogleRoute()
// Fallback: returns { fallback: 'mapbox', reason } and the caller uses Mapbox.
//
// Configuration (Supabase secrets):
//   - GOOGLE_DIRECTIONS_API_KEY  (optional — falls back to GOOGLE_PLACES_API_KEY,
//     so just enabling the Directions API on the Places GCP project + adding it
//     to that key's API restrictions is enough; no new secret required)
// platform_config:
//   - routing_google_enabled   ('true' to turn the experiment on)
//   - routing_google_daily_cap (default 2000)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { decodePolyline } from './_shared/polyline.ts';

const DEFAULT_DAILY_CAP = 2000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface LatLng { latitude: number; longitude: number }

interface RequestBody {
  origin: LatLng;
  destination: LatLng;
  waypoints?: LatLng[];
  mode?: 'driving' | 'walking' | 'bicycling';
}

interface ResponseBody {
  coordinates?: [number, number][];
  distance_m?: number;
  duration_s?: number;
  source?: 'google' | 'cache';
  fallback?: 'mapbox';
  reason?: 'disabled' | 'budget_cap' | 'api_not_configured' | 'google_error' | 'bad_request';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ fallback: 'mapbox', reason: 'bad_request' }, 405);
  }

  let body: RequestBody;
  try {
    body = await req.json() as RequestBody;
  } catch {
    return jsonResponse({ fallback: 'mapbox', reason: 'bad_request' }, 400);
  }
  const origin = body.origin;
  const destination = body.destination;
  if (!isLatLng(origin) || !isLatLng(destination)) {
    return jsonResponse({ fallback: 'mapbox', reason: 'bad_request' }, 400);
  }
  const waypoints = Array.isArray(body.waypoints) ? body.waypoints.filter(isLatLng) : [];
  const mode = body.mode === 'walking' || body.mode === 'bicycling' ? body.mode : 'driving';

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  // Reuse the existing Places key by default — same GCP project, just enable
  // the Directions API on it + add it to the key's API restrictions (no new
  // Supabase secret needed). Set GOOGLE_DIRECTIONS_API_KEY only if you want a
  // dedicated key (e.g. for separate billing tracking).
  const googleApiKey = Deno.env.get('GOOGLE_DIRECTIONS_API_KEY') ?? Deno.env.get('GOOGLE_PLACES_API_KEY');

  if (!supabaseUrl || !supabaseServiceRole) {
    return jsonResponse({ fallback: 'mapbox', reason: 'google_error' }, 503);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRole, {
    auth: { persistSession: false },
  });

  // ── Flag + cap config (platform_config) ──
  let enabled = false;
  let cap = DEFAULT_DAILY_CAP;
  try {
    const { data: cfg } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', ['routing_google_enabled', 'routing_google_daily_cap']);
    const config: Record<string, string> = {};
    (cfg ?? []).forEach((row: { key: string; value: string }) => {
      try { config[row.key] = JSON.parse(row.value); } catch { config[row.key] = row.value; }
    });
    enabled = config['routing_google_enabled'] === 'true' || (config['routing_google_enabled'] as unknown) === true;
    const parsedCap = parseInt(config['routing_google_daily_cap'] ?? '', 10);
    if (!Number.isNaN(parsedCap) && parsedCap > 0) cap = parsedCap;
  } catch (e) {
    console.warn('[directions-google] config read failed:', e);
  }

  if (!enabled) {
    return jsonResponse({ fallback: 'mapbox', reason: 'disabled' }, 200);
  }
  if (!googleApiKey) {
    return jsonResponse({ fallback: 'mapbox', reason: 'api_not_configured' }, 200);
  }

  // ── Cache key (coords rounded to 4 decimals ≈ 11 m) ──
  const r = (n: number) => n.toFixed(4);
  const summary = [origin, ...waypoints, destination].map((p) => `${r(p.latitude)},${r(p.longitude)}`).join(' -> ') + ` [${mode}]`;
  const hash = await sha256(summary);

  // ── Cache check ──
  try {
    const { data: cached, error: cacheErr } = await supabase.rpc('google_dir_cache_get', { p_route_hash: hash });
    if (!cacheErr && cached && typeof cached === 'object') {
      const c = cached as { coordinates?: [number, number][]; distance_m?: number; duration_s?: number };
      if (Array.isArray(c.coordinates) && c.coordinates.length > 1) {
        return jsonResponse({ ...c, source: 'cache' }, 200);
      }
    }
  } catch (e) {
    console.warn('[directions-google] cache_get failed:', e);
  }

  // ── Budget cap check ──
  try {
    const { data: dailyCount, error: capErr } = await supabase.rpc('google_dir_cache_daily_count');
    if (!capErr && typeof dailyCount === 'number' && dailyCount >= cap) {
      console.warn(`[directions-google] daily cap reached: ${dailyCount}/${cap} → fallback`);
      return jsonResponse({ fallback: 'mapbox', reason: 'budget_cap' }, 200);
    }
  } catch (e) {
    console.warn('[directions-google] daily_count check failed:', e);
  }

  // ── Call Google Directions ──
  let normalized: { coordinates: [number, number][]; distance_m: number; duration_s: number };
  try {
    const params = new URLSearchParams({
      origin: `${origin.latitude},${origin.longitude}`,
      destination: `${destination.latitude},${destination.longitude}`,
      mode,
      key: googleApiKey,
    });
    if (waypoints.length > 0) {
      // stopover waypoints in the rider's visit order (NO optimize → keeps the
      // agreed stop order, consistent with the fare).
      params.set('waypoints', waypoints.map((w) => `${w.latitude},${w.longitude}`).join('|'));
    }
    const url = `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.status !== 'OK' || !Array.isArray(data?.routes) || data.routes.length === 0) {
      console.warn('[directions-google] google status:', data?.status, data?.error_message ?? '');
      return jsonResponse({ fallback: 'mapbox', reason: 'google_error' }, 200);
    }
    const route = data.routes[0];
    const coordinates = decodePolyline(route?.overview_polyline?.points ?? '');
    if (coordinates.length < 2) throw new Error('empty geometry');
    const legs: Array<{ distance?: { value?: number }; duration?: { value?: number } }> = route.legs ?? [];
    const distance_m = Math.round(legs.reduce((s, l) => s + (l.distance?.value ?? 0), 0));
    const duration_s = Math.round(legs.reduce((s, l) => s + (l.duration?.value ?? 0), 0));
    normalized = { coordinates, distance_m, duration_s };
  } catch (e) {
    console.error('[directions-google] Google API call failed:', e);
    return jsonResponse({ fallback: 'mapbox', reason: 'google_error' }, 200);
  }

  // ── Cache + increment counter ──
  try {
    await Promise.all([
      supabase.rpc('google_dir_cache_increment_call'),
      supabase.rpc('google_dir_cache_put', {
        p_route_hash: hash,
        p_request_summary: summary,
        p_response_json: normalized,
      }),
    ]);
  } catch (e) {
    console.warn('[directions-google] cache_put / increment failed:', e);
  }

  if (Math.random() < 0.01) {
    // Fire-and-forget cache GC. Uses .then(onOk, onErr), NOT .catch: supabase.rpc()
    // returns a PostgrestFilterBuilder, which is a *thenable* but not a Promise —
    // it has .then and NO .catch, so `.catch(...)` throws
    //   TypeError: supabase.rpc(...).catch is not a function
    // This line sits outside every try/catch in the handler, so that TypeError
    // would reject the Deno.serve handler and return 500 instead of the route —
    // on 1% of requests, looking exactly like a Google Directions outage.
    // Same defect that caused the new-user signup 500 in verify-otp (#622); see
    // the warning comment at verify-otp/index.ts:216.
    supabase.rpc('google_dir_cache_cleanup').then(
      () => {},
      (e: unknown) => console.warn('[directions-google] cache cleanup failed (non-fatal):', e),
    );
  }

  return jsonResponse({ ...normalized, source: 'google' }, 200);
});

function isLatLng(p: unknown): p is LatLng {
  return !!p && typeof (p as LatLng).latitude === 'number' && typeof (p as LatLng).longitude === 'number';
}

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(body: ResponseBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
