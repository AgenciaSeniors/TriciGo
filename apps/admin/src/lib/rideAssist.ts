/**
 * Statuses /rides/[id]/assist can act on: a ride still looking for a driver (00628) or one
 * that already has one (00660). The ride detail and the rides list show "Asistir" only for these.
 */
const ASSISTABLE_RIDE_STATUSES: ReadonlySet<string> = new Set([
  'searching',
  'accepted',
  'driver_en_route',
  'arrived_at_pickup',
  'in_progress',
  'arrived_at_destination',
]);

export function canAssistRide(status: string): boolean {
  return ASSISTABLE_RIDE_STATUSES.has(status);
}

export function rideAssistHref(rideId: string): string {
  return `/rides/${rideId}/assist`;
}
