const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN || '';

interface RouteETA {
  durationMinutes: number;
  distanceKm: number;
}

let etaCache: { key: string; result: RouteETA; timestamp: number } | null = null;
const CACHE_TTL = 30_000; // 30 seconds

export async function getRouteETA(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
): Promise<RouteETA | null> {
  const cacheKey = `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}-${destination.lat.toFixed(4)},${destination.lng.toFixed(4)}`;

  if (etaCache && etaCache.key === cacheKey && Date.now() - etaCache.timestamp < CACHE_TTL) {
    return etaCache.result;
  }

  try {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?access_token=${MAPBOX_TOKEN}&overview=false`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    if (!data.routes?.[0]) return null;

    const route = data.routes[0];
    const result: RouteETA = {
      durationMinutes: Math.ceil(route.duration / 60),
      distanceKm: Math.round(route.distance / 100) / 10,
    };

    etaCache = { key: cacheKey, result, timestamp: Date.now() };
    return result;
  } catch {
    return null;
  }
}
