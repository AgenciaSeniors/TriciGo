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
