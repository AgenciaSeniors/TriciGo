/**
 * The active part of the ride FSM, in order. Support can move a ride forward from the panel
 * (00660); the trip poll applies a status from the server only when it is further along than the
 * one on screen, so an answer that left before the driver's own tap cannot move the screen back.
 */
const ACTIVE_ORDER = ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination'];

export function isStatusAhead(server: string | null | undefined, local: string | null | undefined): boolean {
  const s = ACTIVE_ORDER.indexOf(server ?? '');
  const l = ACTIVE_ORDER.indexOf(local ?? '');
  return s >= 0 && l >= 0 && s > l;
}
