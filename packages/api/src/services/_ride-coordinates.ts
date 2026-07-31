import type { Ride } from '@tricigo/types';

/**
 * Transform raw Supabase ride data to proper GeoPoint coordinates.
 * PostGIS returns pickup_location/dropoff_location as WKB hex strings,
 * but the Ride type expects { latitude, longitude } GeoPoint objects.
 * We use the auto-synced pickup_lat/lng and dropoff_lat/lng columns instead.
 *
 * Shared by driver.service (active trip, history) and ride.service
 * (pending offers). Anything that hands a raw `rides` row to the UI must
 * run it through here first — a caller that forgets leaves every consumer
 * of `.pickup_location.latitude` reading `undefined`, which fails silently.
 */
export function transformRideCoordinates(ride: Record<string, unknown>): Ride {
  return {
    ...(ride as unknown as Ride),
    pickup_location: { latitude: (ride.pickup_lat as number) ?? 0, longitude: (ride.pickup_lng as number) ?? 0 },
    dropoff_location: { latitude: (ride.dropoff_lat as number) ?? 0, longitude: (ride.dropoff_lng as number) ?? 0 },
  };
}
