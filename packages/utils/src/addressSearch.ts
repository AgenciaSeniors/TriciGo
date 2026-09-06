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

import { haversineDistance, computeSpecificity, tricigoCategoryEmoji, isGenericStreetAddress, type SearchBoxResult } from './geo';
import { stripAccents, fuzzyMatch } from './fuzzyMatch';
import { CUBA_PROVINCES, CUBA_MUNICIPALITIES } from './cuba-geo';

/** Unified typeahead debounce. Replaces the old per-app 200/250/350/500 ms spread. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Minimal structural shape needed to rank a search result. */
export interface ScorableResult {
  place_name: string;
  latitude: number;
  longitude: number;
  source?: SearchBoxResult['source'] | string;
  specificity?: number;
  /** Provider category (Google `types[0]` / Mapbox feature type) — lets the
   *  score sink zone-level rows. Optional: history rows don't carry it. */
  matchedCategory?: string | null;
  category?: string;
  address?: string;
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
 * Whether a search-result row may be coordinate-enriched with the nearest
 * Cuban cross-streets. ONLY pure street rows qualify: enrichment snaps the
 * row to its exact intersection point — desirable for a street, but WRONG
 * for a POI, where it would discard the POI's real coordinates AND its name
 * (Bug 1b). A POI always carries a `displayName`; its `.address` is the
 * street line and frequently begins with "Calle …", so the street-prefix
 * heuristic alone misclassifies it — the `displayName` check is the reliable
 * POI signal.
 */
/**
 * Words that appear in almost every Cuban address and therefore carry no
 * discriminating power when the rider is typing. Deliberately includes the
 * street prefixes (mirroring `STREET_PREFIXES` in ./geo), the "e/ … y …"
 * connectors, and the country/capital that most stored addresses end with.
 */
const GENERIC_ADDRESS_WORDS: ReadonlySet<string> = new Set([
  'calle', 'avenida', 'ave', 'av', 'calzada', 'carretera', 'autopista',
  'paseo', 'callejon', 'pasaje', 'boulevard', 'blvd', 'camino', 'sendero',
  'entre', 'esquina', 'esq', 'edificio', 'edif', 'apto', 'apartamento',
  'la', 'el', 'de', 'del', 'los', 'las', 'y', 'habana', 'cuba',
]);

/**
 * Whether a saved/recent/predicted address should be treated as matching what
 * the rider is typing.
 *
 * NOT the same thing as `fuzzyMatch(query, address)`, which is what this
 * replaced. The mobile dropdown sorts every history row ABOVE every search
 * result and then cuts the list short, so a loose match here does not merely
 * add noise — it evicts the row the rider is actually looking for. And
 * `fuzzyMatch`'s fast path is `target.includes(query)` against the FULL
 * address, which for Cuban addresses means the word "Calle" alone matches
 * nearly everything. Measured against five realistic Havana recents:
 *
 *   "cal"     → 4 of 5 matched, taking 4 of the 5 visible slots
 *   "calle"   → 3 of 5
 *   "calle 2" → 3 of 5
 *
 * The rule: the query has to hit something DISTINCTIVE. Generic words are
 * stripped from it first; if nothing distinctive is left (the rider typed only
 * "cal" / "calle" / "avenida"), the row counts only when the address literally
 * BEGINS with what was typed — "Calzada de Infanta" yes, "Calle 5 e/ Calzada
 * y A" no.
 */
export function historyMatchesQuery(query: string, target: string): boolean {
  const q = stripAccents(query.toLowerCase()).trim();
  const t = stripAccents(target.toLowerCase()).trim();
  if (q.length === 0 || t.length === 0) return false;

  // A token counts as generic when it IS a generic word or is still being
  // typed towards one — the rider types left to right, so "cal" is no more
  // discriminating than "calle". Without the prefix rule "cal" stays
  // "distinctive" and matches every address containing "Calle", which is the
  // exact flood this function exists to stop.
  const isGenericToken = (w: string): boolean => {
    if (GENERIC_ADDRESS_WORDS.has(w)) return true;
    for (const g of GENERIC_ADDRESS_WORDS) if (g.startsWith(w)) return true;
    return false;
  };

  const distinctive = q
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !isGenericToken(w));

  // Nothing but generic words: only a literal leading match counts. Compared
  // on the accent-stripped forms so "Calzada"/"calzada" behave the same.
  if (distinctive.length === 0) return t.startsWith(q);

  // Otherwise every distinctive token must be found, so "calle 23" reaches the
  // Calle 23 recent while "calle" alone reaches none. fuzzyMatch keeps the
  // accent and single-typo tolerance the rider expects.
  return distinctive.every((w) => fuzzyMatch(w, t));
}

export function shouldEnrichResult(r: { displayName?: string | null; address: string }): boolean {
  if (r.displayName) return false;
  return isGenericStreetAddress(r.address);
}

/** Google Places result types that describe a street/address rather than a venue. */
const PROVIDER_STREET_CATEGORIES: ReadonlySet<string> = new Set([
  'route', 'geocode', 'street_address', 'intersection',
]);

/**
 * Whether an external (Google/Mapbox) search result is a STREET rather than a
 * named venue.
 *
 * Why it matters: the mobile dropdown dedupes local `street_intersections`
 * rows AGAINST external rows, so when the two collide the external coordinate
 * used to survive. Measured against prod with 40 common Havana street names
 * through the Google EF: Google returns the WRONG street for 19 of 40 —
 * "Calle 23" → "Calle 230" 13 km away, "Calle G" → "Calle Gertrudis",
 * "Calle 1" → "Calle 100" — and lands the same-named street >300 m off for
 * most of the rest. A local street row is a real surveyed corner, so for
 * street-shaped rows the LOCAL coordinate must win; for named venues Google
 * stays authoritative (the airport-bug ordering, PR F 2026-05-25).
 */
export function isProviderStreetResult(r: {
  source?: SearchBoxResult['source'] | string;
  matchedCategory?: string | null;
  place_name?: string;
  address?: string;
}): boolean {
  const external = r.source === 'google' || r.source === 'searchbox' || r.source === 'mapbox';
  if (!external) return false;
  if (r.matchedCategory && PROVIDER_STREET_CATEGORIES.has(r.matchedCategory)) return true;
  // Address-only rows (no venue name of their own) are street-shaped too.
  return !r.place_name || r.place_name === r.address;
}

/**
 * Radius within which a Google "street" result is considered to be describing
 * the same street the local RPC already answered. Beyond this the Google row
 * is dropped rather than left to compete for the top slot. See
 * `filterProviderStreetsByLocalAnchor` below.
 */
export const LOCAL_STREET_TRUST_RADIUS_M = 3000;

/**
 * Drop external street-shaped results whose coordinate lies far from what the
 * local street DB found. The dedupe by name-overlap (`dedupeSearchResults`)
 * misses the specific mis-shoot Google makes on Cuban streets — it fires the
 * wrong street with a similar-but-not-identical name ("Calle 23" -> "Calle
 * 230", "Calle L" -> "Calle Lindero", "Calle 1" -> "Calle 100"), so token
 * overlap of 0.5 slips under the 0.7 dedupe gate and the far coordinate
 * survives to compete for the top slot on `specificity`.
 *
 * Measured against prod cache — 58 real Cuban street queries from a Vedado
 * rider:
 *   - Google's 1st result inside 3 km:      11/58 (19%)
 *   - Local RPC's 1st result inside 3 km:   30/58 (52%)
 *   - Google beyond 20 km:                  22/58 (38%)
 *   - Local beyond 20 km:                   10/58 (17%)
 *   - Google worse by >2 km:                30 cases
 *   - Local  worse by >2 km:                 4 cases
 *   - Median distance:                Google 7.0 km, Local 2.9 km
 *
 * If the local RPC returned nothing (a genuinely new/unmapped street) the
 * Google row passes through unchanged — it is then the only signal available.
 */
export function filterProviderStreetsByLocalAnchor<T extends {
  latitude: number;
  longitude: number;
}>(
  providerStreets: ReadonlyArray<T>,
  localAnchor: { latitude: number; longitude: number } | null,
): T[] {
  if (!localAnchor || providerStreets.length === 0) return [...providerStreets];
  return providerStreets.filter((r) => {
    const d = haversineDistance(
      { latitude: r.latitude, longitude: r.longitude },
      localAnchor,
    );
    return d <= LOCAL_STREET_TRUST_RADIUS_M;
  });
}

/**
 * Provider categories that describe an AREA (a neighbourhood, a municipality,
 * a province) rather than a place you can be driven to. Google Places
 * `types[0]` on the left of the comment, Mapbox `feature_type` on the right.
 *
 * Measured in prod (90 days, 207 rides): 13 % of dropoffs were a bare zone —
 * "Vedado, La Habana", "Cerro, La Habana". A zone row from Google has a
 * `place_name` ("Vedado") that differs from its `address` ("Vedado, La
 * Habana"), so the dropdown treated it like a named POI and committed the
 * ride at the zone centroid with no pin confirmation.
 */
export const ZONE_LEVEL_CATEGORIES: ReadonlySet<string> = new Set([
  // Google
  'locality', 'sublocality', 'sublocality_level_1', 'sublocality_level_2',
  'sublocality_level_3', 'sublocality_level_4', 'sublocality_level_5',
  'neighborhood', 'political', 'colloquial_area', 'postal_code', 'country',
  'administrative_area_level_1', 'administrative_area_level_2',
  'administrative_area_level_3', 'administrative_area_level_4',
  'administrative_area_level_5', 'administrative_area_level_6',
  'administrative_area_level_7',
  // Mapbox
  'place', 'district', 'region', 'postcode',
]);

/** Havana neighbourhoods riders name as a destination on their own. Only the
 *  ones that are NOT already a municipality in `CUBA_MUNICIPALITIES`. */
const HAVANA_NEIGHBOURHOODS = [
  'vedado', 'nuevo vedado', 'miramar', 'siboney', 'kohly', 'lawton',
  'santos suarez', 'la vibora', 'vibora', 'alamar', 'cojimar', 'santa fe',
  'jaimanitas', 'el cerro', 'luyano', 'casino deportivo', 'reparto flores',
  'buenavista', 'almendares', 'la lisa', 'fontanar', 'mantilla', 'parraga',
];

let zoneNameSet: Set<string> | null = null;
function knownZoneNames(): Set<string> {
  if (zoneNameSet) return zoneNameSet;
  const names = new Set<string>();
  for (const p of CUBA_PROVINCES) names.add(stripAccents(p.label.toLowerCase()));
  for (const list of Object.values(CUBA_MUNICIPALITIES)) {
    for (const m of list) names.add(stripAccents(m.label.toLowerCase()));
  }
  for (const n of HAVANA_NEIGHBOURHOODS) names.add(n);
  zoneNameSet = names;
  return names;
}

/**
 * Whether an EXTERNAL search result is a zone (neighbourhood / municipality /
 * province) rather than a specific place. Zone rows must not be committed as
 * a destination without the rider placing the pin.
 *
 * Only Google / Mapbox rows are eligible: local rows (`search_pois_smart`,
 * `search_streets`) are real points by construction. The category decides
 * whenever the provider gave one; the name-based fallback only runs when both
 * category fields are empty, because a café called "Vedado" is a café.
 */
export function isZoneLevelResult(r: {
  source?: SearchBoxResult['source'] | string;
  matchedCategory?: string | null;
  category?: string;
  place_name?: string;
  address?: string;
}): boolean {
  const external = r.source === 'google' || r.source === 'searchbox' || r.source === 'mapbox';
  if (!external) return false;
  const cat = (r.matchedCategory || r.category || '').toLowerCase();
  if (cat) return ZONE_LEVEL_CATEGORIES.has(cat);
  const name = stripAccents((r.place_name ?? '').toLowerCase().trim());
  if (!name) return false;
  const parts = (r.address ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length > 3) return false;
  if (/\d/.test(r.address ?? '') || /\se\/\s/.test(r.address ?? '')) return false;
  return knownZoneNames().has(name);
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

  // A zone (neighbourhood/municipality) is never what the rider wants to be
  // driven TO; it sorts below every specific row in the same bucket even on
  // an exact name match ("vedado" → "Vedado" scores 1.0 on text alone).
  const zonePenalty = isZoneLevelResult(result) ? 0.35 : 0;

  return textScore * 0.35 + specScore * 0.25 + distScore * 0.25 + sourceScore * 0.15 + frequentBonus - zonePenalty;
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

const GENERIC_PIN = '📍';

// Raw provider/OSM/Foursquare category substring → emoji (first match wins).
// Lets the long-tail of categories that aren't in the 20-word tricigo
// vocabulary still get a meaningful icon. Order specific-before-generic.
const RAW_CATEGORY_EMOJI: ReadonlyArray<readonly [string, string]> = [
  ['post_office', '📮'],
  ['public_transport', '🚌'], ['platform', '🚌'], ['stop_position', '🚌'],
  ['bus', '🚌'], ['transit', '🚌'], ['railway', '🚉'], ['train', '🚉'], ['airport', '✈️'],
  ['landmark', '🏛️'], ['historical', '🏛️'], ['historic', '🏛️'], ['monument', '🏛️'],
  ['government', '🏛️'], ['civic', '🏛️'], ['embassy', '🏛️'], ['courthouse', '🏛️'], ['city_hall', '🏛️'],
  ['accommodation', '🏨'], ['hotel', '🏨'], ['lodging', '🏨'], ['hostel', '🏨'], ['motel', '🏨'],
  ['campground', '🏕️'],
  ['eat_and_drink', '🍽️'], ['restaurant', '🍽️'], ['dining', '🍽️'], ['breakfast', '🍽️'],
  ['snack', '🍽️'], ['fast_food', '🍽️'],
  ['coffee', '☕'], ['cafe', '☕'], ['nightclub', '🍺'], ['pub', '🍺'], ['bar', '🍺'],
  ['hospital', '🏥'], ['clinic', '🏥'], ['doctor', '🏥'], ['pharmacy', '💊'], ['spa', '💆'],
  ['university', '🎓'], ['college', '🎓'], ['school', '🎓'], ['education', '🎓'], ['library', '📚'],
  ['supermarket', '🛒'], ['grocery', '🛒'], ['market', '🛒'],
  ['shopping_mall', '🛍️'], ['retail', '🛍️'], ['store', '🛍️'], ['mall', '🛍️'], ['shop', '🛍️'],
  ['bank', '🏦'], ['atm', '🏧'], ['fuel', '⛽'], ['gas_station', '⛽'],
  ['gallery', '🖼️'], ['museum', '🖼️'], ['theatre', '🎭'], ['theater', '🎭'], ['cinema', '🎬'],
  ['church', '⛪'], ['worship', '⛪'], ['religious', '⛪'], ['mosque', '⛪'], ['temple', '⛪'],
  ['botanical', '🌳'], ['garden', '🌳'], ['plaza', '🌳'], ['square', '🌳'], ['park', '🌳'],
  ['stadium', '🏟️'], ['arena', '🏟️'], ['sports', '🏟️'], ['recreation', '🏟️'],
  ['gym', '🏋️'], ['swimming', '🏊'], ['pool', '🏊'], ['scuba', '🤿'],
  ['zoo', '🦁'], ['beach', '🏖️'], ['river', '🏞️'], ['fountain', '⛲'],
  ['professional', '🏢'], ['office', '🏢'], ['engineering', '🏢'], ['legal', '🏢'], ['b2b', '🏢'],
];

// Spanish venue keywords scanned over the (accent-stripped) name. Catches
// famous places whose stored category is generic, e.g. "Capitolio Nacional".
const NAME_KEYWORD_EMOJI: ReadonlyArray<readonly [string, string]> = [
  ['capitolio', '🏛️'], ['catedral', '⛪'], ['iglesia', '⛪'], ['convento', '⛪'], ['ermita', '⛪'],
  ['museo', '🖼️'], ['teatro', '🎭'], ['cine', '🎬'], ['estadio', '🏟️'],
  ['hospital', '🏥'], ['policlinico', '🏥'], ['clinica', '🏥'], ['farmacia', '💊'],
  ['universidad', '🎓'], ['escuela', '🎓'], ['instituto', '🎓'], ['colegio', '🎓'], ['biblioteca', '📚'],
  ['parque', '🌳'], ['plaza', '🌳'], ['jardin', '🌳'],
  ['restaurante', '🍽️'], ['paladar', '🍲'], ['cafeteria', '☕'],
  ['hotel', '🏨'], ['hostal', '🏨'], ['casa particular', '🏨'],
  ['supermercado', '🛒'], ['mercado', '🛒'], ['tienda', '🛍️'],
  ['gasolinera', '⛽'], ['servicentro', '⛽'], ['cupet', '⛽'],
  ['aeropuerto', '✈️'], ['terminal', '🚉'], ['estacion', '🚉'],
  ['banco', '🏦'], ['cadeca', '🏧'],
  ['playa', '🏖️'], ['malecon', '🏖️'],
  ['embajada', '🏛️'], ['ministerio', '🏛️'],
];

function hasCrossStreet(addr: string): boolean {
  const a = addr.toLowerCase();
  return a.includes(' e/ ') || a.includes(' entre ');
}

/**
 * Resolve a category emoji for ANY search result, so the dropdown never falls
 * back to a bare pin when there's a usable signal. Fallback chain (first wins):
 *   1. the mapped tricigo category (the 20-word vocabulary)
 *   2. an explicit street result → 🛣️, or "X e/ Y" → 🔀
 *   3. the raw provider/OSM category (long tail)
 *   4. a Spanish keyword in the name (rescues "Capitolio Nacional" → 🏛️)
 *   5. a bare "X e/ Y" address with no other signal → 🔀
 *   6. 📍 — only when nothing else matched
 */
export function searchResultEmoji(result: {
  tricigoCategory?: string | null;
  category?: string | null;
  place_name?: string | null;
  address?: string | null;
}): string {
  if (result.tricigoCategory) {
    const e = tricigoCategoryEmoji(result.tricigoCategory);
    if (e !== GENERIC_PIN) return e;
  }

  const addr = result.address ?? '';
  // Local rows say `category: 'street'`. External rows carry Google's own type
  // here (searchAddressUnified maps matchedCategory -> category), and for a
  // street that type is 'route' | 'geocode' | 'street_address' |
  // 'intersection' — none of which mean anything to the tables below, so those
  // rows used to fall through to a bare 📍. Measured: for exactly those four
  // types mapExternalCategoryToTricigo returns null, so the tricigoCategory
  // branch above cannot rescue them either. Reuses the same set as
  // isProviderStreetResult so street-vs-venue is decided identically in both.
  if (result.category === 'street' || PROVIDER_STREET_CATEGORIES.has(result.category ?? '')) {
    return hasCrossStreet(addr) ? '🔀' : '🛣️';
  }

  const raw = stripAccents((result.category ?? '').toLowerCase());
  if (raw && raw !== 'other') {
    for (const [key, emoji] of RAW_CATEGORY_EMOJI) {
      if (raw.includes(key)) return emoji;
    }
  }

  const name = stripAccents(`${result.place_name ?? ''} ${addr}`.toLowerCase());
  for (const [key, emoji] of NAME_KEYWORD_EMOJI) {
    if (name.includes(key)) return emoji;
  }

  // Bare intersection-style address ("X e/ Y") with no POI name, category, or
  // keyword signal → cross-street. Comes LAST so a named POI that merely carries
  // a Cuban "e/" address (e.g. "Teatro … e/ Animas y Neptuno") keeps its own
  // category emoji instead of being mislabeled 🔀.
  if (hasCrossStreet(addr)) return '🔀';

  return GENERIC_PIN;
}
