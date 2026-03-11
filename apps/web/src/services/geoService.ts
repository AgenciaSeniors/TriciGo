// ============================================================
// TriciGo — Geo Service
// OSRM routing + Nominatim reverse geocoding (free, no API key)
// ============================================================

import { formatHavanaAddress } from '@tricigo/utils';

/* ─── Types ─── */

export interface RouteResult {
  /** Array of [lat, lng] pairs for the Leaflet Polyline */
  coordinates: [number, number][];
  /** Route distance in meters */
  distance_m: number;
  /** Route duration in seconds */
  duration_s: number;
}

/* ─── Nominatim throttle ─── */

let lastNominatimCall = 0;
const NOMINATIM_MIN_INTERVAL_MS = 1100; // >1s to respect Nominatim rate limit

async function throttledFetch(url: string, headers?: HeadersInit): Promise<Response> {
  const now = Date.now();
  const wait = NOMINATIM_MIN_INTERVAL_MS - (now - lastNominatimCall);
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastNominatimCall = Date.now();
  return fetch(url, { headers });
}

/* ─── OSRM Routing ─── */

/**
 * Fetch a driving route between two points using the OSRM public API.
 * Returns the route geometry (lat/lng pairs) + distance/duration,
 * or null if the request fails.
 */
export async function fetchRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<RouteResult | null> {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?overview=full&geometries=geojson`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) return null;

    // GeoJSON coordinates are [lng, lat] — Leaflet needs [lat, lng]
    const coordinates: [number, number][] = route.geometry.coordinates.map(
      (c: [number, number]) => [c[1], c[0]] as [number, number],
    );

    return {
      coordinates,
      distance_m: route.distance,
      duration_s: route.duration,
    };
  } catch {
    return null;
  }
}

/* ─── Nominatim Reverse Geocoding ─── */

/**
 * Reverse geocode coordinates to a human-readable address using Nominatim.
 * Formats the result with `formatHavanaAddress()`.
 * Returns null if the request fails.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<string | null> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?lat=${lat}&lon=${lng}&format=json&addressdetails=1&accept-language=es`;

    const res = await throttledFetch(url, {
      'User-Agent': 'TriciGo/1.0 (https://tricigo.com)',
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (!data?.address) return null;

    const formatted = formatHavanaAddress(data.address);
    return formatted || null;
  } catch {
    return null;
  }
}
