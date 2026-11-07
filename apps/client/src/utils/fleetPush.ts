/**
 * Fleet changes (00676, _fleet_push) reach the passenger app as a push with
 * data.type 'fleet_update': the fleet was approved, rejected or suspended, a
 * driver was linked or left. They send no category, so send-push leaves
 * data.type alone. The inbox keeps the row as `system`, which is why both the
 * tap on the push and the tap in the inbox decide by data.type.
 */
export const FLEET_UPDATE_ROUTE = '/profile/fleet';

/** Where a tapped push goes when it is a fleet update; null for any other push. */
export function fleetUpdateRoute(data: unknown): string | null {
  return (data as { type?: unknown } | null | undefined)?.type === 'fleet_update' ? FLEET_UPDATE_ROUTE : null;
}
