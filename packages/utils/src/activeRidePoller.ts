/**
 * Keeps track of the rider's ride in progress on the web, outside the tracking
 * page (/track/[id]).
 *
 * Before this, nothing on tricigo.com looked for it: a rider who closed the tab
 * during a trip and came back saw the home page with no way back to the ride,
 * the driver or the vehicle coming to pick them up. A single lookup would not
 * be enough either: on 2026-11-16 the passenger app lost a ride the same way
 * because the first requests after it opened, on ETECSA data, never reached
 * the server and nothing asked again (apps/client/src/hooks/rideWatcher.ts).
 *
 * So the lookup repeats: every 20 s while it works, 5 s after one fails, and
 * right away when the tab comes back to the front or the network returns. A
 * lookup that fails never clears a ride already found. Nothing is asked while
 * the tab is hidden.
 *
 * Framework-free so it can be tested: the React side lives in
 * apps/web/src/components/ActiveRideBanner.tsx.
 */

/** With everything working, how often the server is asked again. */
export const ACTIVE_RIDE_POLL_MS = 20_000;
/** How soon a lookup that failed (no network, a timeout) is tried again. */
export const ACTIVE_RIDE_RETRY_MS = 5_000;

/** The fields of a ride this module reads. */
export interface ActiveRideLike {
  id: string;
  status: string;
  is_scheduled?: boolean | null;
  scheduled_at?: string | null;
}

/**
 * Is `ride` happening now, rather than booked for later?
 *
 * A scheduled ride is created with status 'searching' (tg_rides_normalize_scheduling)
 * long before its time, so the active-ride lookup returns it too. Until its
 * time comes, or a driver takes it, it is not a ride in progress. Same rule as
 * the rides list of the passenger app (apps/client/app/(tabs)/rides.tsx).
 */
export function isLiveActiveRide(ride: ActiveRideLike, now: number): boolean {
  if (!ride.is_scheduled || !ride.scheduled_at || ride.status !== 'searching') return true;
  const at = Date.parse(ride.scheduled_at);
  return Number.isNaN(at) || at <= now;
}

/** When the page may ask, and what wakes it up. On the web: document visibility and 'online'. */
export interface PollerWakeSignals {
  isVisible(): boolean;
  /** Call `wake` when the tab is shown again or the network comes back. Returns the unsubscribe. */
  subscribe(wake: () => void): () => void;
}

export interface ActiveRidePollerOptions<T extends ActiveRideLike> {
  /** Ask the server for the rider's active ride. Rejects when the request fails. */
  fetchActiveRide: () => Promise<T | null>;
  /** The ride in progress after each answer, or null when there is none. Not called when a lookup fails. */
  onChange: (ride: T | null) => void;
  signals: PollerWakeSignals;
}

/** Start watching. Returns the function that stops it. */
export function startActiveRidePoller<T extends ActiveRideLike>(options: ActiveRidePollerOptions<T>): () => void {
  const { fetchActiveRide, onChange, signals } = options;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(ms: number): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void lookUp();
    }, ms);
  }

  async function lookUp(): Promise<void> {
    if (stopped || inFlight) return;
    // A hidden tab asks nothing; showing it again calls wake().
    if (!signals.isVisible()) return;
    inFlight = true;
    let failed = false;
    try {
      const ride = await fetchActiveRide();
      if (stopped) return;
      onChange(ride && isLiveActiveRide(ride, Date.now()) ? ride : null);
    } catch {
      // Keep whatever is on screen: one failed request is not "no ride".
      failed = true;
    } finally {
      inFlight = false;
    }
    if (!stopped) schedule(failed ? ACTIVE_RIDE_RETRY_MS : ACTIVE_RIDE_POLL_MS);
  }

  function wake(): void {
    if (stopped || inFlight || !signals.isVisible()) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    void lookUp();
  }

  const unsubscribe = signals.subscribe(wake);
  void lookUp();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    unsubscribe();
  };
}
