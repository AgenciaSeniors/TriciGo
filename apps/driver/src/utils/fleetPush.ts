/**
 * Fleet changes (00676, _fleet_push) reach the driver as a push with data.type
 * 'fleet_update': a number already linked to a fleet, leaving, being removed.
 * They send no category, so send-push leaves data.type alone. The inbox keeps
 * the row as `system`, which is why both the tap on the push and the tap in the
 * inbox decide by data.type.
 */
export const FLEET_UPDATE_ROUTE = '/profile/corporate';

/** Where a tapped push goes when it is a fleet update; null for any other push. */
export function fleetUpdateRoute(data: unknown): string | null {
  return (data as { type?: unknown } | null | undefined)?.type === 'fleet_update' ? FLEET_UPDATE_ROUTE : null;
}
