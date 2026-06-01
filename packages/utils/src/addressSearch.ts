// ============================================================
// TriciGo — Shared address-search ranking + presentation logic
//
// Single source of truth for the behaviour that the four search
// components (rider mobile, rider web, driver, guest onboarding) used
// to each reimplement inline, which let them drift apart. Pure
// functions only — no React, no platform APIs — so every surface can
// import the same dedup/scoring/label/debounce behaviour.
//
// Dedup itself lives in ./geo (`dedupeSearchResults`); this module adds
// the ranking + label + constants layer on top.
// ============================================================

import { haversineDistance, computeSpecificity, type SearchBoxResult } from './geo';
import { stripAccents } from './fuzzyMatch';

/** Unified typeahead debounce. Replaces the old per-app 200/250/350/500 ms spread. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Minimal structural shape needed to rank a search result. */
export interface ScorableResult {
  place_name: string;
  latitude: number;
  longitude: number;
  source?: SearchBoxResult['source'] | string;
  specificity?: number;
}

interface GeoPointLike {
  latitude: number;
  longitude: number;
}

/**
 * How many results to surface. Wider for multi-word queries (the user
 * has expressed specific intent and we don't want to truncate the match
 * they're after) and tighter for short queries to cut noise.
 */
export function searchResultCap(query: string): number {
  const words = query.trim().split(/\s+/).filter(Boolean);
  return words.length >= 3 ? 8 : 6;
}

/**
 * Present a Cuban street label "alias first, official in parens".
 * Mirrors the backend `_street_full_display` helper so any raw
 * "Official (Alias)" string that leaks through to the client gets the
 * same treatment the RPC already applies:
 *   "Padre Varela (Belascoaín)" → "Belascoaín (Padre Varela)"
 *   "Calle 23"                  → "Calle 23"
 */
export function normalizeAddressLabel(s: string | null | undefined): string {
  if (!s) return '';
  const m = s.match(/^(.+)\s+\(([^)]+)\)\s*$/);
  if (m && m[1] && m[2]) return `${m[2].trim()} (${m[1].trim()})`;
  return s;
}

/**
 * Distance → coarse proximity bucket, matching the backend
 * search_streets ranking (≤25 km / ≤100 km / ≤300 km / farther).
 * Used as the DOMINANT sort key so a far-province result can never
 * outrank a nearby one on text match alone.
 */
export function proximityBucket(distanceM: number): number {
  if (distanceM <= 25_000) return 0;
  if (distanceM <= 100_000) return 1;
  if (distanceM <= 300_000) return 2;
  return 3;
}

/**
 * Multi-factor relevance score (tie-breaker WITHIN a proximity bucket).
 * Distance carries more weight here than the legacy web formula
 * (0.20 → 0.25) so that, among equally-close results, the nearer one
 * still gets a nudge.
 */
export function scoreSearchResult(
  result: ScorableResult,
  query: string,
  proximity?: GeoPointLike | null,
  frequentZones?: ReadonlyArray<GeoPointLike>,
): number {
  const q = stripAccents(query.toLowerCase().trim());
  const name = stripAccents((result.place_name ?? '').toLowerCase().trim());

  // Text match quality
  let textScore = 0.2;
  if (q.length > 0) {
    if (name === q) textScore = 1.0;
    else if (name.startsWith(q)) textScore = 0.85;
    else if (name.includes(q)) textScore = 0.65;
    else {
      const words = q.split(/\s+/).filter(Boolean);
      const hits = words.filter((w) => name.includes(w)).length;
      textScore = words.length ? 0.2 + (hits / words.length) * 0.4 : 0.2;
    }
  }

  // Specificity — named POIs beat generic categories
  const specScore = result.specificity ?? computeSpecificity(result.place_name ?? '');

  // Distance — closer is better, normalized over a 20 km metro range
  let distScore = 0.5;
  if (proximity) {
    const dist = haversineDistance(
      { latitude: result.latitude, longitude: result.longitude },
      proximity,
    );
    distScore = Math.max(0, 1 - dist / 20_000);
  }

  // Source tier — external providers (Google/Mapbox) above local cuba_pois,
  // preserving the deliberate "Google first" ordering chosen after the
  // airport bug, but only as a tie-break inside a proximity bucket.
  const sourceScore =
    result.source === 'google' || result.source === 'searchbox' || result.source === 'mapbox'
      ? 1.0
      : result.source === 'supabase'
        ? 0.4
        : 0.3;

  // History prior — a small nudge when the result sits in a zone the rider
  // visits often (within ~600 m of a frequent destination). Kept small so it
  // can't override a clearly better text match; rankSearchResults applies it
  // only as an in-bucket tie-break.
  let frequentBonus = 0;
  if (frequentZones && frequentZones.length > 0) {
    for (const zone of frequentZones) {
      if (haversineDistance({ latitude: result.latitude, longitude: result.longitude }, zone) <= 600) {
        frequentBonus = 0.1;
        break;
      }
    }
  }

  return textScore * 0.35 + specScore * 0.25 + distScore * 0.25 + sourceScore * 0.15 + frequentBonus;
}

/**
 * Stable ranking: proximity bucket dominates, then the multi-factor
 * score, then original order. Non-mutating. Within a single city every
 * result shares bucket 0, so the score decides as before — the bucket
 * only kicks in to push far-province results below nearby ones.
 */
export function rankSearchResults<T extends ScorableResult>(
  results: ReadonlyArray<T>,
  query: string,
  proximity?: GeoPointLike | null,
  frequentZones?: ReadonlyArray<GeoPointLike>,
): T[] {
  return results
    .map((r, i) => ({
      r,
      i,
      bucket: proximity
        ? proximityBucket(
            haversineDistance({ latitude: r.latitude, longitude: r.longitude }, proximity),
          )
        : 0,
      score: scoreSearchResult(r, query, proximity, frequentZones),
    }))
    .sort((a, b) => a.bucket - b.bucket || b.score - a.score || a.i - b.i)
    .map((x) => x.r);
}
