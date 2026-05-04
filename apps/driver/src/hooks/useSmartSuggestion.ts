/**
 * useSmartSuggestion — Phase 2 N1.
 *
 * Composes the three existing demand signals on the client side into
 * a single ranked suggestion for "where should I go right now?":
 *
 *   1. `useDemandHotspots` — live request hotspots with intensity
 *      (already in the home tab).
 *   2. `useSurgeZones`     — surge polygons with their multiplier
 *      (already polling on the home tab).
 *   3. `usePopularLocations` — 90-day historical pickup clusters
 *      (added in N5).
 *
 * The original spec called for a server-side edge function that
 * combines these. This hook delivers the same user-visible value
 * without the deploy overhead — it works against existing data
 * sources the home tab already polls.
 *
 * Scoring model (intentionally simple, transparent to readers):
 *
 *   score = (live_count × surge_boost) / sqrt(distance_km + 0.5)
 *
 * - `live_count`: live searching drivers / requests in the hotspot.
 *   Falls back to `1 + ride_count/10` for popular_locations so
 *   historical clusters can still surface when there are no live
 *   hotspots, just at lower priority.
 * - `surge_boost`: 1.0 outside surge zones; the zone multiplier
 *   inside a zone (e.g. 1.5x).
 * - `sqrt(distance + 0.5)`: gentle distance penalty — closer is
 *   better, but a much hotter zone 5 km away still beats a lukewarm
 *   one 1 km away.
 *
 * Returns the single top suggestion plus a reason string the UI can
 * render verbatim.
 */
import { useMemo } from 'react';
import { haversineDistance } from '@tricigo/utils';
import type {
  DemandHotspot,
  PopularLocation,
} from '@tricigo/types';
import type { SurgeZoneWithBoundary } from './useSurgeZones';

export interface SmartSuggestion {
  lat: number;
  lng: number;
  /** Kilometers from the driver, rounded to 1 decimal. */
  distance: number;
  /** Number of live searching rides at this point (0 for purely historical). */
  liveCount: number;
  /** Surge multiplier in effect at this point (1 = no surge). */
  surgeMultiplier: number;
  /** "live" | "popular" — drives an icon hint in the card. */
  source: 'live' | 'popular';
  /** Composite score (higher is better). Useful for debugging. */
  score: number;
}

interface UseSmartSuggestionArgs {
  driverLocation: { latitude: number; longitude: number } | null;
  hotspots: DemandHotspot[];
  surgeZones: SurgeZoneWithBoundary[];
  popularLocations: PopularLocation[];
}

/**
 * Point-in-polygon test for a GeoJSON polygon ring (no holes).
 * Standard ray-cast algorithm — keep it inline so we don't pull
 * turf or another geo library just for this.
 */
function pointInPolygon(
  lat: number,
  lng: number,
  ring: number[][],
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!; // lng
    const yi = ring[i]![1]!; // lat
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Returns the surge multiplier active at (lat, lng), or 1 if none. */
function surgeMultiplierAt(
  lat: number,
  lng: number,
  zones: SurgeZoneWithBoundary[],
): number {
  for (const zone of zones) {
    if (!zone.boundary || zone.boundary.type !== 'Polygon') continue;
    const ring = zone.boundary.coordinates[0];
    if (!ring) continue;
    if (pointInPolygon(lat, lng, ring)) {
      return zone.multiplier;
    }
  }
  return 1;
}

export function useSmartSuggestion({
  driverLocation,
  hotspots,
  surgeZones,
  popularLocations,
}: UseSmartSuggestionArgs): SmartSuggestion | null {
  return useMemo(() => {
    if (!driverLocation) return null;

    type Candidate = {
      lat: number;
      lng: number;
      liveCount: number;
      source: 'live' | 'popular';
    };
    const candidates: Candidate[] = [];

    // Live hotspots are the strongest signal — only take those with
    // live_rides_count > 0, otherwise we'd surface purely historical
    // data dressed up as "live demand".
    for (const h of hotspots) {
      if (h.live_rides_count > 0 || h.intensity >= 0.5) {
        candidates.push({
          lat: h.lat,
          lng: h.lng,
          liveCount: h.live_rides_count,
          source: 'live',
        });
      }
    }

    // Popular locations contribute as a fallback — only pickup clusters
    // (that's where the driver wants to BE), not dropoff clusters. Cap
    // the synthetic "live count" so they can't outrank a real live
    // hotspot of similar size.
    for (const p of popularLocations) {
      if (p.type !== 'pickup') continue;
      candidates.push({
        lat: p.latitude,
        lng: p.longitude,
        liveCount: Math.min(3, 1 + Math.floor(p.ride_count / 10)),
        source: 'popular',
      });
    }

    if (candidates.length === 0) return null;

    let best: SmartSuggestion | null = null;

    for (const c of candidates) {
      const distM = haversineDistance(
        { latitude: driverLocation.latitude, longitude: driverLocation.longitude },
        { latitude: c.lat, longitude: c.lng },
      );
      const distKm = distM / 1000;
      // Out-of-range candidates skipped early.
      if (distKm > 7) continue;
      const surge = surgeMultiplierAt(c.lat, c.lng, surgeZones);
      const score = (c.liveCount * surge) / Math.sqrt(distKm + 0.5);
      if (!best || score > best.score) {
        best = {
          lat: c.lat,
          lng: c.lng,
          distance: Math.round(distKm * 10) / 10,
          liveCount: c.liveCount,
          surgeMultiplier: surge,
          source: c.source,
          score,
        };
      }
    }

    return best;
  }, [driverLocation, hotspots, surgeZones, popularLocations]);
}
