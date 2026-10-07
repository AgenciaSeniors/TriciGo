/**
 * Support assigned this driver a ride (00628, admin_assign_ride_to_driver). The push is
 * category `system`, and send-push overwrites data.type with the category, so the event
 * travels in data.event.
 *
 * useNotifications hears the push; useDriverRideInit loads the trip. They talk through this
 * module rather than importing each other: useDriverRide pulls native modules that the
 * notification hook's tests do not mock.
 */
export function isRideAssignedPush(data: unknown): boolean {
  return (data as { event?: unknown } | null | undefined)?.event === 'ride_assigned';
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function onRideAssignedPush(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitRideAssignedPush(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One listener failing must not keep the trip from loading in another.
    }
  }
}

/** Overlapping reconciles (a push received and then tapped, a poll a moment later) give one notice. */
export const ASSIGNED_RIDE_NOTICE_DEDUP_MS = 10_000;

export interface AssignedRideNoticeInput {
  /**
   * The server's previous answer to "what is this driver's active trip" in this process: a ride
   * id, null for none, undefined if it was never answered (the app just started or the driver
   * just signed in).
   */
  previousServerTripId: string | null | undefined;
  /** The trip the store held right before this load, whatever its status. */
  heldTripId: string | null;
  /** The active trip the reconcile just loaded. */
  loadedTripId: string;
  /**
   * The driver tapped "Aceptar" on this ride in this process: the reply may still be on its way,
   * or a dropped connection lost it after the server took the ride.
   */
  driverTriedToAccept: boolean;
  lastNoticeAt: number;
  now: number;
}

/**
 * Whether a reconcile that loaded an active trip should say "Soporte te asignó un viaje" (toast,
 * haptic, sound). Any trigger counts (the push, the 30 s check, the app coming back), because
 * most drivers have no push token. It stays quiet for a trip the app is only restoring: the first
 * answer of the process, a ride it already had or the server already reported, or a ride the
 * driver accepted here (a reconcile can land before the accept's reply, or after a lost one).
 */
export function shouldAnnounceAssignedRide(input: AssignedRideNoticeInput): boolean {
  if (input.previousServerTripId === undefined) return false;
  if (input.previousServerTripId === input.loadedTripId) return false;
  if (input.heldTripId === input.loadedTripId) return false;
  if (input.driverTriedToAccept) return false;
  return input.now - input.lastNoticeAt >= ASSIGNED_RIDE_NOTICE_DEDUP_MS;
}
