/**
 * The rider's ride watcher: recovers the active ride when the app starts and
 * keeps it in step with the server while the app runs.
 *
 * Lifted out of useRideInit (useRide.ts) so it is reachable by tests:
 * apps/client has no React Native renderer, so logic that only lives inside a
 * hook body cannot be tested. useRideInit starts it once there is a user.
 */
import { AppState } from 'react-native';
import i18next from 'i18next';
import Toast from 'react-native-toast-message';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { rideService } from '@tricigo/api';
import { triggerHaptic, trackEvent, logger } from '@tricigo/utils';
import { useRideStore } from '@/stores/ride.store';
import { shouldSendSearchHeartbeat } from '@/hooks/searchHeartbeat';
import { fireRideStatusEffects } from '@/hooks/rideStatusEffects';
import type { Ride } from '@tricigo/types';

/** With no ride in memory, how often the watcher asks the server for one. */
export const ACTIVE_RIDE_LOOKUP_MS = 20_000;
/** How soon a lookup that failed (no network, a timeout) is tried again. */
export const ACTIVE_RIDE_RETRY_MS = 5_000;

/**
 * Is it time to ask the server for an active ride the app does not have?
 *
 * The rider's active ride is looked up once when the app starts. That one
 * request used to be the only one: if it failed, nothing asked again, because
 * the 3 s poll and the foreground check only refresh a ride that is already in
 * memory. On 2026-11-16 an iPhone on ETECSA data reopened the app three times
 * during a trip and the first requests after each cold start never reached the
 * server: the ride, the driver and the vehicle were gone for the rest of the
 * trip while the driver's app showed it normally.
 */
export function isActiveRideLookupDue(lastLookupAt: number, lastLookupFailed: boolean, now: number): boolean {
  return now - lastLookupAt >= (lastLookupFailed ? ACTIVE_RIDE_RETRY_MS : ACTIVE_RIDE_LOOKUP_MS);
}

/**
 * Start watching `userId`'s rides. Returns the function that stops it.
 */
export function startRideWatcher(userId: string): () => void {
  // BUG-277: subscribeToRide is now a no-op that returns { unsubscribe }.
  // Use a minimal interface so the type stays correct without depending on
  // the full RealtimeChannel surface.
  let channel: { unsubscribe: () => void } | null = null;
  let mounted = true;

  let lookupInFlight = false;
  let lastLookupAt = 0;
  let lastLookupFailed = false;

  /**
   * Ask the server for the rider's active ride and show it. Runs at startup
   * and again whenever there is no ride in memory (isActiveRideLookupDue, and
   * every time the app comes back to the foreground).
   */
  async function lookUpActiveRide(): Promise<void> {
    if (lookupInFlight) return;
    lookupInFlight = true;
    lastLookupAt = Date.now();
    // The ride on screen when the lookup started. If the rider starts or ends a
    // ride before the answer arrives, the answer describes a state that is gone.
    const startedWith = useRideStore.getState().activeRide?.id ?? null;
    try {
      const active = await rideService.getActiveRide(userId);
      lastLookupFailed = false;
      if (!mounted) return;
      const now = useRideStore.getState();
      if ((now.activeRide?.id ?? null) !== startedWith || (!startedWith && now.isLoading)) return;
      // BUG-220: clear stale local activeRide if server says no active ride.
      // This handles the case where the ride was canceled/completed
      // server-side but the realtime channel never delivered the UPDATE
      // event (CHANNEL_ERROR loop), leaving the customer stuck on the
      // "in-progress" UI with all pickup/dropoff inputs blocked.
      // BUG-257: but FIRST check if the pinned ride just completed —
      // we need to route the user to the rating screen, not just clear.
      if (!active && mounted) {
        const existing = useRideStore.getState().activeRide;
        if (existing) {
          const final = await rideService.getRideWithDriver(existing.id).catch(() => null);
          if (final?.status === 'completed' && mounted) {
            // eslint-disable-next-line no-console
            console.log('[useRideInit] ride completed since last check — routing to rating', { ride_id: existing.id });
            useRideStore.getState().updateRideFromRealtime(final);
            useRideStore.getState().setRideWithDriver(final);
            return;
          }
          // eslint-disable-next-line no-console
          console.log('[useRideInit] clearing stale local ride', {
            ride_id: existing.id,
            final_status: final?.status ?? 'not_found',
          });
          useRideStore.getState().setFlowStep('idle');
          useRideStore.getState().setActiveRide(null);
          useRideStore.getState().setRideWithDriver(null);
        }
        return;
      }
      if (!active || !mounted) return;

      // BUG-212 (9): the previous version set flowStep='searching'
      // whenever the DB read returned status='searching', and
      // overwrote the local activeRide unconditionally. This
      // produced a visible "looking for drivers" revert when the
      // hook re-ran AFTER a driver had already accepted — e.g. on
      // auth refresh or app foregrounded. The stale fetch
      // overwrote the realtime-updated state.
      //
      // Two guards:
      //   1. If the ride has a driver_id assigned, force
      //      flowStep='active' regardless of status (status may
      //      still be 'searching' for a moment between the realtime
      //      hop and the read replica catching up).
      //   2. Use updateRideFromRealtime when an activeRide is
      //      already in the store — its forward-only validation
      //      prevents a 'searching' from clobbering 'accepted'.
      const existing = useRideStore.getState().activeRide;
      if (existing && existing.id === active.id) {
        useRideStore.getState().updateRideFromRealtime(active);
      } else {
        useRideStore.getState().setActiveRide(active);
      }

      const hasDriver = !!active.driver_id;
      if (active.status === 'searching' && !hasDriver) {
        useRideStore.getState().setFlowStep('searching');
      } else if (active.status === 'completed') {
        useRideStore.getState().setFlowStep('completed');
      } else if (active.status === 'canceled') {
        useRideStore.getState().setFlowStep('idle');
      } else {
        useRideStore.getState().setFlowStep('active');
      }

      // Subscribe to updates
      channel?.unsubscribe();
      // BUG-075: Wrap subscription in try-catch to prevent leaked null reference on error
      try {
        channel = rideService.subscribeToRide(active.id, (ride) => {
          useRideStore.getState().updateRideFromRealtime(ride);
        });
      } catch (subErr) {
        logger.error('Failed to subscribe to ride updates', { error: String(subErr), rideId: active.id });
      }

      // Load driver info if assigned
      if (active.driver_id) {
        const rwd = await rideService.getRideWithDriver(active.id);
        if (mounted && rwd) useRideStore.getState().setRideWithDriver(rwd);
      }
    } catch (err) {
      lastLookupFailed = true;
      logger.warn('No active ride or failed to check', { error: String(err) });
    } finally {
      lookupInFlight = false;
    }
  }

  let driverLoadInFlight = false;

  /**
   * Load the driver's name, photo and vehicle for `ride` when they are not in
   * memory. They arrive with the ride at startup and on 'accepted'
   * (fireRideStatusEffects), each a single request: if it failed, the trip
   * screen stayed without the details of who is coming to pick the rider up.
   */
  async function loadDriverDetailsIfMissing(ride: Ride): Promise<void> {
    if (!ride.driver_id || driverLoadInFlight) return;
    const shown = useRideStore.getState().rideWithDriver;
    if (shown && shown.id === ride.id && shown.driver_id === ride.driver_id) return;
    driverLoadInFlight = true;
    try {
      const loaded = await rideService.getRideWithDriver(ride.id);
      if (mounted && loaded && useRideStore.getState().activeRide?.id === ride.id) {
        useRideStore.getState().setRideWithDriver(loaded);
      }
    } catch {
      // Retried on the next tick.
    } finally {
      driverLoadInFlight = false;
    }
  }

  async function checkActive() {
    await lookUpActiveRide();

    // F009: Check for pending review from a previous completed ride
    try {
      const pendingReviewId = await AsyncStorage.getItem('@tricigo/pending_review_ride_id');
      if (pendingReviewId && mounted) {
        const rwd = await rideService.getRideWithDriver(pendingReviewId);
        if (rwd && rwd.status === 'completed' && mounted) {
          useRideStore.getState().setActiveRide(rwd);
          useRideStore.getState().setRideWithDriver(rwd);
          useRideStore.getState().setFlowStep('completed');
        } else {
          // Ride no longer exists or not completed — clean up
          await AsyncStorage.removeItem('@tricigo/pending_review_ride_id');
        }
      }
    } catch {
      // Best-effort: don't block app startup
    }
  }

  checkActive();

  // BUG-226 + BUG-247 (definitive fix for phantom rides):
  // Triple-layer freshness guarantee so the user is NEVER stuck in a
  // "locked input" state after a ride is canceled/completed.
  //
  //   Layer 1 — Aggressive polling: every 3s while pinned ride exists
  //             (was 10s — too slow when realtime channel is dead).
  //             With no ride in memory the same tick asks the server for
  //             one every ACTIVE_RIDE_LOOKUP_MS (ACTIVE_RIDE_RETRY_MS after a
  //             failure), so a ride the startup lookup missed comes back.
  //   Layer 2 — AppState foreground listener: re-check immediately when
  //             user brings the app to foreground (covers the case
  //             where ride got canceled while phone was in background).
  //   Layer 3 — Pre-render check on store mutation: any time the store
  //             mutation function runs and activeRide age > 30s without
  //             a recent DB confirmation, force a re-fetch.
  //
  // This watcher also carries the persistent-search HEARTBEAT (see below).
  let lastBeatAt = 0;

  const checkAndClearStale = async (foreground = false): Promise<void> => {
    if (!mounted || !userId) return;
    const { activeRide: pinned, flowStep: fs, isLoading } = useRideStore.getState();
    if (!pinned) {
      // No ride in memory: ask the server whether there is one (the startup
      // lookup may have failed). Not while the rider is creating a ride — that
      // request puts its own ride in memory.
      if (!isLoading && (foreground || isActiveRideLookupDue(lastLookupAt, lastLookupFailed, Date.now()))) {
        await lookUpActiveRide();
      }
      return;
    }
    if (fs === 'idle' || fs === 'completed') return;

    // Persistent-search heartbeat. `cleanup_orphan_searching_rides` cancels
    // any ride whose `searching_seen_at` went stale, so with no beat EVERY
    // ride that no driver accepts is killed at `searching_abandon_seconds`
    // (600s) while the rider is still watching the search screen — and the
    // next tap on "Cancelar" then hits `ride_already_closed`.
    //
    // The beat used to live in the 3s polling loop that confirmRide starts,
    // but that interval is owned by ReviewingView/SelectingView, and the
    // `setFlowStep('searching')` inside confirmRide unmounts them — their
    // cleanup cleared the interval before its first tick, so the beat never
    // fired even once. Prod bore that out: across 114 rides, not one real
    // ride ever had `searching_seen_at > created_at` (the only 3 rows that
    // do are seeded demo data, with day-long offsets). The web app never
    // had the bug — it beats from its own hook, useSearchingRide.
    //
    // It belongs here because useRideInit is mounted once in
    // app/_layout.tsx and outlives every view swap. Backgrounding the app
    // still suspends these timers, so a genuinely abandoned search is still
    // reaped — which is the point of the feature.
    if (shouldSendSearchHeartbeat(fs, lastBeatAt, Date.now())) {
      lastBeatAt = Date.now();
      // Fire-and-forget: touchSearchingRide swallows its own errors, and a
      // missed beat is harmless (the next one is 30s away).
      void rideService.touchSearchingRide(pinned.id);
    }

    try {
      const fresh = await rideService.getActiveRide(userId);
      // The ride changed while this poll was in flight (cancelled by the
      // rider, e.g. "Cambiar a Moto" restoring the draft): its answer is
      // about a ride that is no longer on screen, so drop it.
      if (useRideStore.getState().activeRide?.id !== pinned.id) return;
      if (!fresh) {
        // BUG-257: getActiveRide filters by ACTIVE statuses only
        // (searching/accepted/.../in_progress/arrived_at_destination).
        // If our pinned ride is no longer in that list, it might have
        // just completed — in which case we MUST route the user to the
        // completion + rating screen, not just clear to idle. Fetch the
        // ride directly by id (no status filter) to find out.
        const final = await rideService.getRideWithDriver(pinned.id).catch(() => null);
        if (final?.status === 'completed') {
          // eslint-disable-next-line no-console
          console.log('[Watcher] ride completed — routing to rating', { ride_id: pinned.id });
          // Fire while pinned.status is still the PREVIOUS status — the
          // store update below overwrites it.
          if (pinned.status !== 'completed') fireRideStatusEffects(pinned.status, final);
          useRideStore.getState().updateRideFromRealtime(final);
          useRideStore.getState().setRideWithDriver(final);
          return;
        }
        // Canceled (by driver, dispatcher, or auto-cleanup) or
        // genuinely gone — clear local state.
        // eslint-disable-next-line no-console
        console.log('[Watcher] DB has no active ride — clearing stale local', {
          ride_id: pinned.id,
          final_status: final?.status ?? 'not_found',
        });
        // Say WHY the trip disappeared. Wiping the screen in silence is what
        // made a server-side cancellation look like the app losing the trip;
        // the rider was left to discover it by tapping "Cancelar" and getting
        // `ride_already_closed` back.
        if (final?.status === 'canceled' && pinned.status !== 'canceled') {
          fireRideStatusEffects(pinned.status, final);
        }
        useRideStore.getState().setFlowStep('idle');
        useRideStore.getState().setActiveRide(null);
        useRideStore.getState().setRideWithDriver(null);
        // Sticky-serviceType fix: also reset the draft so a system-canceled
        // mensajería order doesn't leave serviceType stuck on the next trip.
        useRideStore.getState().resetDraft();
      } else if (fresh.id === pinned.id) {
        // BUG-287 fix B — detect mid-trip column changes that don't touch
        // status/driver_id but DO drive UI (gps_override_requested_at
        // surfaces the rider confirmation modal; gps_override_confirmed_at
        // dismisses it). Without these checks the modal could lag up to 3 s
        // OR sit open indefinitely until status changed.
        const gpsReqChanged =
          (fresh as { gps_override_requested_at?: string | null }).gps_override_requested_at !==
          (pinned as { gps_override_requested_at?: string | null }).gps_override_requested_at;
        const gpsConfChanged =
          (fresh as { gps_override_confirmed_at?: string | null }).gps_override_confirmed_at !==
          (pinned as { gps_override_confirmed_at?: string | null }).gps_override_confirmed_at;
        const driverGpsStatusChanged =
          (fresh as { driver_gps_status?: string | null }).driver_gps_status !==
          (pinned as { driver_gps_status?: string | null }).driver_gps_status;
        // Add-stop: the recalc trigger updates estimated_fare_cup /
        // estimated_distance_m / estimated_duration_s WITHOUT changing
        // status. Without detecting these, the new fare/ETA never reaches
        // the screen during in_progress (realtime is disabled, BUG-277).
        const estimatedChanged =
          (fresh as { estimated_fare_cup?: number | null }).estimated_fare_cup !==
            (pinned as { estimated_fare_cup?: number | null }).estimated_fare_cup
          || (fresh as { estimated_distance_m?: number | null }).estimated_distance_m !==
            (pinned as { estimated_distance_m?: number | null }).estimated_distance_m
          || (fresh as { estimated_duration_s?: number | null }).estimated_duration_s !==
            (pinned as { estimated_duration_s?: number | null }).estimated_duration_s;

        // Support can switch a searching ride to another vehicle type (00628): a new
        // service_type and fare with the same status, and the fare can even stay equal.
        const serviceChanged =
          fresh.service_type !== pinned.service_type
          || fresh.estimated_fare_trc !== pinned.estimated_fare_trc;

        // Payment can flip pending→paid without touching status (the driver
        // confirms cash, or a wallet debit settles). Without this the
        // confirmation toast never fires.
        const prevPaymentStatus =
          (pinned as { payment_status?: string | null }).payment_status ?? null;
        const newPaymentStatus =
          (fresh as { payment_status?: string | null }).payment_status ?? null;
        const paymentStatusChanged = prevPaymentStatus !== newPaymentStatus;

        if (
          fresh.status !== pinned.status
          || fresh.driver_id !== pinned.driver_id
          || gpsReqChanged
          || gpsConfChanged
          || driverGpsStatusChanged
          || estimatedChanged
          || serviceChanged
          || paymentStatusChanged
        ) {
          // eslint-disable-next-line no-console
          console.log('[Watcher] ride changed', {
            from: pinned.status,
            to: fresh.status,
            gps_req_changed: gpsReqChanged,
            gps_conf_changed: gpsConfChanged,
            driver_gps_status_changed: driverGpsStatusChanged,
            estimated_changed: estimatedChanged,
            service_changed: serviceChanged,
            payment_status_changed: paymentStatusChanged,
          });

          // Capture the previous status BEFORE the store update overwrites it.
          const prevStatus = pinned.status;
          useRideStore.getState().updateRideFromRealtime(fresh);

          // The rider's in-app feedback for this leg of the trip. Terminal
          // statuses (completed / canceled) never reach here — getActiveRide
          // filters them out — they are handled in the `!fresh` branch above.
          if (fresh.status !== prevStatus) {
            fireRideStatusEffects(prevStatus, fresh);
          }

          if (prevPaymentStatus === 'pending' && newPaymentStatus === 'paid') {
            triggerHaptic('success');
            Toast.show({
              type: 'success',
              text1: i18next.t('rider:payment.confirmed', { defaultValue: 'Pago confirmado' }),
            });
            trackEvent('ride_payment_confirmed', { ride_id: fresh.id });
          }
        } else {
          // Nothing changed. A change to 'accepted' fetches the driver itself
          // (fireRideStatusEffects), so only an unchanged ride is checked here.
          void loadDriverDetailsIfMissing(fresh);
        }
      } else {
        // The pinned id no longer matches the active ride — clear
        // eslint-disable-next-line no-console
        console.log('[Watcher] pinned ride id mismatch — clearing', { pinned_id: pinned.id, fresh_id: fresh.id });
        useRideStore.getState().setFlowStep('idle');
        useRideStore.getState().setActiveRide(null);
        useRideStore.getState().setRideWithDriver(null);
        // Sticky-serviceType fix: reset the draft on stale-state clear too.
        useRideStore.getState().resetDraft();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[Watcher] check failed', String(err));
    }
  };

  // Layer 1: aggressive 3s polling
  const watcherInterval = setInterval(() => { void checkAndClearStale(); }, 3_000);

  // Layer 2: re-check on app foreground
  const appStateSub = AppState.addEventListener('change', (state) => {
    if (state === 'active' && mounted) {
      // Fire immediately when user returns to the app
      void checkAndClearStale(true);
    }
  });

  return () => {
    mounted = false;
    clearInterval(watcherInterval);
    appStateSub.remove();
    channel?.unsubscribe();
  };
}
