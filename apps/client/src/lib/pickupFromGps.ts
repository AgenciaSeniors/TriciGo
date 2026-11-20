/**
 * Fills the pickup of the service picker from the rider's position.
 *
 * The home screen looks the position up when it mounts and hands it over
 * through `prefetchedPickup`, but that work dies with the home screen: tap a
 * destination before it finishes and the picker opens with no pickup, or with
 * "Detectando dirección..." if it was halfway through the address. It also
 * asks only once, so when the phone has no fix yet the pickup never comes,
 * even after the GPS finds one. The picker runs this while its pickup is
 * pending, and it keeps waiting for a fix for as long as the picker is open.
 *
 * Plain functions so it can be tested without a renderer; `usePickupFromGps`
 * wires it to expo-location and the ride store.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface PickupFromGpsDeps {
  /** True while the pickup is empty or still waiting for its address. Checked
   *  before every write, so a pickup the rider chooses meanwhile is kept. */
  pickupIsPending(): boolean;
  /** Where the pickup is when it already has a position but no address yet. */
  pendingLocation(): LatLng | null;
  /** Whether location permission is granted. Never asks for it. */
  hasPermission(): Promise<boolean>;
  /** The phone's last known position, or null when it has none. */
  lastKnown(): Promise<LatLng | null>;
  /** Starts listening for positions and returns what stops it. The callback
   *  may run before this returns. */
  watchFirstFix(onFix: (loc: LatLng) => void): () => void;
  reverseGeocode(loc: LatLng): Promise<string | null>;
  /** Sets an empty pickup. */
  fill(address: string, loc: LatLng): void;
  /** Gives the pending pickup its address, keeping its point (and so the
   *  fare estimate already computed for it). */
  setAddress(address: string): void;
  sleep(ms: number): Promise<void>;
}

const samePoint = (a: LatLng | null, b: LatLng) =>
  a !== null && a.latitude === b.latitude && a.longitude === b.longitude;

/** Same fallback as the home screen. Requesting the ride tries the address
 *  once more, and the server resolves raw coordinates itself (00546). */
const coordinates = (loc: LatLng) => `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`;

/** Same retry the home screen uses: Mapbox can fail on a cold start. */
const GEOCODE_ATTEMPTS = 3;
const GEOCODE_RETRY_MS = 1000;

/** Starts filling the pickup; the returned function stops it. */
export function startPickupFromGps(deps: PickupFromGpsDeps): () => void {
  let stopped = false;
  let gotFix = false;
  let stopWatch: (() => void) | null = null;

  const live = () => !stopped && deps.pickupIsPending();

  const addressFor = async (loc: LatLng): Promise<string | null> => {
    for (let attempt = 1; attempt <= GEOCODE_ATTEMPTS && !stopped; attempt++) {
      if (attempt > 1) await deps.sleep(GEOCODE_RETRY_MS);
      try {
        const address = await deps.reverseGeocode(loc);
        if (address) return address;
      } catch {
        // Try again.
      }
    }
    return null;
  };

  const fillFrom = async (loc: LatLng) => {
    if (!live()) return;
    const address = await addressFor(loc);
    if (!live()) return;
    deps.fill(address ?? coordinates(loc), loc);
  };

  void (async () => {
    try {
      if (!live()) return;
      const pending = deps.pendingLocation();
      if (pending) {
        const address = await addressFor(pending);
        // A pin the rider dragged meanwhile gets its own address.
        if (stopped || !samePoint(deps.pendingLocation(), pending)) return;
        deps.setAddress(address ?? coordinates(pending));
        return;
      }

      if (!(await deps.hasPermission()) || !live()) return;
      const last = await deps.lastKnown().catch(() => null);
      if (!live()) return;
      if (last) {
        await fillFrom(last);
        return;
      }

      const stop = deps.watchFirstFix((loc) => {
        if (gotFix) return;
        gotFix = true;
        const watch = stopWatch;
        stopWatch = null;
        watch?.();
        void fillFrom(loc);
      });
      if (gotFix || stopped) stop();
      else stopWatch = stop;
    } catch {
      // Never let a location error reach the screen: the rider can still
      // type the pickup.
    }
  })();

  return () => {
    stopped = true;
    const watch = stopWatch;
    stopWatch = null;
    watch?.();
  };
}
