// Ride ownership helpers for the admin "waiting rides" banner (spec 2026-11-07).

export type AssistOwnership = 'mine' | 'other' | 'none';

/** Who owns an assisted ride, from the viewer's point of view. */
export function assistOwnership(
  ownerId: string | null | undefined,
  viewerId: string | null | undefined,
): AssistOwnership {
  if (!ownerId) return 'none';
  return ownerId === viewerId ? 'mine' : 'other';
}

/**
 * The viewer's own rides first; everything else keeps its original order (the server
 * already puts rides asking for help first). Returns a new array.
 */
export function sortWaitingForViewer<T extends { owner_id: string | null; help_requested_at: string | null }>(
  rides: T[],
  viewerId: string | null,
): T[] {
  const mine: T[] = [];
  const rest: T[] = [];
  for (const ride of rides) {
    if (viewerId !== null && ride.owner_id === viewerId) mine.push(ride);
    else rest.push(ride);
  }
  return [...mine, ...rest];
}
