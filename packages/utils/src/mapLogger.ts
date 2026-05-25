// ============================================================
// mapLogger — categorised debug logger for the map/POI/ride flows
//
// The user (Eduardo, 2026-05-25) wants to run the app with clean
// cache and see EVERY relevant event in Metro logs while doing a
// real test trip: search, viewport changes, POI taps, camera mode
// switches, marker rotation source, GPS fixes, route fetches, and
// ride lifecycle transitions.
//
// Why a wrapper instead of raw console.*?
//   - One filterable prefix (`grep "[MAP:"` shows everything).
//   - Per-category subtags (`grep "[MAP:route]"` narrows further).
//   - Structured event payloads (Metro debugger renders the object
//     expandable; grep'ing the JSON is still trivial).
//   - One gate (`__DEV__ || EXPO_PUBLIC_MAP_VERBOSE`) — turn off in
//     production builds without touching call sites.
//   - Severity routing: events with a non-empty `error` field go
//     through console.warn; the rest are console.log.
//   - Future-proof: easy to fan out to Sentry breadcrumbs / batch
//     upload without touching the ~30 call sites.
//
// Tags are stable strings so log scrapers can rely on them:
//   [MAP:search]     [MAP:viewport]  [MAP:poi]
//   [MAP:poi-submit] [MAP:camera]    [MAP:heading]
//   [MAP:gps]        [MAP:route]     [MAP:ride]
//
// Conventions for event payloads:
//   - Lat/lng are numbers (no rounding here; let the consumer
//     truncate if they care). null is fine when unknown.
//   - Latencies are in milliseconds (`*_ms`).
//   - Distances are in meters (`*_m`).
//   - Time-of-event is omitted — Metro already timestamps each line.
// ============================================================

/* eslint-disable @typescript-eslint/no-explicit-any */

// We don't import React Native's __DEV__ directly here because this
// package is consumed by both RN apps and the web app (Next.js).
// Both inject `__DEV__` as a global in dev builds; in the absence
// of that, fall back to NODE_ENV.
declare const __DEV__: boolean | undefined;

function isVerbose(): boolean {
  // Always emit in dev. In prod, opt-in via env var (set per build
  // profile by the EAS / Vercel config when QA wants verbose logs).
  if (typeof __DEV__ !== 'undefined' && __DEV__) return true;
  try {
    // eslint-disable-next-line no-undef
    const env = (typeof process !== 'undefined' ? process.env : undefined) as
      | Record<string, string | undefined>
      | undefined;
    if (env?.EXPO_PUBLIC_MAP_VERBOSE === '1') return true;
    if (env?.NEXT_PUBLIC_MAP_VERBOSE === '1') return true;
    if (env?.NODE_ENV === 'development') return true;
  } catch {
    /* env access not available; fall through */
  }
  return false;
}

function emit(tag: string, evt: Record<string, unknown> & { error?: unknown }): void {
  // Errors always emit, regardless of verbose gate, so production
  // crashes are still visible. Info-level events respect the gate.
  const isError = evt.error != null;
  if (!isError && !isVerbose()) return;
  if (typeof console === 'undefined') return;
  const channel = isError ? console.warn : console.log;
  channel(`[${tag}]`, evt);
}

// ─── Event types ──────────────────────────────────────────────

export interface SearchEvent {
  /** Free-text query the user typed (trimmed). */
  query: string;
  /** Which provider produced this row / event. */
  provider: 'google' | 'mapbox' | 'cuba_pois' | 'nominatim' | 'unified';
  /** Number of results returned (0 = empty). */
  count: number;
  /** Round-trip time of the underlying RPC / fetch. Optional when not measured. */
  latency_ms?: number;
  /** True when this provider was a fallback (the primary returned nothing). */
  fallback?: boolean;
  /** Stage in the flow: 'fire' = request started, 'resolve' = results in. */
  stage?: 'fire' | 'resolve';
  /** Number of duplicates removed against another provider (dedupeSearchResults). */
  deduped?: number;
  /** Why a row got selected (handleSelectResult / onSelect). */
  selected?: { name: string; lat: number; lng: number; source: string };
  /** Failure detail when something went wrong. */
  error?: string;
}

export interface ViewportEvent {
  /** "minLng,minLat,maxLng,maxLat" rounded to 3 decimals. */
  bbox: string;
  zoom: number;
  /** Number of POIs returned by the RPC (0 when below zoom threshold). */
  count?: number;
  /** What triggered this fetch: initial seed, user pan, zoom change, or skip. */
  source: 'seed' | 'pan' | 'zoom' | 'skipped' | 'clear';
  /** When `source === 'skipped'`, why (e.g. "still_inside_padded", "zoom_below_threshold"). */
  reason?: string;
  /** When the underlying fetch failed. */
  error?: string;
}

export interface PoiTapEvent {
  poi_id: number | string;
  name: string;
  category: string | null;
  lat: number;
  lng: number;
  /** Where the POI came from in cuba_pois. */
  source?: string;
  /** Which app surfaced the tap (helps when grepping across both Metros). */
  app: 'client' | 'driver';
}

export interface PoiSubmitEvent {
  event: 'open' | 'submit' | 'success' | 'reject' | 'cancel';
  name?: string;
  category?: string;
  lat?: number;
  lng?: number;
  /** Which app initiated the submission. */
  app: 'client' | 'driver';
  /** Rejection or error reason from the RPC. */
  reject_reason?: string;
  /** Latency for the submit RPC. */
  latency_ms?: number;
  error?: string;
}

export interface CameraProfileEvent {
  /** Ride status the camera profile is applied for. */
  rideStatus: string | null;
  zoom: number;
  pitch: number;
  bearing: number;
  /** Animation mode for the camera move. */
  mode?: 'flyTo' | 'easeTo' | 'bounds';
  /** Whether Uber-style follow mode is engaged. */
  followMode?: boolean;
  /** Which app emitted (camera profiles differ between client + driver). */
  app: 'client' | 'driver';
  /** When the user touched the map and paused follow, log it once. */
  interruption?: 'user_gesture' | 'resume';
}

export interface MarkerHeadingEvent {
  /** Where the heading value came from. */
  source: 'gps_raw' | 'computed' | 'ema' | 'snap' | 'animated' | 'freeze';
  /** Numeric compass heading (0-360). */
  value: number;
  /** Prior heading; useful to see deltas through the smoothing chain. */
  prev?: number | null;
  /** delta = (value - prev) normalised to [-180, 180]; helpful for QA on sharp turns. */
  delta?: number;
  /** Which app emitted. */
  app: 'client' | 'driver';
  /** Optional speed at the moment of the heading update (km/h or m/s — caller decides). */
  speed?: number;
}

export interface GpsEvent {
  event:
    | 'fix'              // a GPS sample arrived (foreground hook)
    | 'background_fix'   // a sample arrived from the background task
    | 'upload_ok'        // updateDriverPosition RPC succeeded
    | 'upload_fail'      // RPC failed
    | 'heartbeat'        // periodic heartbeat
    | 'permission'       // permission state changed
    | 'db_update'        // client-side: a new fix arrived for the active driver
    | 'heading_freeze';  // speed too low; previous heading retained
  lat?: number;
  lng?: number;
  heading?: number | null;
  accuracy?: number | null;
  /** Speed in m/s as reported by expo-location. */
  speed?: number | null;
  /** Permission status string when event === 'permission'. */
  permission_status?: string;
  /** Whether this update was for an active ride (driver only). */
  has_ride?: boolean;
  /** Which app emitted. */
  app: 'client' | 'driver';
  error?: string;
}

export interface RouteEvent {
  event:
    | 'fetch_start'  // about to hit the routing endpoint
    | 'fetch_ok'     // got a valid route
    | 'cache_hit'    // returned from the in-memory routeCache
    | 'cache_clear'  // clearRouteCache was called
    | 'refetch'      // useLiveDriverRoute decided to refetch (with reason)
    | 'fail';        // both providers failed
  /** Which provider answered (or was attempted). */
  endpoint?: 'mapbox' | 'osrm' | 'cache' | 'unified';
  latency_ms?: number;
  distance_m?: number;
  duration_s?: number;
  /** For 'refetch' events: 'first' | 'deviation' | 'stale-no-cache'. */
  reason?: string;
  /** Driver deviation distance (m) when reason === 'deviation'. */
  off_m?: number;
  /** Time since last fetch in ms. */
  since_last_ms?: number;
  /** From / to coordinates as "lat,lng" strings (privacy-OK, helps reproduce). */
  from?: string;
  to?: string;
  error?: string;
}

export interface TripLifecycleEvent {
  event:
    | 'request'           // rider tapped "Pedir viaje" / booking created
    | 'accept'            // driver accepted
    | 'driver_en_route'   // driver started navigating to pickup
    | 'arrived_pickup'    // driver arrived at pickup point
    | 'started'           // ride started (passenger on board)
    | 'arrived_dropoff'   // driver arrived at destination
    | 'completed'         // payment processed, trip closed
    | 'cancelled';        // any cancellation reason
  ride_id: string;
  lat?: number;
  lng?: number;
  /** Which side of the bus the event came from (driver vs client perception). */
  app: 'client' | 'driver';
  /** Free-text context (e.g. cancellation reason). */
  note?: string;
  error?: string;
}

// ─── Public API ───────────────────────────────────────────────

export const mapLogger = {
  search: (evt: SearchEvent): void => emit('MAP:search', evt as unknown as Record<string, unknown>),
  viewport: (evt: ViewportEvent): void => emit('MAP:viewport', evt as unknown as Record<string, unknown>),
  poiTap: (evt: PoiTapEvent): void => emit('MAP:poi', evt as unknown as Record<string, unknown>),
  poiSubmit: (evt: PoiSubmitEvent): void => emit('MAP:poi-submit', evt as unknown as Record<string, unknown>),
  cameraProfile: (evt: CameraProfileEvent): void => emit('MAP:camera', evt as unknown as Record<string, unknown>),
  markerHeading: (evt: MarkerHeadingEvent): void => emit('MAP:heading', evt as unknown as Record<string, unknown>),
  gps: (evt: GpsEvent): void => emit('MAP:gps', evt as unknown as Record<string, unknown>),
  route: (evt: RouteEvent): void => emit('MAP:route', evt as unknown as Record<string, unknown>),
  tripLifecycle: (evt: TripLifecycleEvent): void => emit('MAP:ride', evt as unknown as Record<string, unknown>),
};

// Bbox helper so call sites don't reinvent it.
export function formatBbox(b: { minLng: number; minLat: number; maxLng: number; maxLat: number }): string {
  return `${b.minLng.toFixed(3)},${b.minLat.toFixed(3)},${b.maxLng.toFixed(3)},${b.maxLat.toFixed(3)}`;
}
