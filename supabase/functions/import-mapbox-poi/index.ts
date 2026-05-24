// ============================================================
// import-mapbox-poi — Edge Function (PR 4b of POI parity)
//
// Called fire-and-forget by client/driver/web apps after a user
// SELECTS a search result (typically a Google Places result, since
// Google is the primary search provider — see PR 4).
//
// For each call:
//   1. Looks up the same query against Mapbox SearchBox /forward
//   2. Picks the best match using name similarity + distance vs the
//      original Google result
//   3. Maps Mapbox poi_category → TriciGo tricigo_category
//   4. Calls import_search_poi RPC which dedups against cuba_pois
//      (50 m radius + name similarity ≥ 0.6) and inserts new rows
//      with source='mapbox', confidence=0.8
//
// Why Mapbox and not Google: Google TOS section 3.2.3 forbids
// persistent storage / multi-user display of Google content. Mapbox
// SearchBox TOS explicitly allows it. So Google still drives the
// search dropdown UX (and the "Powered by Google" attribution there
// is mandatory) but Mapbox quietly grows our cuba_pois DB so the
// map can show pins to ALL users without any Google attribution.
//
// Auth: requires Authorization: Bearer <user_jwt>. Anon blocked.
// Rate limit: 30 imports / hour / user (best-effort in-memory).
// Configuration (Supabase secrets):
//   - MAPBOX_ACCESS_TOKEN  (required — already configured for the
//                            basemap; reused here)
// Errors are returned with HTTP 200 + { imported: false, error }
// so the caller never has to handle failures.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { mapboxCategoryToTricigo } from './_shared/mapbox-categories.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAPBOX_SUGGEST_URL = 'https://api.mapbox.com/search/searchbox/v1/forward';
const SCORE_THRESHOLD = 0.55; // min combined score to accept a match
const RATE_LIMIT_PER_HOUR = 30;

interface ProximityPoint {
  lat: number;
  lng: number;
}

interface GoogleHint {
  place_name: string;
  address: string;
  latitude: number;
  longitude: number;
}

interface RequestBody {
  query: string;
  proximity?: ProximityPoint;
  google_result?: GoogleHint;
}

interface ResponseBody {
  imported: boolean;
  mapbox_found: boolean;
  poi_id?: number | null;
  reason?: string;
}

// ── Best-effort rate-limit (in-memory; per-instance) ──
const rateBucket = new Map<string, { count: number; resetAt: number }>();

function rateLimitHit(userId: string): boolean {
  const now = Date.now();
  const entry = rateBucket.get(userId);
  if (!entry || entry.resetAt < now) {
    rateBucket.set(userId, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_PER_HOUR;
}

// ── Mapbox SearchBox call (forward search) ──
interface MapboxFeature {
  type: string;
  geometry?: { coordinates: [number, number] };
  properties?: {
    name?: string;
    full_address?: string;
    place_formatted?: string;
    mapbox_id?: string;
    poi_category?: string[];
    poi_category_ids?: string[];
    metadata?: { phone?: string; website?: string };
  };
}

async function queryMapbox(
  query: string,
  proximity: ProximityPoint | undefined,
  token: string,
): Promise<MapboxFeature[]> {
  const params = new URLSearchParams({
    q: query,
    country: 'cu',
    language: 'es',
    limit: '5',
    access_token: token,
    types: 'poi,address',
  });
  if (proximity) {
    params.set('proximity', `${proximity.lng},${proximity.lat}`);
  }
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${MAPBOX_SUGGEST_URL}?${params.toString()}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const features = data?.features;
    return Array.isArray(features) ? features as MapboxFeature[] : [];
  } catch (err) {
    console.warn('[import-mapbox-poi] mapbox call failed:', err);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ── Scoring ──
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalizeName(a).split(' ').filter((t) => t.length > 1));
  const tb = new Set(normalizeName(b).split(' ').filter((t) => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  ta.forEach((t) => { if (tb.has(t)) hits++; });
  return hits / Math.max(ta.size, tb.size);
}

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sa = Math.sin(dLat / 2) ** 2
           + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat))
           * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(sa));
}

interface ScoredMatch {
  feature: MapboxFeature;
  score: number;
}

function pickBestMatch(
  features: MapboxFeature[],
  query: string,
  hint: GoogleHint | undefined,
): ScoredMatch | null {
  if (features.length === 0) return null;
  const scored: ScoredMatch[] = features.map((f) => {
    const name = f.properties?.name ?? '';
    const coords = f.geometry?.coordinates ?? [0, 0];
    const fLat = coords[1];
    const fLng = coords[0];

    // 70% name similarity (vs hint.place_name if available, else query)
    const nameRef = hint?.place_name ?? query;
    const nameScore = tokenOverlap(name, nameRef);

    // 30% distance score (1 at 0m → 0 at 500m+)
    let distScore = 0.5;
    if (hint) {
      const meters = haversineMeters(
        { lat: hint.latitude, lng: hint.longitude },
        { lat: fLat, lng: fLng },
      );
      distScore = Math.max(0, 1 - meters / 500);
    }

    const combined = 0.7 * nameScore + 0.3 * distScore;
    return { feature: f, score: combined };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  return top.score >= SCORE_THRESHOLD ? top : null;
}

// ── Main handler ──
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'method' }, 405);
  }

  // ── Auth ──
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'unauthenticated' }, 401);
  }

  // ── Parse ──
  let body: RequestBody;
  try {
    body = await req.json() as RequestBody;
  } catch {
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'bad_json' }, 400);
  }
  const query = (body.query ?? '').trim();
  if (query.length < 2) {
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'query_too_short' }, 200);
  }

  // ── Env ──
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const mapboxToken = Deno.env.get('MAPBOX_ACCESS_TOKEN');
  if (!supabaseUrl || !supabaseServiceRole) {
    console.error('[import-mapbox-poi] Missing SUPABASE_URL or SERVICE_ROLE');
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'service_misconfigured' }, 503);
  }
  if (!mapboxToken) {
    // Soft-degrade: deployment without Mapbox token still returns OK
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'mapbox_not_configured' }, 200);
  }

  // ── Resolve user id for rate limiting ──
  const supabase = createClient(supabaseUrl, supabaseServiceRole, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });

  let userId = 'anonymous';
  try {
    const jwt = authHeader.slice('Bearer '.length).trim();
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) {
      return jsonResponse({ imported: false, mapbox_found: false, reason: 'invalid_jwt' }, 401);
    }
    userId = data.user.id;
  } catch (err) {
    console.warn('[import-mapbox-poi] auth.getUser failed:', err);
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'auth_failure' }, 401);
  }

  if (rateLimitHit(userId)) {
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'rate_limit' }, 200);
  }

  // ── Mapbox lookup ──
  const features = await queryMapbox(query, body.proximity, mapboxToken);
  if (features.length === 0) {
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'no_mapbox_results' }, 200);
  }

  const match = pickBestMatch(features, query, body.google_result);
  if (!match) {
    return jsonResponse({ imported: false, mapbox_found: true, reason: 'no_good_match' }, 200);
  }

  const feat = match.feature;
  const coords = feat.geometry?.coordinates ?? [0, 0];
  const lng = coords[0];
  const lat = coords[1];
  const name = feat.properties?.name ?? '';
  const address = feat.properties?.full_address
              ?? feat.properties?.place_formatted
              ?? null;
  const mapboxId = feat.properties?.mapbox_id ?? null;
  const phone = feat.properties?.metadata?.phone ?? null;
  const website = feat.properties?.metadata?.website ?? null;
  const tricigoCat = mapboxCategoryToTricigo(
    feat.properties?.poi_category ?? feat.properties?.poi_category_ids,
  );

  if (!name || !lat || !lng) {
    return jsonResponse({ imported: false, mapbox_found: true, reason: 'incomplete_feature' }, 200);
  }

  // ── Call RPC ──
  try {
    const { data: rpcData, error: rpcErr } = await supabase.rpc('import_search_poi', {
      p_name: name,
      p_lat: lat,
      p_lng: lng,
      p_address: address,
      p_tricigo_category: tricigoCat,
      p_mapbox_id: mapboxId,
      p_phone: phone,
      p_website: website,
    });
    if (rpcErr) {
      console.error('[import-mapbox-poi] RPC error:', rpcErr);
      return jsonResponse({
        imported: false,
        mapbox_found: true,
        reason: 'rpc_error',
      }, 200);
    }
    const result = rpcData as { imported: boolean; poi_id: number | null; reason: string };
    return jsonResponse({
      imported: result.imported,
      mapbox_found: true,
      poi_id: result.poi_id,
      reason: result.reason,
    }, 200);
  } catch (err) {
    console.error('[import-mapbox-poi] RPC threw:', err);
    return jsonResponse({
      imported: false,
      mapbox_found: true,
      reason: 'rpc_threw',
    }, 200);
  }
});

function jsonResponse(body: ResponseBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
