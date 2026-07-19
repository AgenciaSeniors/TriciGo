import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { View, Pressable, Linking, Alert, ActivityIndicator, useColorScheme, Dimensions, Animated, Share, ScrollView, Keyboard } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { StopsList } from '@tricigo/ui';
import { formatTRC, formatCUP, haversineDistance, logger, formatArrivalTime, buildShareUrl, triggerHaptic } from '@tricigo/utils';
import { RIDE_CONFIG } from '@/config/ride';
import { useTranslation } from '@tricigo/i18n';
import Toast from 'react-native-toast-message';
import * as Clipboard from 'expo-clipboard';
import { incidentService, rideService, trustedContactService, getSupabaseClient, deliveryService } from '@tricigo/api';
import type { DeliveryDetails } from '@tricigo/api';
import type { RideSplit } from '@tricigo/types';
import { useRideStore } from '@/stores/ride.store';
import { useRideActions } from '@/hooks/useRide';
import { useAuthStore } from '@/stores/auth.store';
import { RideMapView } from '@/components/RideMapView';
import { TripActionBar } from '@/components/TripActionBar';
import { useDriverPositionWithCache } from '@/hooks/useDriverPosition';
import { useUnreadChatCount } from '@/hooks/useUnreadChatCount';
import { formatTimeAgo } from '@tricigo/utils/offlineLabels';
import { useRoutePolyline } from '@/hooks/useRoutePolyline';
import { useDriverToPickupRoute, useLiveDriverRoute } from '@/hooks/useDriverToPickupRoute';
import { useETA } from '@/hooks/useETA';
import { useTripProgress } from '@/hooks/useTripProgress';
import { TripProgressBar } from '@tricigo/ui/TripProgressBar';
import { ArrivalBanner } from '@/components/ArrivalBanner';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { ETABadge } from '@tricigo/ui/ETABadge';
import { DriverCard } from '@tricigo/ui/DriverCard';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { CancelRideSheet } from '@/components/CancelRideSheet';
import { SafetySheet } from '@/components/SafetySheet';
import { AddressSearchInput } from '@/components/AddressSearchInput';
import { ConfirmLocationScreen } from '@/components/ConfirmLocationScreen';
import { ConfettiOverlay } from '@/components/ConfettiOverlay';
import { ArrivalCard } from '@/components/ArrivalCard';
import { ProximityBanner } from '@/components/ProximityBanner';
import { useProximityAlert } from '@/hooks/useProximityAlert';
import type { GeoPoint } from '@tricigo/utils';
import { getRouteETA } from '@/services/mapbox.service';

export function RideActiveView() {
  const { t } = useTranslation('rider');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const RIDE_STEPS = [
    { key: 'accepted', label: t('ride.status_accepted') },
    { key: 'driver_en_route', label: t('ride.status_driver_en_route') },
    { key: 'arrived_at_pickup', label: t('ride.status_arrived_at_pickup') },
    { key: 'in_progress', label: t('ride.status_in_progress') },
    { key: 'arrived_at_destination', label: t('ride.status_arrived_at_destination', { defaultValue: 'At destination' }) },
  ];
  const activeRide = useRideStore((s) => s.activeRide);
  const rideWithDriver = useRideStore((s) => s.rideWithDriver);
  const isLoading = useRideStore((s) => s.isLoading);
  const addSplit = useRideStore((s) => s.addSplit);
  const updateSplit = useRideStore((s) => s.updateSplit);
  const setSplits = useRideStore((s) => s.setSplits);
  const userId = useAuthStore((s) => s.user?.id);
  const userFullName = useAuthStore((s) => s.user?.full_name ?? null);
  const { cancelRide } = useRideActions();
  const driverPosState = useDriverPositionWithCache(activeRide?.id ?? null);
  const driverPosition = driverPosState.position;
  // Bug B: unread-message badge for the fixed TripActionBar chat button.
  const { count: unreadChatCount, markRead: markChatRead } = useUnreadChatCount(
    activeRide?.id ?? null,
  );

  // Waypoints state — declared early so useRoutePolyline below can
  // include them in the route fetch. State is populated by a useEffect
  // further down (initial fetch + realtime subscription).
  const [waypoints, setWaypoints] = useState<Array<{ id: string; address: string; sort_order: number; latitude: number; longitude: number; arrived_at?: string | null; departed_at?: string | null }>>([]);

  // Route polyline through pickup → waypoints → dropoff. Recomputes
  // automatically when a stop is added (waypoints state changes →
  // JSON.stringify dep in useRoutePolyline re-fetches).
  const waypointPoints = useMemo(
    () =>
      waypoints
        .filter((w) => typeof w.latitude === 'number' && typeof w.longitude === 'number')
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((w) => ({ latitude: w.latitude, longitude: w.longitude })),
    [waypoints],
  );
  /** Status array parallel to waypointPoints — used by RideMapView to
   *  pulse the marker of the next stop the driver is going to. */
  const waypointStatuses = useMemo<Array<'pending' | 'current' | 'completed'>>(() => {
    const sorted = [...waypoints].sort((a, b) => a.sort_order - b.sort_order);
    // First one that has neither arrived nor departed is "current".
    let currentAssigned = false;
    return sorted.map((w) => {
      if (w.departed_at) return 'completed';
      if (!currentAssigned) {
        currentAssigned = true;
        return 'current';
      }
      return 'pending';
    });
  }, [waypoints]);
  /** Stops the driver still has to visit (not yet departed), in order. The
   *  live trip route threads through these so a newly added stop is actually
   *  drawn on the map during in_progress. */
  const pendingWaypointPoints = useMemo(
    () =>
      waypoints
        .filter((w) => !w.departed_at && typeof w.latitude === 'number' && typeof w.longitude === 'number')
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((w) => ({ latitude: w.latitude, longitude: w.longitude })),
    [waypoints],
  );
  const routeData = useRoutePolyline(
    activeRide?.pickup_location ?? null,
    activeRide?.dropoff_location ?? null,
    waypointPoints,
  );

  /**
   * BUG-279 — live driver→dropoff polyline that follows the driver's
   * actual path during the trip. Replaces the static pickup→dropoff
   * polyline once the trip starts (`in_progress` / `arrived_at_destination`).
   *
   * Why this hook exists:
   *   - useRoutePolyline returns a STATIC route from pickup to dropoff.
   *     It never updates while the driver moves — if the driver takes a
   *     parallel street or a shortcut, the line stays glued to the
   *     original path while the marker drifts off it. User reported:
   *     "si el driver cambia la ruta, el client no actualiza la nueva
   *     ruta del driver, es como si mantuviese su ruta fija".
   *   - useLiveDriverRoute (new in BUG-279) refetches OSRM whenever the
   *     driver deviates >50m from the polyline, so the line tracks the
   *     real path.
   *
   * UX choice (Option A): during in_progress we REPLACE the static line
   * with the live driver→dropoff line. We do not show both — keeps the
   * map clean and matches Uber/Lyft behavior. If we ever want to show
   * the "originally planned" route faded behind, swap to Option B.
   *
   * Add-stop: pendingWaypointPoints are passed so the live route threads
   * driver → pending stops → dropoff. Without this it pointed straight at
   * the dropoff and a newly added stop never appeared on the map.
   */
  const isInProgress = activeRide?.status === 'in_progress'
    || activeRide?.status === 'arrived_at_destination';
  const liveDriverToDropoffRoute = useLiveDriverRoute(
    driverPosition,
    activeRide?.dropoff_location ?? null,
    isInProgress,
    pendingWaypointPoints,
  );

  // The polyline we hand to the map: live during the trip, static otherwise.
  const routeCoordinates = isInProgress
    ? (liveDriverToDropoffRoute ?? routeData.coordinates)
    : routeData.coordinates;

  const driverToPickupRoute = useDriverToPickupRoute(
    driverPosition,
    activeRide?.pickup_location ?? null,
    activeRide?.status ?? null,
  );
  const { etaMinutes, isCalculating } = useETA({
    driverLocation: driverPosition,
    pickupLocation: activeRide?.pickup_location ?? null,
    dropoffLocation: activeRide?.dropoff_location ?? null,
    rideStatus: activeRide?.status ?? null,
    estimatedDurationS: activeRide?.estimated_duration_s,
  });

  // Trip progress (Uber-style progress bar during in_progress)
  const tripProgress = useTripProgress({
    driverLocation: driverPosition,
    routeCoordinates: routeCoordinates,
    totalDistanceM: routeData.distanceM,
    etaMinutes,
    rideStatus: activeRide?.status ?? null,
  });

  // Arrival banner states
  const [showDestinationBanner, setShowDestinationBanner] = useState(false);
  const prevStatusRef = useRef(activeRide?.status);

  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = activeRide?.status;
    prevStatusRef.current = curr;

    if (curr === 'arrived_at_destination' && prev !== 'arrived_at_destination') {
      setShowDestinationBanner(true);
    }
  }, [activeRide?.status]);

  // Haptic feedback on ride status transitions
  const prevHapticStatusRef = useRef(activeRide?.status);
  useEffect(() => {
    if (!activeRide?.status) return;
    const prev = prevHapticStatusRef.current;
    prevHapticStatusRef.current = activeRide.status;
    if (prev === activeRide.status) return;

    const hapticMap: Record<string, string> = {
      accepted: 'success',
      arrived_at_pickup: 'success',
      in_progress: 'medium',
      arrived_at_destination: 'success',
    };
    const hapticType = hapticMap[activeRide.status];
    if (hapticType) triggerHaptic(hapticType as any);
  }, [activeRide?.status]);

  // INFRA-2: Mapbox Directions route ETA (more accurate than haversine)
  const [routeETA, setRouteETA] = useState<{ durationMinutes: number; distanceKm: number } | null>(null);
  // Latest-wins guard: getRouteETA fires on every driverPosition change, so a
  // slow older request could resolve after a newer one and overwrite a fresher
  // ETA. Only the most recent request may set state.
  const etaReqIdRef = useRef(0);

  useEffect(() => {
    if (!driverPosition || !activeRide) return;

    const target = activeRide.status === 'driver_en_route' || activeRide.status === 'accepted'
      ? { lat: activeRide.pickup_location?.latitude ?? 0, lng: activeRide.pickup_location?.longitude ?? 0 }
      : { lat: activeRide.dropoff_location?.latitude ?? 0, lng: activeRide.dropoff_location?.longitude ?? 0 };

    const reqId = ++etaReqIdRef.current;
    getRouteETA(
      { lat: driverPosition.latitude, lng: driverPosition.longitude },
      target,
    ).then((result) => {
      if (etaReqIdRef.current === reqId && result) setRouteETA(result);
    });
  }, [driverPosition?.latitude, driverPosition?.longitude, activeRide?.status]);

  // Use Mapbox route ETA when available, fall back to useETA hook
  const displayEtaMinutes = routeETA?.durationMinutes ?? etaMinutes;
  const displayDistanceKm = routeETA?.distanceKm ?? (
    driverPosition && activeRide?.pickup_location
      ? (haversineDistance(driverPosition, activeRide.pickup_location) / 1000)
      : null
  );

  // Proximity alerts (driver ~2 min from pickup / approaching destination)
  const proximityAlert = useProximityAlert({
    rideId: activeRide?.id ?? null,
    rideStatus: activeRide?.status ?? null,
    etaMinutes: displayEtaMinutes,
    driverName: rideWithDriver?.driver_name ?? null,
  });

  // X3.2: Dynamic map height — 40% of screen
  const mapHeight = Math.round(Dimensions.get('window').height * 0.4);

  // X3.3: ETA pulse animation when < 3 minutes
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  // I2: Green arrival banner scale animation
  const bannerScaleAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (displayEtaMinutes !== null && displayEtaMinutes > 0 && displayEtaMinutes < 3) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.05, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ]),
      );
      pulseLoopRef.current = loop;
      loop.start();
    } else {
      if (pulseLoopRef.current) {
        pulseLoopRef.current.stop();
        pulseLoopRef.current = null;
      }
      pulseAnim.setValue(1);
    }
    return () => {
      if (pulseLoopRef.current) {
        pulseLoopRef.current.stop();
        pulseLoopRef.current = null;
      }
    };
  }, [displayEtaMinutes, pulseAnim]);

  // I2: Trigger green banner animation on arrived_at_pickup
  useEffect(() => {
    if (activeRide?.status === 'arrived_at_pickup') {
      Animated.spring(bannerScaleAnim, {
        toValue: 1,
        tension: 80,
        friction: 8,
        useNativeDriver: true,
      }).start();
    } else {
      bannerScaleAnim.setValue(0);
    }
  }, [activeRide?.status, bannerScaleAnim]);

  // X2.1: Driver position timeout — show message instead of spinner after 30s
  const [positionTimeoutReached, setPositionTimeoutReached] = useState(false);
  const positionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (driverPosition) {
      // Position received — clear timeout and reset flag
      if (positionTimeoutRef.current) {
        clearTimeout(positionTimeoutRef.current);
        positionTimeoutRef.current = null;
      }
      setPositionTimeoutReached(false);
      return;
    }

    // driverPosition is null and ride is in accepted or driver_en_route
    if (
      activeRide?.status === 'accepted' ||
      activeRide?.status === 'driver_en_route'
    ) {
      if (!positionTimeoutRef.current) {
        positionTimeoutRef.current = setTimeout(() => {
          setPositionTimeoutReached(true);
          positionTimeoutRef.current = null;
        }, RIDE_CONFIG.POSITION_TIMEOUT_MS);
      }
    }

    return () => {
      if (positionTimeoutRef.current) {
        clearTimeout(positionTimeoutRef.current);
        positionTimeoutRef.current = null;
      }
    };
  }, [driverPosition, activeRide?.status]);

  // Driver-not-moving detection (4.2)
  const prevDriverPosRef = useRef<{ latitude: number; longitude: number; timestamp: number } | null>(null);
  const [driverNotMoving, setDriverNotMoving] = useState(false);

  useEffect(() => {
    if (!driverPosition || activeRide?.status !== 'driver_en_route') {
      // Reset when not in driver_en_route status or no position
      prevDriverPosRef.current = null;
      setDriverNotMoving(false);
      return;
    }

    const now = Date.now();
    const prev = prevDriverPosRef.current;

    if (!prev) {
      prevDriverPosRef.current = { latitude: driverPosition.latitude, longitude: driverPosition.longitude, timestamp: now };
      return;
    }

    const dist = haversineDistance(
      { latitude: prev.latitude, longitude: prev.longitude },
      { latitude: driverPosition.latitude, longitude: driverPosition.longitude },
    );

    if (dist > RIDE_CONFIG.DRIVER_NOT_MOVING_THRESHOLD_M) {
      // Driver moved significantly — reset tracking
      prevDriverPosRef.current = { latitude: driverPosition.latitude, longitude: driverPosition.longitude, timestamp: now };
      setDriverNotMoving(false);
    } else {
      // Driver hasn't moved much — check if 5 minutes have passed
      const elapsedMs = now - prev.timestamp;
      if (elapsedMs >= RIDE_CONFIG.DRIVER_NOT_MOVING_TIMEOUT_MS) {
        setDriverNotMoving(true);
      }
    }
  }, [driverPosition, activeRide?.status]);

  // Stale position detection (4.3) — position older than 60s. Based on the real
  // GPS-fix timestamp (recordedAt) so a driver who goes offline mid-ride (the
  // position freezes but isCached stays false after the first poll) still trips
  // the banner. Falls back to the cached timestamp when there's no live recordedAt.
  const positionAgeMs = driverPosition?.recordedAt != null
    ? Date.now() - driverPosition.recordedAt
    : (driverPosState.isCached && driverPosState.cachedAt
        ? Date.now() - new Date(driverPosState.cachedAt).getTime()
        : null);
  const positionIsStale = positionAgeMs != null ? positionAgeMs > 60_000 : false;

  // `waypoints` state is declared earlier (near the useRoutePolyline
  // call) so the route hook sees them. Only the add-stop UI state
  // lives here.
  const [addStopVisible, setAddStopVisible] = useState(false);
  const [addingStop, setAddingStop] = useState(false);
  const [mapPickerVisible, setMapPickerVisible] = useState(false);

  // X1.6: Use refs for subscription channels to ensure proper cleanup on ride change
  const waypointChannelRef = useRef<ReturnType<typeof rideService.subscribeToWaypoints> | null>(null);
  const splitChannelRef = useRef<ReturnType<typeof rideService.subscribeToSplits> | null>(null);

  // Fetch existing waypoints + subscribe to inserts AND updates (driver arrive/depart)
  useEffect(() => {
    // Clean up previous subscription before creating a new one
    if (waypointChannelRef.current) {
      const supabase = getSupabaseClient();
      supabase.removeChannel(waypointChannelRef.current);
      waypointChannelRef.current = null;
    }

    if (!activeRide) return;
    const rideId = activeRide.id;
    const refetch = () => {
      rideService.getRideWaypoints(rideId)
        // Bugfix: the service returns `Waypoint[]` with a nested
        // `location: GeoPoint` but the local state uses flat
        // latitude/longitude fields — the `as typeof waypoints` cast
        // was unsound and downstream `wp.latitude` reads were landing
        // on `undefined` at runtime. Flatten the shape explicitly.
        .then((wps) => setWaypoints(wps.map((wp) => ({
          id: wp.id,
          address: wp.address,
          sort_order: wp.sort_order,
          latitude: wp.location.latitude,
          longitude: wp.location.longitude,
          arrived_at: wp.arrived_at ?? null,
          departed_at: wp.departed_at ?? null,
        }))))
        .catch(() => {});
    };
    refetch();

    // Realtime payloads arrive with `location` as opaque GEOGRAPHY
    // hex (no latitude/longitude extracted). Instead of trying to
    // merge partial data, re-fetch the authoritative list through
    // the RPC so the state always has proper lat/lng.
    waypointChannelRef.current = rideService.subscribeToWaypoints(
      rideId,
      () => refetch(),
      () => refetch(),
    );

    return () => {
      if (waypointChannelRef.current) {
        const supabase = getSupabaseClient();
        supabase.removeChannel(waypointChannelRef.current);
        waypointChannelRef.current = null;
      }
    };
  }, [activeRide?.id]);

  // Fetch delivery details for cargo rides so we can surface the OTP card
  // (the customer shares the code with the recipient before drop-off).
  // Non-blocking: does nothing for passenger rides or if the row isn't there.
  const [deliveryDetails, setDeliveryDetails] = useState<DeliveryDetails | null>(null);
  useEffect(() => {
    if (!activeRide?.id || activeRide.ride_mode !== 'cargo') {
      setDeliveryDetails(null);
      return;
    }
    let cancelled = false;
    deliveryService.getDeliveryDetails(activeRide.id)
      .then((dd) => { if (!cancelled && dd) setDeliveryDetails(dd); })
      .catch(() => { /* no delivery_details — non-blocking */ });
    return () => { cancelled = true; };
  }, [activeRide?.id, activeRide?.ride_mode]);

  // Subscribe to real-time split changes (invitations, acceptances, payments)
  useEffect(() => {
    // Clean up previous subscription before creating a new one
    if (splitChannelRef.current) {
      const supabase = getSupabaseClient();
      supabase.removeChannel(splitChannelRef.current);
      splitChannelRef.current = null;
    }

    if (!activeRide?.id || !activeRide.is_split) return;

    // Fetch existing splits
    rideService.getSplitsForRide(activeRide.id)
      .then((existingSplits) => setSplits(existingSplits))
      .catch(() => {});

    splitChannelRef.current = rideService.subscribeToSplits(
      activeRide.id,
      // Bugfix: realtime callbacks are typed `Record<string, unknown>`
      // (opaque payload) but the store expects `RideSplit`. Narrow via
      // a `Partial<RideSplit>` cast; at runtime the payload is already
      // a ride_splits row, it's just that Supabase's generic callback
      // signature can't know that. No data change — just TS hygiene.
      (newSplit) => addSplit(newSplit as unknown as RideSplit),
      (updatedSplit) => updateSplit(updatedSplit as unknown as RideSplit),
    );

    return () => {
      if (splitChannelRef.current) {
        const supabase = getSupabaseClient();
        supabase.removeChannel(splitChannelRef.current);
        splitChannelRef.current = null;
      }
    };
  }, [activeRide?.id, activeRide?.is_split]);

  // I3: pending stop waiting for user confirmation + its fare delta preview.
  const [pendingStop, setPendingStop] = useState<
    | { address: string; location: GeoPoint; extraDistanceKm: number; extraFareCup: number }
    | null
  >(null);
  const [estimatingStop, setEstimatingStop] = useState(false);

  const handleAddStop = async (address: string, location: GeoPoint) => {
    if (!activeRide) return;
    // Dismiss the search keyboard before swapping to the confirm step so the
    // "Confirmar parada" button (at the bottom of the sheet) is never hidden
    // behind the keyboard.
    Keyboard.dismiss();
    // Guard against a malformed selection (geocoding miss / undefined coords):
    // without this we'd carry NaN into ride_waypoints and the confirm would
    // fail silently downstream.
    if (!Number.isFinite(location?.latitude) || !Number.isFinite(location?.longitude)) {
      Toast.show({
        type: 'error',
        text1: t('ride.add_stop_invalid_location', {
          defaultValue: 'No pudimos ubicar esa dirección. Prueba con otra.',
        }),
      });
      return;
    }
    setEstimatingStop(true);
    try {
      const existing = waypoints.map((w) => ({
        latitude: w.latitude,
        longitude: w.longitude,
      }));
      const { extraDistanceKm, extraFareCup } = await rideService.estimateWaypointAddition(
        activeRide.id,
        location.latitude,
        location.longitude,
        existing,
      );
      // The single add-stop sheet swaps from search → confirm purely off
      // `pendingStop`. We intentionally keep `addStopVisible` as-is (no second
      // Modal opened/closed in the same tick) to avoid the present-while-
      // dismissing race RN has with two overlapping modals.
      setPendingStop({ address, location, extraDistanceKm, extraFareCup });
    } catch (err) {
      logger.error('Failed to estimate waypoint addition', { error: String(err) });
      // Fall back to adding without a fare preview rather than blocking the
      // feature, but tell the user the preview is missing.
      Toast.show({
        type: 'info',
        text1: t('ride.estimate_stop_failed', {
          defaultValue: 'No pudimos calcular el costo extra. Puedes confirmar de todas formas.',
        }),
      });
      setPendingStop({ address, location, extraDistanceKm: 0, extraFareCup: 0 });
    } finally {
      setEstimatingStop(false);
    }
  };

  const confirmAddStop = async () => {
    if (!activeRide || !pendingStop) return;
    setAddingStop(true);
    try {
      const wp = await rideService.addWaypointToActiveRide(
        activeRide.id,
        pendingStop.address,
        pendingStop.location.latitude,
        pendingStop.location.longitude,
      );
      // Merge coords we know locally (DB returns `location` as opaque
      // GEOGRAPHY WKB — ride.service.getRideWaypoints goes through an
      // RPC to extract lat/lng, but here we short-circuit with the
      // coords the user just picked so the map redraws immediately
      // without waiting for the re-fetch).
      const wpWithCoords = {
        ...(wp as unknown as Record<string, unknown>),
        latitude: pendingStop.location.latitude,
        longitude: pendingStop.location.longitude,
      } as typeof waypoints[number];
      setWaypoints((prev) => [...prev, wpWithCoords]);
      setPendingStop(null);
      // The recalc trigger (mig 00386) just updated estimated_fare_cup /
      // distance / duration server-side. Realtime is disabled (BUG-277) and
      // the 3s watcher would otherwise lag, so refetch the ride now to show
      // the new fare + ETA instantly. Best-effort: the watcher (which now
      // detects estimated_* changes) covers it within ~3s if this fails.
      try {
        const fresh = await rideService.getActiveRide(activeRide.customer_id);
        if (fresh) useRideStore.getState().setActiveRide(fresh);
      } catch {
        /* watcher will catch up */
      }
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown> | null;
      if (typeof errObj?.message === 'string' && errObj.message === 'MAX_WAYPOINTS_REACHED') {
        // Limit reached — there's nothing the user can do from this sheet, so
        // close it instead of leaving a confirm button that re-fails on retry.
        Alert.alert('', t('ride.max_stops_active', { defaultValue: 'Máximo de paradas alcanzado' }));
        setPendingStop(null);
        setAddStopVisible(false);
      } else {
        // Surface every other failure (RLS rejection, bad coords, network
        // timeout) instead of swallowing it — the button used to re-enable
        // with no feedback, which read as "confirm does nothing". Keep
        // `pendingStop` set so the user can retry from the same sheet.
        logger.error('addWaypointToActiveRide failed', { error: String(err) });
        Toast.show({
          type: 'error',
          text1: t('ride.add_stop_failed', {
            defaultValue: 'No pudimos agregar la parada. Inténtalo de nuevo.',
          }),
        });
      }
    } finally {
      setAddingStop(false);
    }
  };

  // Cancel sheet state
  const [cancelSheetVisible, setCancelSheetVisible] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [ratingImpact, setRatingImpact] = useState<import('@tricigo/types').CancellationRatingImpact | null>(null);

  // Phase 6: Arrival card dismissed state
  const [arrivalCardDismissed, setArrivalCardDismissed] = useState(false);

  // Reset arrival card when status changes away from arrived
  useEffect(() => {
    if (activeRide?.status !== 'arrived_at_pickup') {
      setArrivalCardDismissed(false);
    }
  }, [activeRide?.status]);

  // I4.1: Driver card expanded state
  const [driverExpanded, setDriverExpanded] = useState(false);

  // ── Phase 4: Share trip live ──
  const [isSharing, setIsSharing] = useState(false);

  const handleShareTrip = useCallback(async () => {
    if (!activeRide) return;
    setIsSharing(true);
    try {
      let token = activeRide.share_token;
      if (!token) {
        token = await rideService.generateShareToken(activeRide.id);
        // Update local ride with new token
        useRideStore.getState().setActiveRide({ ...activeRide, share_token: token });
      }
      const url = buildShareUrl(token);

      const shareResult = await Share.share({
        message: t('ride.share_message', { url }),
        url, // iOS uses this field
      });
      /* UX: Share.share() completes silently from the user's POV — they
         return from WhatsApp/SMS and see the same screen with no change.
         A light haptic + toast confirms "link compartido" so they know
         the loop closed. Only fires when the OS confirms the share
         actually happened (not on cancel/dismiss). */
      if (shareResult.action === Share.sharedAction) {
        triggerHaptic('light');
        Toast.show({
          type: 'success',
          text1: t('ride.share_success_title', { defaultValue: 'Viaje compartido' }),
          text2: t('ride.share_success_body', { defaultValue: 'Podés dejar de compartir desde este viaje.' }),
          visibilityTime: 2500,
        });
      }
    } catch (err: unknown) {
      // Share.share rejects on iOS if user cancels — ignore that
      const message = err instanceof Error ? err.message : '';
      if (message !== 'User did not share') {
        Toast.show({ type: 'error', text1: t('ride.share_failed') });
      }
    } finally {
      setIsSharing(false);
    }
  }, [activeRide, t]);

  // ── Share revocation ──
  const [isRevoking, setIsRevoking] = useState(false);

  const handleRevokeShare = useCallback(async () => {
    if (!activeRide || !userId) return;
    setIsRevoking(true);
    try {
      await rideService.revokeShareToken(activeRide.id, userId);
      useRideStore.getState().setActiveRide({ ...activeRide, share_token: null });
      Toast.show({ type: 'success', text1: t('ride.share_revoked', { defaultValue: 'Se dejó de compartir' }) });
    } catch (err: unknown) {
      Toast.show({ type: 'error', text1: t('ride.share_revoke_failed', { defaultValue: 'Error al dejar de compartir' }) });
      logger.error('Failed to revoke share token', { error: String(err) });
    } finally {
      setIsRevoking(false);
    }
  }, [activeRide, userId, t]);

  // Safety sheet state
  const [safetySheetVisible, setSafetySheetVisible] = useState(false);

  // U2.3: Slide-up entrance animation for driver card
  const slideUpAnim = useRef(new Animated.Value(100)).current;

  useEffect(() => {
    if (rideWithDriver?.driver_name) {
      slideUpAnim.setValue(100);
      Animated.spring(slideUpAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 50,
        friction: 8,
      }).start();
    }
  }, [rideWithDriver?.driver_name, slideUpAnim]);

  // UBER-2.2: Emotional cancel context based on ride status.
  // Cancelling no longer charges money — a late cancel lowers the
  // rider's visible rating instead, so the contextual note now warns
  // about reputation rather than a CUP fee.
  const cancelContext = useMemo(() => {
    if (!activeRide) return { emotion: '', fee: '' };
    const willPenalize = !!ratingImpact?.rating_penalized;
    const note = willPenalize
      ? `· ${t('ride.cancel_rating_short', { defaultValue: 'baja tu calificación' })}`
      : '';
    if (activeRide.status === 'driver_en_route') return {
      emotion: t('ride.driver_coming', { defaultValue: 'Tu conductor ya viene en camino' }),
      fee: note,
    };
    if (activeRide.status === 'arrived_at_pickup') return {
      emotion: t('ride.driver_waiting', { defaultValue: 'Tu conductor te está esperando' }),
      fee: note,
    };
    return { emotion: '', fee: '' };
  }, [activeRide?.status, ratingImpact, t]);

  if (!activeRide) return null;

  // Bug fix: render ONLY the map picker when active. Mounting it as an
  // overlay on top of RideActiveView would put two Mapbox MapViews on
  // screen at once — on Android they fight for gestures and the picker
  // freezes (the same trap index.tsx documents for its 'selecting' step).
  if (mapPickerVisible) {
    return (
      <ConfirmLocationScreen
        mode="dropoff"
        initialLocation={activeRide.dropoff_location}
        onConfirm={(address, location) => {
          setMapPickerVisible(false);
          handleAddStop(address, location);
        }}
        onClose={() => setMapPickerVisible(false)}
      />
    );
  }

  const canCancel =
    activeRide.status === 'accepted' ||
    activeRide.status === 'driver_en_route' ||
    activeRide.status === 'arrived_at_pickup' ||
    activeRide.status === 'in_progress';

  const handleCall = () => {
    if (rideWithDriver?.driver_phone) {
      Linking.openURL(`tel:${rideWithDriver.driver_phone}`);
    }
  };

  const handleSOS = () => {
    triggerHaptic('heavy');
    Alert.alert(
      t('ride.sos_title'),
      t('ride.sos_body'),
      [
        { text: t('ride.sos_cancel'), style: 'cancel' },
        {
          text: t('ride.sos_call_emergency'),
          style: 'destructive',
          onPress: async () => {
            if (userId) {
              // Tres acciones SOS en paralelo:
              //   1. createSOSReport      → registra el incidente en DB
              //   2. broadcastEmergency   → SMS automático a trusted
              //                              contacts con auto_share=true
              //                              (vía edge function)
              //   3. Linking.openURL(tel) → línea cubana 106 (policía)
              // Antes solo se hacían (1) y (3) — los contactos de
              // confianza nunca recibían alerta automática (BUG-273
              // en safety roadmap). Ahora ambos lados (mobile + web)
              // disparan la misma cascada.
              incidentService.createSOSReport({
                ride_id: activeRide.id,
                reported_by: userId,
                // against_user_id is an FK to users(id). activeRide.driver_id is the
                // driver_profiles.id (NOT a users.id), which caused an FK violation
                // that failed the entire SOS insert ("SOS report failed"). Use the
                // driver's USER id.
                against_user_id: rideWithDriver?.driver_user_id ?? undefined,
                description: 'SOS activado por pasajero durante viaje',
              }).catch((err) => {
                logger.error('SOS report failed', { error: String(err) });
                Toast.show({ type: 'error', text1: t('errors.sos_report_failed', { ns: 'common' }) });
              });

              // Broadcast a trusted contacts en paralelo. Best-effort:
              // si falla NO bloquea la llamada al 106 — el botón rojo
              // siempre llama a emergencias incluso si el SMS broadcast
              // falla por red.
              // driverPosition = GPS vivo del vehículo (polled); el pickup es
              // solo fallback — un SOS a mitad de viaje debe apuntar a donde
              // está el vehículo, no a donde empezó.
              const lat = driverPosition?.latitude ?? activeRide.pickup_location?.latitude ?? 0;
              const lng = driverPosition?.longitude ?? activeRide.pickup_location?.longitude ?? 0;
              trustedContactService.broadcastEmergency({
                rideId: activeRide.id,
                latitude: lat,
                longitude: lng,
                driverName: rideWithDriver?.driver_name ?? null,
                vehiclePlate: rideWithDriver?.vehicle_plate ?? null,
                riderName: userFullName,
              }).then((res) => {
                if (res.contacts_notified > 0) {
                  Toast.show({
                    type: 'success',
                    text1: t('ride.sos_contacts_notified', {
                      count: res.contacts_notified,
                      defaultValue: `${res.contacts_notified} contactos avisados`,
                    }),
                  });
                } else {
                  // SF-02: contacts_notified===0 used to show NOTHING — the rider
                  // believed their contacts were alerted when they weren't. The
                  // emergency path must say so, so they fall back to calling 106.
                  Toast.show({
                    type: 'error',
                    text1: t('ride.sos_contacts_not_reached', {
                      defaultValue: 'No pudimos avisar a tus contactos. Llamá al 106.',
                    }),
                  });
                }
              }).catch((err) => {
                logger.error('SOS broadcast failed', { error: String(err) });
                // SF-02: even on a thrown error, warn the rider their contacts
                // were NOT reached (the tel:106 fallback still runs below).
                Toast.show({
                  type: 'error',
                  text1: t('ride.sos_contacts_not_reached', {
                    defaultValue: 'No pudimos avisar a tus contactos. Llamá al 106.',
                  }),
                });
              });
            }
            Linking.openURL('tel:106');
          },
        },
      ],
    );
  };

  const handleCancelPress = async () => {
    if (!userId) return;
    triggerHaptic('light');
    setPreviewLoading(true);
    try {
      // Project the rating impact of cancelling now. Returns a grace default
      // only when the RPC is genuinely absent; a transient error yields null
      // (unknown) so the sheet shows "couldn't compute" instead of "no penalty".
      const impact = activeRide
        ? await rideService.previewCancellationImpact(activeRide.id)
        : null;
      setRatingImpact(impact);
    } catch {
      setRatingImpact(null);
    } finally {
      setPreviewLoading(false);
      setCancelSheetVisible(true);
    }
  };

  const handleCancelConfirm = (reason: string) => {
    setCancelSheetVisible(false);
    cancelRide(reason);
  };

  // Delivery OTP (cargo rides). isCargoActive gates the OTP card so it shows
  // only while the package is in flight, not after completion/cancel.
  const isCargoActive = activeRide.ride_mode === 'cargo'
    && ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination'].includes(activeRide.status);

  const handleCopyOtp = async () => {
    if (!deliveryDetails?.delivery_otp) return;
    await Clipboard.setStringAsync(deliveryDetails.delivery_otp);
    Toast.show({ type: 'success', text1: t('delivery.otp_copied', { defaultValue: 'Código copiado' }) });
    triggerHaptic('light');
  };

  // Share the tracking link + 4-digit code in one message (WhatsApp/SMS) so
  // the recipient has everything to follow the ride and unlock drop-off.
  const handleShareDeliveryOtp = async () => {
    if (!activeRide.share_token || !deliveryDetails?.delivery_otp) return;
    const trackUrl = buildShareUrl(activeRide.share_token);
    const message = t('delivery.otp_share_message', {
      defaultValue: 'TriciGo: te envío un paquete. Sigue el viaje aquí: {{url}}\n\nCódigo para recibirlo: {{otp}}',
      url: trackUrl,
      otp: deliveryDetails.delivery_otp,
    });
    await Share.share({ message });
    triggerHaptic('light');
  };

  const statusMessage: Record<string, string> = {
    accepted: t('ride.driver_assigned'),
    driver_en_route: t('ride.driver_arriving'),
    arrived_at_pickup: t('ride.driver_arrived'),
    in_progress: t('ride.in_progress'),
    arrived_at_destination: t('ride.arrived_at_destination_title', { defaultValue: "You've arrived" }),
  };

  return (
    <View className="flex-1 pt-4">
      {/* Floating SOS button (4.1) — always visible during active ride */}
      <Pressable
        onPress={handleSOS}
        style={{
          position: 'absolute',
          top: insets.top + 12,
          right: 16,
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: '#DC2626',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          elevation: 8,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.3,
          shadowRadius: 4,
        }}
        accessibilityRole="button"
        accessibilityLabel={t('ride.sos_activate', { defaultValue: '¿Activar SOS?' })}
      >
        <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 16 }}>SOS</Text>
      </Pressable>

      {/* BUG-246: driver-GPS-unavailable consent modal. Driver reported
          their GPS as broken; rider decides whether to continue without
          GPS validation OR cancel the ride without penalty. */}
      {(activeRide as any).driver_gps_status === 'unavailable' && (
        <View style={{
          marginHorizontal: 16,
          marginTop: 12,
          marginBottom: 8,
          padding: 16,
          borderRadius: 16,
          backgroundColor: isDark ? 'rgba(239,68,68,0.12)' : '#FEF2F2',
          borderWidth: 1,
          borderColor: '#EF4444',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Ionicons name="warning" size={20} color="#EF4444" />
            <Text variant="body" style={{ fontWeight: '700', marginLeft: 8 }}>
              {t('ride.driver_no_gps_title', { defaultValue: 'Conductor sin GPS' })}
            </Text>
          </View>
          <Text variant="caption" color="secondary" className="mb-3">
            {t('ride.driver_no_gps_body', {
              defaultValue: `${rideWithDriver?.driver_name ?? 'Tu conductor'} nos avisó que su GPS no funciona. No podrás ver su ubicación en tiempo real ni el sistema validará automáticamente cuándo llega.`,
              driverName: rideWithDriver?.driver_name ?? 'Tu conductor',
            })}
          </Text>
          <Text variant="caption" color="tertiary" className="mb-3">
            {t('ride.driver_no_gps_options', {
              defaultValue: 'Podés continuar igual y coordinar por chat/llamada, o cancelar el viaje sin cargo.',
            })}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              title={t('ride.driver_no_gps_continue', { defaultValue: 'Continuar igual' })}
              size="md"
              onPress={async () => {
                if (!activeRide.id) return;
                try {
                  await rideService.riderRespondToGpsUnavailable(activeRide.id, true);
                  Toast.show({
                    type: 'success',
                    text1: t('ride.driver_no_gps_continued', { defaultValue: 'Confirmado' }),
                    text2: t('ride.driver_no_gps_continued_hint', { defaultValue: 'Coordiná con el conductor por chat' }),
                  });
                } catch (err) {
                  Toast.show({ type: 'error', text1: t('ride.driver_no_gps_failed', { defaultValue: 'No se pudo confirmar' }) });
                }
              }}
              style={{ flex: 1 }}
            />
            <Button
              title={t('ride.driver_no_gps_cancel', { defaultValue: 'Cancelar viaje' })}
              variant="outline"
              size="md"
              onPress={async () => {
                if (!activeRide.id) return;
                try {
                  await rideService.riderRespondToGpsUnavailable(activeRide.id, false);
                  Toast.show({
                    type: 'info',
                    text1: t('ride.driver_no_gps_canceled', { defaultValue: 'Viaje cancelado sin cargo' }),
                  });
                } catch (err) {
                  Toast.show({ type: 'error', text1: t('ride.driver_no_gps_failed', { defaultValue: 'No se pudo cancelar' }) });
                }
              }}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      )}

      {/* BUG-244: rider confirmation modal. Driver tried to advance ride
          but GPS placed them >100m from pickup/dropoff. We let the rider
          visually confirm "yes I see them" to bypass the GPS gate. */}
      {(activeRide as any).gps_override_requested_at && !(activeRide as any).gps_override_confirmed_at && (activeRide as any).driver_gps_status !== 'unavailable' && (
        <View style={{
          marginHorizontal: 16,
          marginTop: 12,
          marginBottom: 8,
          padding: 16,
          borderRadius: 16,
          backgroundColor: isDark ? 'rgba(255,77,0,0.12)' : '#FFF5F0',
          borderWidth: 1,
          borderColor: '#FF4D00',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <Ionicons name="navigate-circle" size={20} color="#FF4D00" />
            <Text variant="body" style={{ fontWeight: '700', marginLeft: 8 }}>
              {t('ride.gps_check_title', { defaultValue: '¿Tu conductor está acá?' })}
            </Text>
          </View>
          <Text variant="caption" color="secondary" className="mb-3">
            {t('ride.gps_check_body', {
              defaultValue: `${rideWithDriver?.driver_name ?? 'Tu conductor'} dice que llegó (${(activeRide as any).gps_check_distance_m ?? '?'}m según su GPS). Confirmá si lo ves cerca.`,
              driverName: rideWithDriver?.driver_name ?? 'Tu conductor',
              distance: (activeRide as any).gps_check_distance_m ?? '?',
            })}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              title={t('ride.gps_check_yes', { defaultValue: 'Sí, lo veo' })}
              size="md"
              onPress={async () => {
                if (!activeRide.id) return;
                try {
                  await rideService.riderConfirmDriverArrival(activeRide.id);
                  Toast.show({ type: 'success', text1: t('ride.gps_check_thanks', { defaultValue: 'Gracias, confirmado' }) });
                  // BUG-287 fix A — the RPC just flips a column; without a
                  // local refresh the modal stays open until the next 3 s
                  // poll catches the change. Refetch immediately and write
                  // to the store so the modal closes the instant the user
                  // taps the button.
                  if (userId) {
                    try {
                      const fresh = await rideService.getActiveRide(userId);
                      if (fresh) useRideStore.getState().updateRideFromRealtime(fresh);
                    } catch { /* polling will catch up within 3 s */ }
                  }
                } catch (err) {
                  Toast.show({ type: 'error', text1: t('ride.gps_check_failed', { defaultValue: 'No se pudo confirmar' }) });
                }
              }}
              style={{ flex: 1 }}
            />
            <Button
              title={t('ride.gps_check_no', { defaultValue: 'No lo veo' })}
              variant="outline"
              size="md"
              onPress={() => {
                Toast.show({
                  type: 'info',
                  text1: t('ride.gps_check_dismissed', { defaultValue: 'Le pedimos que se acerque más' }),
                });
              }}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      )}

      {/* Proximity banners */}
      {proximityAlert.showPickupBanner && (
        <ProximityBanner
          type="pickup"
          driverName={rideWithDriver?.driver_name}
          etaMinutes={displayEtaMinutes ?? 2}
          onDismiss={proximityAlert.dismissPickupBanner}
        />
      )}
      {proximityAlert.showDropoffBanner && (
        <ProximityBanner
          type="dropoff"
          etaMinutes={displayEtaMinutes ?? 2}
          onDismiss={proximityAlert.dismissDropoffBanner}
        />
      )}

      {/* Live map with route polyline */}
      <View style={{ position: 'relative' }}>
        <RideMapView
          pickupLocation={activeRide.pickup_location}
          dropoffLocation={activeRide.dropoff_location}
          driverLocation={driverPosition}
          driverHeading={driverPosition?.heading ?? null}
          driverMarkerOpacity={driverPosState.isCached ? 0.6 : 1}
          routeCoordinates={routeCoordinates}
          driverToPickupRoute={driverToPickupRoute}
          waypointLocations={waypointPoints}
          waypointStatuses={waypointStatuses}
          // BUG-267 v3: drive the Uber-style follow camera based on ride
          // status. RideMapView centers on the driver with state-specific
          // zoom/pitch/heading-up while activeRide.status is in
          // {accepted, driver_en_route, arrived_at_pickup, in_progress}.
          rideStatus={activeRide.status}
          // BUG-232: derive vehicleType from the ride's service_type so the
          // driver marker renders the correct vehicle icon (almendrón for
          // auto, triciclo, etc.) instead of the generic blue dot fallback.
          vehicleType={(() => {
            const slug = activeRide.service_type ?? '';
            if (slug.startsWith('auto_confort')) return 'confort';
            if (slug.startsWith('auto_')) return 'auto';
            if (slug.startsWith('moto_')) return 'moto';
            if (slug.startsWith('triciclo_')) return 'triciclo';
            return 'auto';
          })()}
          height={mapHeight}
        />
        {!driverPosition && (
          <View
            className="absolute inset-0 items-center justify-center bg-neutral-100/80 dark:bg-neutral-900/80"
            style={{ borderRadius: 12 }}
          >
            {positionTimeoutReached ? (
              <Text variant="caption" color="secondary" className="mt-2 px-4 text-center">
                {t('errors.waiting_driver_location', { ns: 'common', defaultValue: 'Esperando ubicación del conductor...' })}
              </Text>
            ) : (
              <>
                <ActivityIndicator size="small" color={isDark ? '#FB923C' : '#F97316'} />
                <Text variant="caption" color="secondary" className="mt-2">
                  {t('ride.loading_map', { defaultValue: 'Cargando mapa...' })}
                </Text>
              </>
            )}
          </View>
        )}
      </View>
      {/* Bug B — fixed action bar: Mensaje · Llamar · Seguridad.
           Sits between the map and the scrolling panel so it's always
           visible. Gated only on the active ride (NOT rideWithDriver),
           so the rider always has a prominent chat entry point. */}
      <TripActionBar
        unreadCount={unreadChatCount}
        callEnabled={!!rideWithDriver?.driver_phone}
        onChat={() => {
          markChatRead();
          router.push(`/chat/${activeRide.id}`);
        }}
        onCall={handleCall}
        onSafety={() => setSafetySheetVisible(true)}
      />
      {/* BUG-230: from here down, content scrolls inside its own
           ScrollView so the map above keeps full pan/zoom gestures.
           Outer Screen has scroll disabled for the 'active' flow. */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
      {/* Live-tracking state — UX: three overlapping banners (stale,
           last-seen, not-moving) used to cluster vertically with mixed
           messaging. Riders couldn't tell if any one of them was the
           "real" problem. Collapse to a single banner with priority:
             1. stuck       — highest urgency ("not moving 5+ min")
             2. stale       — position feed lagging
             3. cached-ok   — subtle "última actualización" when source
                              flipped to cache but freshness is fine
           so only one status message is ever visible and they compose
           into a clear hierarchy. */}
      {(() => {
        if (driverNotMoving) {
          return (
            <View
              className="flex-row items-center justify-center mx-4 mt-2 px-3 py-2 rounded-lg"
              style={{ backgroundColor: isDark ? '#92400E' : '#FEF3C7' }}
            >
              <Ionicons name="alert-circle-outline" size={16} color={isDark ? '#FDE68A' : '#92400E'} />
              <Text variant="caption" className="ml-1 font-semibold" style={{ color: isDark ? '#FDE68A' : '#92400E' }}>
                {t('ride.driver_not_moving', { defaultValue: 'Tu conductor no se ha movido en 5 minutos' })}
              </Text>
            </View>
          );
        }
        if (positionIsStale) {
          return (
            <View
              className="flex-row items-center justify-center mt-2 mx-4 px-3 py-2 rounded-lg"
              style={{ backgroundColor: isDark ? '#92400E' : '#FEF3C7' }}
            >
              <Ionicons name="warning-outline" size={16} color={isDark ? '#FDE68A' : '#92400E'} />
              <Text variant="caption" className="ml-1 font-semibold" style={{ color: isDark ? '#FDE68A' : '#92400E' }}>
                {t('ride.position_stale', { defaultValue: 'Posición desactualizada' })}
              </Text>
            </View>
          );
        }
        if (driverPosState.isCached && driverPosState.cachedAt) {
          return (
            <View className="items-center mt-1">
              <Text variant="caption" color="secondary" className="opacity-60">
                {t('ride.last_seen', {
                  time: formatTimeAgo(driverPosState.cachedAt),
                  defaultValue: 'Visto hace {{time}}',
                })}
              </Text>
            </View>
          );
        }
        return null;
      })()}

      <View className="h-3" />

      {/* BUG-236 (client): compact status stepper. Same redesign as the
          driver app. 5 small dots + only the CURRENT step label below. */}
      <View style={{
        backgroundColor: isDark ? 'rgba(255,77,0,0.08)' : 'rgba(255,77,0,0.06)',
        borderRadius: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginBottom: 16,
      }}>
        <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', marginBottom: 6 }}>
          {RIDE_STEPS.map((step, idx) => {
            const currentIdx = RIDE_STEPS.findIndex((s) => s.key === activeRide.status);
            const isPast = idx < currentIdx;
            const isCurrent = idx === currentIdx;
            return (
              <View
                key={step.key}
                style={{
                  width: isCurrent ? 24 : 8,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: isCurrent
                    ? '#FF4D00'
                    : isPast
                      ? (isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)')
                      : (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'),
                }}
              />
            );
          })}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 6 }}>
          <Text variant="bodySmall" style={{ fontWeight: '600' }}>
            {RIDE_STEPS.find((s) => s.key === activeRide.status)?.label ?? activeRide.status}
          </Text>
          <Text variant="caption" color="tertiary">
            · {RIDE_STEPS.findIndex((s) => s.key === activeRide.status) + 1}/{RIDE_STEPS.length}
          </Text>
        </View>
      </View>

      {/* Enhanced arrival animation (Phase 6) */}
      {activeRide.status === 'arrived_at_pickup' && !arrivalCardDismissed && (
        <>
          <ConfettiOverlay />
          <ArrivalCard
            driverName={rideWithDriver?.driver_name ?? ''}
            driverAvatarUrl={rideWithDriver?.driver_avatar_url}
            vehiclePlate={rideWithDriver?.vehicle_plate}
            vehicleDescription={
              [rideWithDriver?.vehicle_color, rideWithDriver?.vehicle_make, rideWithDriver?.vehicle_model]
                .filter(Boolean)
                .join(' ')
            }
            onDismiss={() => setArrivalCardDismissed(true)}
          />
        </>
      )}

      {/* Status message */}
      <Text
        variant="h4"
        className="text-center mb-3"
        accessibilityLiveRegion="assertive"
        accessibilityRole="alert"
      >
        {statusMessage[activeRide.status] ?? activeRide.status}
      </Text>

      {/* Trip Progress Bar — shown during in_progress and arrived_at_destination */}
      {tripProgress.isActive && (
        <View className="mb-4">
          <TripProgressBar
            progressPercent={tripProgress.progressPercent}
            distanceRemainingKm={tripProgress.distanceRemainingKm}
            etaMinutes={tripProgress.etaMinutes}
            arrivalTime={tripProgress.arrivalTime}
            isCalculating={isCalculating}
            distanceLabel={t('ride.trip_progress_remaining', { distance: tripProgress.distanceRemainingKm, defaultValue: '{{distance}} km restantes' })}
            etaLabel={tripProgress.etaMinutes != null
              ? (tripProgress.etaMinutes === 0
                ? t('ride.arriving', { defaultValue: 'Llegando' })
                : t('ride.trip_progress_eta', { minutes: tripProgress.etaMinutes, defaultValue: '~{{minutes}} min' }))
              : undefined}
            arrivalLabel={tripProgress.arrivalTime != null ? t('ride.trip_progress_arrival', { time: tripProgress.arrivalTime, defaultValue: 'Llegas ~{{time}}' }) : undefined}
          />
        </View>
      )}

      {/* ETA Badge — pre-pickup statuses (accepted, driver_en_route, arrived_at_pickup) */}
      {!tripProgress.isActive && displayEtaMinutes !== null && (
        <View className="items-center mb-4">
          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <ETABadge
              label={
                activeRide.status === 'arrived_at_pickup'
                  ? t('ride.eta_driver_arrived')
                  : activeRide.status === 'driver_en_route' && driverPosition && activeRide.pickup_location
                    ? t('ride.distance_eta_clock', {
                        distance: displayDistanceKm !== null ? displayDistanceKm.toFixed(1) : (haversineDistance(driverPosition, activeRide.pickup_location) / 1000).toFixed(1),
                        eta: displayEtaMinutes,
                        time: formatArrivalTime(displayEtaMinutes),
                      })
                    : t('ride.eta_driver_arriving', { minutes: displayEtaMinutes })
              }
              isCalculating={isCalculating}
              urgent={displayEtaMinutes > 0 && displayEtaMinutes <= 3}
              /* variant defaults to 'auto' — follows the OS theme so the
                 pill stays readable on dark mode (was a cream pill with
                 near-invisible text under the status stepper). */
            />
          </Animated.View>
        </View>
      )}

      {/* Destination arrival banner */}
      {showDestinationBanner && (
        <ArrivalBanner
          type="destination_arrival"
          onDismiss={() => setShowDestinationBanner(false)}
        />
      )}

      {/* Driver info — tappable to open profile */}
      {rideWithDriver?.driver_name && (
        <Animated.View className="mb-4" style={{ shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 5, transform: [{ translateY: slideUpAnim }] }}>
          <Pressable
            onPress={() => rideWithDriver.driver_user_id && router.push(`/driver-profile/${rideWithDriver.driver_user_id}`)}
            accessibilityRole="button"
            accessibilityLabel={t('ride.view_driver_profile', { defaultValue: 'View driver profile' })}
          >
          <DriverCard
            driverName={rideWithDriver.driver_name}
            driverAvatarUrl={rideWithDriver.driver_avatar_url}
            driverRating={driverExpanded ? rideWithDriver.driver_rating : null}
            driverTotalRides={driverExpanded ? rideWithDriver.driver_total_rides : null}
            vehicleMake={rideWithDriver.vehicle_make}
            vehicleModel={rideWithDriver.vehicle_model}
            vehicleColor={rideWithDriver.vehicle_color}
            vehiclePlate={rideWithDriver.vehicle_plate}
            vehiclePhotoUrl={rideWithDriver.vehicle_photo_url}
            vehicleYear={driverExpanded ? rideWithDriver.vehicle_year : null}
            ridesLabel={t('ride.driver_rides_count', { count: rideWithDriver.driver_total_rides ?? 0, defaultValue: '{{count}} viajes' }).replace(/^\d+\s*/, '')}
          />
          </Pressable>
          {/* I4.1: See more / See less toggle — min 44px touch target */}
          <Pressable
            onPress={() => {
              // UX: match the receipt-actions expander from R2 — a light
              // haptic on every tap confirms the toggle landed even when
              // the content shift is subtle (adding a single "year" row).
              triggerHaptic('light');
              setDriverExpanded(!driverExpanded);
            }}
            style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center' }}
            accessibilityRole="button"
          >
            <Text variant="caption" color="accent" className="text-center">
              {driverExpanded ? t('ride.see_less') : t('ride.see_more')}
            </Text>
          </Pressable>
        </Animated.View>
      )}

      {/* Share trip button */}
      <Pressable
        onPress={handleShareTrip}
        disabled={isSharing}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          paddingVertical: 12,
          paddingHorizontal: 16,
          marginHorizontal: 16,
          marginBottom: 12,
          borderRadius: 12,
          backgroundColor: isDark ? 'rgba(59,130,246,0.1)' : 'rgba(59,130,246,0.08)',
          opacity: isSharing ? 0.6 : 1,
        }}
        accessibilityRole="button"
        accessibilityLabel={t('ride.share_trip')}
      >
        <Ionicons name="share-outline" size={18} color={isDark ? '#93C5FD' : '#3B82F6'} />
        <Text style={{
          color: isDark ? '#93C5FD' : '#3B82F6',
          fontSize: 14,
          fontWeight: '600',
          marginLeft: 8,
        }}>
          {t('ride.share_trip')}
        </Text>
      </Pressable>

      {/* Shared trip indicator + stop sharing */}
      {activeRide.share_token && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 8, gap: 12 }}>
          <Text style={{
            color: isDark ? '#9CA3AF' : '#6B7280',
            fontSize: 12,
          }}>
            <Ionicons name="link-outline" size={12} /> {t('ride.trip_shared')}
          </Text>
          <Pressable
            onPress={handleRevokeShare}
            disabled={isRevoking}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('ride.stop_sharing', { defaultValue: 'Dejar de compartir' })}
          >
            <Text style={{
              color: isDark ? '#FCA5A5' : '#EF4444',
              fontSize: 12,
              fontWeight: '600',
            }}>
              {isRevoking ? '...' : t('ride.stop_sharing', { defaultValue: 'Dejar de compartir' })}
            </Text>
          </Pressable>
        </View>
      )}

      {/* Route info — pickup + dropoff (paradas abajo en el nuevo StopsList) */}
      <Card variant="outlined" padding="md" className="mb-4">
        <RouteSummary
          pickupAddress={activeRide.pickup_address}
          dropoffAddress={activeRide.dropoff_address}
          pickupLabel={t('ride.pickup')}
          dropoffLabel={t('ride.dropoff')}
        />
      </Card>

      {/* Delivery OTP — cargo rides: the customer shares this 4-digit code
          with the recipient; the driver asks for it at drop-off. Mirrors
          app/ride/[id].tsx so the code is reachable from the active view too. */}
      {isCargoActive && deliveryDetails?.delivery_otp && (
        <Card variant="elevated" padding="lg" className="mb-4">
          <View className="flex-row items-center mb-2">
            <Ionicons name="cube" size={18} color="#FF4D00" />
            <Text variant="label" className="ml-2">
              {t('delivery.share_with_recipient', { defaultValue: 'Comparte con el destinatario' })}
            </Text>
          </View>
          <Text variant="caption" color="secondary" className="mb-2">
            {t('delivery.otp_helper', {
              defaultValue: 'El conductor pedirá este código al destinatario para confirmar la entrega.',
            })}
          </Text>
          <Pressable
            onPress={handleCopyOtp}
            className="rounded-lg py-4 mb-3 items-center"
            style={{ backgroundColor: isDark ? 'rgba(255,77,0,0.12)' : 'rgba(255,77,0,0.08)' }}
            accessibilityRole="button"
            accessibilityLabel={t('delivery.otp_copy', { defaultValue: 'Copiar código' })}
          >
            <Text variant="h1" color="accent" className="font-bold" style={{ letterSpacing: 8 }}>
              {deliveryDetails.delivery_otp}
            </Text>
            <Text variant="caption" color="secondary" className="mt-1">
              {t('delivery.tap_to_copy', { defaultValue: 'Toca para copiar' })}
            </Text>
          </Pressable>
          {activeRide.share_token && (
            <Button
              title={t('delivery.share_link_and_otp', { defaultValue: 'Compartir enlace y código' })}
              onPress={handleShareDeliveryOtp}
              size="lg"
              fullWidth
            />
          )}
          {deliveryDetails.recipient_name && (
            <View
              className="flex-row justify-between mt-3 pt-3 border-t"
              style={{ borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}
            >
              <Text variant="caption" color="secondary">
                {t('delivery.recipient', { defaultValue: 'Destinatario' })}
              </Text>
              <Text variant="caption" className="font-semibold">{deliveryDetails.recipient_name}</Text>
            </View>
          )}
        </Card>
      )}

      {/* Lista de paradas — Cuban Modern, no emojis. */}
      {waypoints.length > 0 && (
        <View className="mb-4">
          <StopsList
            mode={isDark ? 'dark' : 'light'}
            stops={waypoints.map((wp) => ({
              id: wp.id,
              sort_order: wp.sort_order,
              address: wp.address,
              arrived_at: wp.arrived_at,
              departed_at: wp.departed_at,
            }))}
            /* Durante in_progress, el backend bloquea eliminar paradas
             * que ya fueron visitadas. El filtrado adicional lo hace
             * el propio StopsList internamente (solo muestra × en
             * stops sin arrived_at ni departed_at). */
          />
        </View>
      )}

      {/* Add stop button (only during active trip, max 3 stops) */}
      {activeRide.status === 'in_progress' && waypoints.length < 3 && (
        <View className="mb-4">
          <Button
            title={t('ride.add_stop', { defaultValue: 'Agregar parada' })}
            variant="outline"
            size="md"
            fullWidth
            onPress={() => setAddStopVisible(true)}
          />
        </View>
      )}

      {/* Fare.
          BUG-293 (Round 3): cash and corporate rides settle in CUP, only
          payment_method='tricicoin' actually denominates in TRC. The
          previous version used formatTRC() universally and fell back to
          estimated_fare_cup when estimated_fare_trc was null — so the user
          saw "1,440 TRC" on a ride they paid 1,440 CUP for. Replicates the
          pattern already in RideCompleteView (lines ~209-212). */}
      {(() => {
        const showTrc = activeRide.payment_method === 'tricicoin';
        const fareTrc = activeRide.estimated_fare_trc;
        const fareCup = activeRide.estimated_fare_cup;
        const fareDisplay =
          showTrc && fareTrc != null
            ? formatTRC(fareTrc)
            : formatCUP(fareCup ?? 0);
        return (
          <View
            className="flex-row justify-between items-center mb-6 px-2"
            accessible={true}
            accessibilityLabel={t('a11y.fare_amount', { ns: 'common', amount: fareDisplay })}
          >
            <Text variant="bodySmall" color="secondary">{t('ride.estimated_fare')}</Text>
            <Text variant="h4" color="accent">{fareDisplay}</Text>
          </View>
        );
      })()}

      {/* Cancel button */}
      {canCancel && (
        <>
          <Button
            title={t('ride.cancel_ride')}
            variant="outline"
            size="lg"
            fullWidth
            onPress={handleCancelPress}
            loading={previewLoading}
          />
          {/* UBER-2.2: Emotional cancel context */}
          {cancelContext.emotion !== '' && (
            <View className="px-4 mt-2">
              <Text variant="caption" color="secondary" className="text-center">
                {cancelContext.emotion} {cancelContext.fee}
              </Text>
            </View>
          )}
        </>
      )}

      </ScrollView>
      {/* End of BUG-230 ScrollView. BottomSheets below render as overlays
           outside the scroll container. */}

      {/* Add-stop sheet — a SINGLE BottomSheet that swaps between the search
          step and the confirm step off `pendingStop`. Keeping one Modal
          mounted (instead of closing one and opening another in the same tick)
          avoids the present-while-dismissing race that made the confirm step
          flicker or fail to appear. */}
      <BottomSheet
        visible={addStopVisible || !!pendingStop}
        onClose={() => { setAddStopVisible(false); setPendingStop(null); }}
      >
        {pendingStop ? (
          /* Confirm step — fare delta preview */
          <View>
            <Text variant="h4" className="mb-2">
              {t('ride.confirm_stop_title', { defaultValue: '¿Agregar esta parada?' })}
            </Text>
            <Text variant="body" color="secondary" className="mb-4" numberOfLines={2}>
              {pendingStop.address}
            </Text>

            <View className="bg-surface-elev rounded-2xl p-4 mb-4">
              <View className="flex-row justify-between items-center mb-2">
                <Text variant="caption" color="secondary">
                  {t('ride.extra_distance', { defaultValue: 'Distancia adicional' })}
                </Text>
                {/* Bugfix: Text doesn't support a `weight` prop. Use
                    a className with Tailwind font-weight utilities so
                    the bold renders instead of being silently dropped. */}
                <Text variant="body" className="font-semibold">
                  +{pendingStop.extraDistanceKm.toFixed(1)} km
                </Text>
              </View>
              <View className="flex-row justify-between items-center">
                <Text variant="caption" color="secondary">
                  {t('ride.extra_fare', { defaultValue: 'Tarifa adicional estimada' })}
                </Text>
                <Text variant="body" className="font-bold text-primary-600">
                  {/* BUG-293: extra_fare is CUP-denominated (field name says
                      so). Was using formatTRC which labelled it as TRC. */}
                  +{formatCUP(pendingStop.extraFareCup)}
                </Text>
              </View>
            </View>

            <Text variant="caption" color="secondary" className="mb-4 text-center">
              {t('ride.confirm_stop_note', {
                defaultValue: 'Es una estimación. El total final se calcula según la ruta real.',
              })}
            </Text>

            {/* Each Button sits in a flex-1 View rather than relying on Button's
                fullWidth (= w-full), so the two buttons share the row and never
                overflow on a 320px screen. */}
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Button
                  title={t('common.cancel', { defaultValue: 'Cancelar' })}
                  variant="outline"
                  size="md"
                  onPress={() => setPendingStop(null)}
                  disabled={addingStop}
                  fullWidth
                />
              </View>
              <View className="flex-1">
                <Button
                  title={t('ride.confirm_add_stop', { defaultValue: 'Confirmar parada' })}
                  variant="primary"
                  size="md"
                  onPress={confirmAddStop}
                  loading={addingStop}
                  fullWidth
                />
              </View>
            </View>
          </View>
        ) : (
          /* Search step — address lookup */
          <>
            <Text variant="h4" className="mb-3">
              {t('ride.add_stop', { defaultValue: 'Agregar parada' })}
            </Text>
            <AddressSearchInput
              placeholder={t('ride.search_address', { defaultValue: 'Buscar dirección...' })}
              onSelect={handleAddStop}
              onPickOnMap={() => { setAddStopVisible(false); setMapPickerVisible(true); }}
            />
            {estimatingStop && (
              <View className="flex-row items-center justify-center mt-3">
                <ActivityIndicator size="small" />
                <Text variant="caption" color="secondary" className="ml-2">
                  {t('ride.estimating_stop', { defaultValue: 'Calculando costo adicional...' })}
                </Text>
              </View>
            )}
          </>
        )}
      </BottomSheet>

      {/* Cancel ride bottom sheet */}
      <CancelRideSheet
        visible={cancelSheetVisible}
        onClose={() => setCancelSheetVisible(false)}
        onConfirm={handleCancelConfirm}
        isLoading={isLoading}
        ratingImpact={ratingImpact}
        previewLoading={previewLoading}
        rideStatus={activeRide?.status ?? null}
      />

      {/* Safety bottom sheet. driverId is used ONLY for incident_reports.against_user_id
          (FK -> users.id), so we pass the driver's USER id (rideWithDriver.driver_user_id),
          NOT activeRide.driver_id which is the driver_profiles.id and breaks the FK. */}
      <SafetySheet
        visible={safetySheetVisible}
        onClose={() => setSafetySheetVisible(false)}
        rideId={activeRide.id}
        driverId={rideWithDriver?.driver_user_id ?? null}
        userId={userId!}
        driverPhone={rideWithDriver?.driver_phone ?? null}
        riderName={userFullName}
        driverName={rideWithDriver?.driver_name ?? null}
        vehiclePlate={rideWithDriver?.vehicle_plate ?? null}
        latitude={driverPosition?.latitude ?? activeRide.pickup_location?.latitude ?? 0}
        longitude={driverPosition?.longitude ?? activeRide.pickup_location?.longitude ?? 0}
      />
    </View>
  );
}
