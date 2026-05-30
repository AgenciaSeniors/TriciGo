/**
 * DriverTripView — orchestrator (PR-B Midnight Ember tokens landed).
 *
 * The 1549-LOC monolith was split in PR-A into focused subcomponents
 * under `apps/driver/src/components/trip/` plus three hooks under
 * `apps/driver/src/hooks/`. PR-B replaces every inline hex literal,
 * `<Card forceDark>` legacy and `bg-[#1a1a2e]` Tailwind class with
 * `midnightEmber.*` tokens — the same system already adopted by
 * IncomingRideCard (PR #90) and HomeBottomSheet (PR #91).
 *
 * Key collapses applied here:
 *   - The 5-hex `actionButtonColor` rainbow (blue / orange / green /
 *     purple / red per status) becomes a clean intensity scale on the
 *     accent family + `state.success` for `arrived_at_destination`.
 *     The driver no longer has to learn 5 separate semantic colors
 *     mid-ride.
 *   - The 5-rgba `stepperTint` rainbow becomes a single uniform
 *     `accent.glow` tint, since the active dot color already changes
 *     by phase and conveys the position information.
 *   - Inline banners (no-show, arriving-at-waypoint, scheduled,
 *     chained) all migrate to the semantic state tokens.
 *
 * Microcopy unification + redundancy trim land in PR-C.
 */
import React, { useEffect, useRef, useCallback, useState } from 'react';
import { View, Pressable, Linking, Alert, Animated, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { DraggableSheet } from '@tricigo/ui/DraggableSheet';
import {
  formatCUP,
  formatTRC,
  triggerHaptic,
  haversineDistance,
} from '@tricigo/utils';
import type { GeoPoint } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import {
  incidentService,
  deliveryService,
  rideService,
  getSupabaseClient,
} from '@tricigo/api';
import type { DeliveryDetails } from '@tricigo/api';
import { useDriverRideStore } from '@/stores/ride.store';
import { useDriverRideActions } from '@/hooks/useDriverRide';
import { useRoutePolyline } from '@/hooks/useRoutePolyline';
import { useLiveDriverRoute } from '@/hooks/useLiveDriverRoute';
import { useRiderLocation } from '@/hooks/useRiderLocation';
import { useDriverStore } from '@/stores/driver.store';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';
import { useDriverETA } from '@/hooks/useDriverETA';
// Round 5: ETABadge integrated into the hero block at the top of the sheet
// — the standalone import is no longer needed. The label/urgent logic was
// status-coded inline so dropping the component cleanly removes one nesting
// layer without losing the info.
// import { ETABadge } from '@tricigo/ui/ETABadge';
import { useInAppNavigation } from '@/hooks/useInAppNavigation';
import { useVoiceGuidancePref } from '@/hooks/useVoiceGuidancePref';
import { NavigationOverlay } from '@/components/NavigationOverlay';
import { useLocationStore } from '@/stores/location.store';
import { useDriverProximityAlert } from '@/hooks/useDriverProximityAlert';
import { midnightEmber } from '@tricigo/theme';
import { DeliveryPhotoSheet } from './DeliveryPhotoSheet';
import { useTripAutoNavigation } from '@/hooks/useTripAutoNavigation';
import { useNearDropoffPulse } from '@/hooks/useNearDropoffPulse';
import { useWaypointProximity } from '@/hooks/useWaypointProximity';
import { LiveDistanceHint } from './trip/LiveDistanceHint';
import { GpsConsentBanner } from './trip/GpsConsentBanner';
import { TripStepper } from './trip/TripStepper';
import { RouteInfoCard } from './trip/RouteInfoCard';
import { RiderPreferencesChips } from './trip/RiderPreferencesChips';
import { DeliveryDetailsCard } from './trip/DeliveryDetailsCard';
import { TripActionToolbar } from './trip/TripActionToolbar';
import { TripBadgesRow } from './trip/TripBadgesRow';
import { WaitTimer } from './trip/WaitTimer';
import { TripCompleteView } from './trip/TripCompleteView';
import type { RideStatus } from '@tricigo/types';

// ─── Local helpers (kept here because they're tightly coupled to the
// orchestrator's internal model of trip status) ─────────────────────

function useTripSteps() {
  const { t } = useTranslation('driver');
  return [
    { key: 'accepted', label: t('trip.step_accepted', { defaultValue: 'Aceptado' }) },
    { key: 'driver_en_route', label: t('trip.step_en_route', { defaultValue: 'En camino' }) },
    { key: 'arrived_at_pickup', label: t('trip.step_arrived', { defaultValue: 'Llegué' }) },
    { key: 'in_progress', label: t('trip.step_in_progress', { defaultValue: 'En viaje' }) },
    { key: 'arrived_at_destination', label: t('trip.step_at_destination', { defaultValue: 'En destino' }) },
    { key: 'completed', label: t('trip.step_completed', { defaultValue: 'Listo' }) },
  ];
}

function useActionLabels(): Partial<Record<RideStatus, string>> {
  const { t } = useTranslation('driver');
  // PR-C microcopy: dropped the verbose action labels in favour of a more
  // conversational "compañero de ruta" tone that fits the Cuban brand
  // voice. The verbs stay sentence-case because the buttons themselves
  // already provide the visual emphasis.
  return {
    accepted: t('trip.action_en_route', { defaultValue: 'Voy en camino' }),
    driver_en_route: t('trip.action_arrived', { defaultValue: 'Llegué al pasajero' }),
    arrived_at_pickup: t('trip.action_start', { defaultValue: 'Iniciar viaje' }),
    in_progress: t('trip.action_arrived_destination', { defaultValue: 'Llegué' }),
    arrived_at_destination: t('trip.action_finish', { defaultValue: 'Finalizar' }),
  };
}

// ─── Map data hook (exported, used by the parent for map rendering) ──

/** Expose trip map data for the parent to render the map behind the sheet */
export function useActiveTripMapData() {
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const isPickupPhase = activeTrip?.status === 'accepted' || activeTrip?.status === 'driver_en_route';
  const isOnTripPhase = activeTrip?.status === 'in_progress' || activeTrip?.status === 'arrived_at_destination';
  const riderLocation = useRiderLocation(activeTrip?.id, isPickupPhase);
  const driverLatMap = useLocationStore((s) => s.latitude);
  const driverLngMap = useLocationStore((s) => s.longitude);
  const driverLocationMap = driverLatMap != null && driverLngMap != null
    ? { latitude: driverLatMap, longitude: driverLngMap }
    : null;

  // 00341: subscribe to passenger-added waypoints so the polyline +
  // StopMarkers update in real-time as the rider edits the route. Initial
  // fetch is reconciled with subscription via a Set merge (same pattern as
  // DriverTripView component's own subscription). Without this, the driver
  // map kept showing the straight pickup→dropoff polyline and ignored stops.
  const [mapWaypoints, setMapWaypoints] = useState<GeoPoint[]>([]);
  const [mapWaypointStatuses, setMapWaypointStatuses] = useState<
    Array<'pending' | 'current' | 'completed'>
  >([]);
  useEffect(() => {
    if (!activeTrip?.id) {
      setMapWaypoints([]);
      setMapWaypointStatuses([]);
      return;
    }
    let cancelled = false;
    const refresh = (list: Array<{
      latitude: number;
      longitude: number;
      arrived_at?: string | null;
      departed_at?: string | null;
      sort_order: number;
    }>) => {
      if (cancelled) return;
      const sorted = [...list].sort((a, b) => a.sort_order - b.sort_order);
      setMapWaypoints(sorted.map((w) => ({ latitude: w.latitude, longitude: w.longitude })));
      // Status mapping: the next not-departed waypoint is "current",
      // earlier ones are "completed", later ones are "pending". This
      // mirrors how the client app pulses the next stop on its map.
      const nextIdx = sorted.findIndex((w) => !w.departed_at);
      setMapWaypointStatuses(sorted.map((w, idx) => {
        if (w.departed_at) return 'completed';
        if (idx === nextIdx) return 'current';
        return 'pending';
      }));
    };

    rideService.getRideWaypoints(activeTrip.id).then((wps) => {
      const flat = (wps as any[]).map((w: any) => ({
        latitude: w.latitude ?? w.location?.latitude ?? 0,
        longitude: w.longitude ?? w.location?.longitude ?? 0,
        arrived_at: w.arrived_at ?? null,
        departed_at: w.departed_at ?? null,
        sort_order: w.sort_order ?? 0,
      })).filter((w) => Number.isFinite(w.latitude) && Number.isFinite(w.longitude));
      refresh(flat);
    }).catch(() => { /* silent — empty waypoints is fine */ });

    return () => { cancelled = true; };
  }, [activeTrip?.id]);

  // BUG-283 — live route from driver to current target (pickup during
  // pickup phase, dropoff during the trip). Refetches on >50 m deviation
  // with a 5 s min interval, so when the driver takes a parallel street
  // the polyline catches up within seconds. Replaces the old combo of
  // `useRoutePolyline(driverLocation, target)` + `useRoutePolyline(pickup,
  // dropoff)` fallback + a never-started `useInAppNavigation` instance —
  // that combo refetched on every GPS sample (cache-busting itself) or
  // stayed glued to the original line, depending on OSRM rate-limit.
  //
  // Fallback to the static pickup→dropoff polyline only used to fill the
  // initial frame before the first live fetch returns, so the user
  // always has SOME context to see.
  const legTo = isPickupPhase
    ? (activeTrip?.pickup_location ?? null)
    : (activeTrip?.dropoff_location ?? null);
  const liveLegRoute = useLiveDriverRoute(driverLocationMap, legTo, !!legTo);
  // 00341: pass waypoints so the full pickup→dropoff polyline includes the
  // detour. The legRoute (driver→nextTarget) is still the primary display,
  // but during in_progress when driver passed pickup, the fallback route
  // must reflect the new waypoints — otherwise the user sees a straight
  // line behind their current position that ignores the stops.
  const fullRoute = useRoutePolyline(
    activeTrip?.pickup_location ?? null,
    activeTrip?.dropoff_location ?? null,
    mapWaypoints.length > 0 ? mapWaypoints : undefined,
  );
  // Prefer the live driver→leg polyline once it has at least one road
  // segment (≥ 4 points). Until OSRM responds the first time, fall back
  // to the full pickup→dropoff line so the map isn't blank.
  const routeCoordinates =
    liveLegRoute && liveLegRoute.length >= 4 ? liveLegRoute : fullRoute;
  const inAppNavMap = useInAppNavigation(driverLocationMap);

  // BUG-218 (UX): markers visible at all phases EXCEPT when driver is so
  // close to pickup that they share the same pixel on screen. In that case
  // the auto icon already conveys "I'm at the pickup", and showing the
  // green pickup circle on top would just hide the auto.
  void isOnTripPhase;
  const driverNearPickup =
    !!driverLocationMap &&
    !!activeTrip?.pickup_location &&
    haversineDistance(
      { latitude: driverLocationMap.latitude, longitude: driverLocationMap.longitude },
      { latitude: activeTrip.pickup_location.latitude, longitude: activeTrip.pickup_location.longitude },
    ) < 30; // meters

  return {
    pickupLocation: driverNearPickup ? null : (activeTrip?.pickup_location ?? null),
    dropoffLocation: activeTrip?.dropoff_location ?? null,
    riderLocation: isPickupPhase ? riderLocation : null,
    routeCoordinates: inAppNavMap.isNavigating && inAppNavMap.routeCoordinates.length > 0
      ? inAppNavMap.routeCoordinates.map(([lat, lng]: [number, number]) => ({ latitude: lat, longitude: lng }))
      : routeCoordinates,
    // 00341: expose to the parent wrapper so RideMapView can render
    // numbered StopMarker components for each passenger-added stop.
    waypointLocations: mapWaypoints,
    waypointStatuses: mapWaypointStatuses,
  };
}

// ─── Main component ──────────────────────────────────────────────────

export function DriverTripView() {
  const { t } = useTranslation('driver');
  // useResponsive carried `isTablet` in the original component but the
  // value was never read; keep the hook call to preserve its
  // subscription side-effects verbatim.
  useResponsive();
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const driverProfile = useDriverStore((s) => s.profile);
  const { advanceStatus, cancelTrip, isAdvancing } = useDriverRideActions();

  // ── Subscribe to rider's real-time location during pickup phase ──
  // The hook's internal effect keeps the realtime channel alive while
  // the trip view is mounted; the returned location is also fetched
  // independently by `useActiveTripMapData` for the parent's map.
  const isPickupPhase = activeTrip?.status === 'accepted' || activeTrip?.status === 'driver_en_route';
  useRiderLocation(activeTrip?.id, isPickupPhase);

  // ── Local waypoint state (subscribe + initial fetch) ──
  type LocalWaypoint = {
    id: string;
    address: string;
    sort_order: number;
    latitude: number;
    longitude: number;
    arrived_at?: string | null;
    departed_at?: string | null;
  };
  const [waypoints, setWaypoints] = useState<LocalWaypoint[]>([]);
  const [waypointLoading, setWaypointLoading] = useState<string | null>(null);

  // ── Cargo / delivery state ──
  const isDeliveryRide = activeTrip?.ride_mode === 'cargo';
  const [deliveryDetails, setDeliveryDetails] = useState<DeliveryDetails | null>(null);
  const [pickupPhotoUploaded, setPickupPhotoUploaded] = useState(false);
  const [deliveryPhotoUploaded, setDeliveryPhotoUploaded] = useState(false);
  const needsPickupPhoto =
    isDeliveryRide && activeTrip?.status === 'arrived_at_pickup' && !pickupPhotoUploaded;
  const needsDeliveryPhoto =
    isDeliveryRide && activeTrip?.status === 'in_progress' && !deliveryPhotoUploaded;

  // ── Misc ──
  const lastAdvancePressRef = useRef(0);

  // ── Driver location ──
  const driverLat = useLocationStore((s) => s.latitude);
  const driverLng = useLocationStore((s) => s.longitude);
  const driverLocation = driverLat != null && driverLng != null
    ? { latitude: driverLat, longitude: driverLng }
    : null;

  // ── In-app navigation (with TTS voice guidance toggle) ──
  const [voiceGuidanceEnabled, setVoiceGuidanceEnabled] = useVoiceGuidancePref();
  const inAppNav = useInAppNavigation(driverLocation, voiceGuidanceEnabled);

  // ── Driver proximity haptic alert ──
  useDriverProximityAlert(
    activeTrip?.pickup_location ?? null,
    activeTrip?.status ?? null,
  );

  // ── Phase 3: Camera follow-mode ──
  // The local `followMode` state was driven from inAppNav.isNavigating in
  // the original implementation but never read anywhere — preserved
  // verbatim because removing it would change the render-trigger model
  // for any code that still relies on this component re-rendering when
  // navigation state flips.
  const [, setFollowMode] = useState(false);
  useEffect(() => {
    setFollowMode(inAppNav.isNavigating);
  }, [inAppNav.isNavigating]);

  // ── Fetch delivery details for cargo rides ──
  useEffect(() => {
    if (!isDeliveryRide || !activeTrip?.id) return;
    deliveryService.getDeliveryDetails(activeTrip.id)
      .then(setDeliveryDetails)
      .catch((err) => console.error(
        '[DriverTripView] Failed to load delivery details',
        err instanceof Error ? err.message : 'unknown',
      ));
  }, [isDeliveryRide, activeTrip?.id]);

  // ── Subscribe to waypoints first, then fetch (avoids race condition
  //    where a waypoint inserted between fetch and subscribe would be
  //    missed) ──
  useEffect(() => {
    if (!activeTrip) return;

    const channel = rideService.subscribeToWaypoints(
      activeTrip.id,
      (newWp) => {
        const w = newWp as any;
        const flat: LocalWaypoint = {
          id: w.id,
          address: w.address,
          sort_order: w.sort_order,
          latitude: w.latitude ?? w.location?.latitude ?? 0,
          longitude: w.longitude ?? w.location?.longitude ?? 0,
          arrived_at: w.arrived_at ?? null,
          departed_at: w.departed_at ?? null,
        };
        setWaypoints((prev) => {
          if (prev.some((p) => p.id === flat.id)) return prev;
          return [...prev, flat];
        });
        Alert.alert('', t('trip.new_stop_added', { defaultValue: 'El pasajero agregó una parada' }));
      },
      (updatedWp) => {
        const w = updatedWp as any;
        const flat: LocalWaypoint = {
          id: w.id,
          address: w.address,
          sort_order: w.sort_order,
          latitude: w.latitude ?? w.location?.latitude ?? 0,
          longitude: w.longitude ?? w.location?.longitude ?? 0,
          arrived_at: w.arrived_at ?? null,
          departed_at: w.departed_at ?? null,
        };
        setWaypoints((prev) =>
          prev.map((wp) => (wp.id === flat.id ? { ...wp, ...flat } : wp)),
        );
      },
    );

    rideService.getRideWaypoints(activeTrip.id)
      .then((wps) => setWaypoints((prev) => {
        const flatWps: LocalWaypoint[] = (wps as any[]).map((w: any) => ({
          id: w.id,
          address: w.address,
          sort_order: w.sort_order,
          latitude: w.latitude ?? w.location?.latitude ?? 0,
          longitude: w.longitude ?? w.location?.longitude ?? 0,
          arrived_at: w.arrived_at ?? null,
          departed_at: w.departed_at ?? null,
        }));
        const fetchedIds = new Set(flatWps.map((w) => w.id));
        const subscriptionOnly = prev.filter((w) => !fetchedIds.has(w.id));
        return [...flatWps, ...subscriptionOnly];
      }))
      .catch(() => {});

    return () => {
      const supabase = getSupabaseClient();
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrip?.id]);

  // Next incomplete waypoint (not yet departed)
  const nextWaypoint = waypoints.find((wp) => !wp.departed_at);
  const isAtWaypoint = !!nextWaypoint?.arrived_at && !nextWaypoint?.departed_at;

  // ── Auto-navigation (auto-start + auto-retarget) — extracted to hook ──
  useTripAutoNavigation({
    rideId: activeTrip?.id,
    status: activeTrip?.status,
    pickupLocation: activeTrip?.pickup_location ?? null,
    dropoffLocation: activeTrip?.dropoff_location ?? null,
    nextWaypoint: nextWaypoint
      ? {
          id: nextWaypoint.id,
          latitude: nextWaypoint.latitude,
          longitude: nextWaypoint.longitude,
          arrived_at: nextWaypoint.arrived_at ?? null,
        }
      : null,
    driverLocation,
    inAppNav: {
      isNavigating: inAppNav.isNavigating,
      isLoading: inAppNav.isLoading,
      startNavigation: inAppNav.startNavigation,
    },
  });

  const handleArriveAtWaypoint = useCallback(async () => {
    if (!nextWaypoint) return;
    setWaypointLoading(nextWaypoint.id);
    try {
      await rideService.arriveAtWaypoint(nextWaypoint.id);
      setWaypoints((prev) =>
        prev.map((wp) => (wp.id === nextWaypoint.id ? { ...wp, arrived_at: new Date().toISOString() } : wp)),
      );
      triggerHaptic('light');
    } catch {
      Alert.alert('', t('trip.status_update_failed'));
    } finally {
      setWaypointLoading(null);
    }
  }, [nextWaypoint, t]);

  const handleDepartFromWaypoint = useCallback(async () => {
    if (!nextWaypoint) return;
    setWaypointLoading(nextWaypoint.id);
    try {
      await rideService.departFromWaypoint(nextWaypoint.id);
      setWaypoints((prev) =>
        prev.map((wp) => (wp.id === nextWaypoint.id ? { ...wp, departed_at: new Date().toISOString() } : wp)),
      );
      triggerHaptic('light');
    } catch {
      Alert.alert('', t('trip.status_update_failed'));
    } finally {
      setWaypointLoading(null);
    }
  }, [nextWaypoint, t]);

  // ── Waypoint proximity (auto-arrival) — extracted to hook ──
  const { nearWaypoint } = useWaypointProximity({
    rideId: activeTrip?.id,
    status: activeTrip?.status,
    nextWaypoint: nextWaypoint
      ? {
          id: nextWaypoint.id,
          sort_order: nextWaypoint.sort_order,
          latitude: nextWaypoint.latitude,
          longitude: nextWaypoint.longitude,
        }
      : null,
    driverLocation,
    onAutoArrive: handleArriveAtWaypoint,
  });

  // ── Near-dropoff proximity + pulse — extracted to hook ──
  const { nearDropoff, pulseAnim } = useNearDropoffPulse({
    rideId: activeTrip?.id,
    status: activeTrip?.status,
    dropoffLocation: activeTrip?.dropoff_location,
    driverLocation,
    hasPendingWaypoint: !!nextWaypoint,
  });

  const debouncedAdvanceStatus = useCallback(() => {
    const now = Date.now();
    if (now - lastAdvancePressRef.current < 1000) return;
    lastAdvancePressRef.current = now;
    triggerHaptic('medium');
    advanceStatus();
  }, [advanceStatus]);

  const TRIP_STEPS = useTripSteps();
  const ACTION_LABELS = useActionLabels();
  const { etaMinutes, isCalculating } = useDriverETA({
    pickupLocation: activeTrip?.pickup_location ?? null,
    dropoffLocation: activeTrip?.dropoff_location ?? null,
    rideStatus: activeTrip?.status ?? null,
  });

  // PR-B: action color per phase collapses from a 5-hue rainbow into a
  // single accent-intensity scale. The progression `accent[300]` →
  // `[500]` → `[600]` → `[700]` mirrors the trip's mounting urgency,
  // and `arrived_at_destination` jumps to `state.success` because the
  // driver is one tap from finishing — that's the only justified break
  // out of the accent family.
  const actionButtonColor = (() => {
    switch (activeTrip?.status) {
      case 'accepted': return midnightEmber.accent[300];
      case 'driver_en_route': return midnightEmber.accent[500];
      case 'arrived_at_pickup': return midnightEmber.accent[600];
      case 'in_progress': return midnightEmber.accent[700];
      case 'arrived_at_destination': return midnightEmber.state.success;
      default: return midnightEmber.accent[500];
    }
  })();

  // PR-B: the 5-rgba `stepperTint` rainbow collapses into one uniform
  // accent glow. The stepper already conveys phase via the active dot
  // color (which shares the same accent intensity scale), so the
  // container background no longer needs to encode status.
  const stepperTint = midnightEmber.map.bg.surface;

  if (!activeTrip) return null;

  // Completed state
  if (activeTrip.status === 'completed') {
    return <TripCompleteView />;
  }

  const canCancel =
    activeTrip.status === 'accepted' ||
    activeTrip.status === 'driver_en_route' ||
    activeTrip.status === 'arrived_at_pickup';

  const actionLabel = ACTION_LABELS[activeTrip.status];

  // Navigation target: pickup when heading to passenger, then next waypoint, then dropoff
  const navTarget =
    activeTrip.status === 'accepted' || activeTrip.status === 'driver_en_route'
      ? activeTrip.pickup_location
      : nextWaypoint && !nextWaypoint.arrived_at
        ? { latitude: nextWaypoint.latitude, longitude: nextWaypoint.longitude }
        : activeTrip.dropoff_location;

  // Live distance hint target type — pickup or dropoff
  const liveHintTargetType: 'pickup' | 'dropoff' =
    activeTrip.status === 'driver_en_route' || activeTrip.status === 'accepted'
      ? 'pickup'
      : 'dropoff';
  const liveHintTarget =
    liveHintTargetType === 'pickup'
      ? activeTrip.pickup_location
      : (activeTrip.status === 'in_progress' || activeTrip.status === 'arrived_at_destination')
        ? activeTrip.dropoff_location
        : null;

  const handleSOS = () => {
    if (Platform.OS === 'web') {
      const confirmed = window.confirm(
        `${t('trip.sos_title')}\n\n${t('trip.sos_body')}`,
      );
      if (confirmed) {
        if (driverProfile?.user_id) {
          incidentService.createSOSReport({
            ride_id: activeTrip.id,
            reported_by: driverProfile.user_id,
            against_user_id: activeTrip.customer_id,
            description: 'SOS activado por conductor durante viaje',
          }).catch(() => {});
        }
        Linking.openURL('tel:106');
      }
      return;
    }
    Alert.alert(
      t('trip.sos_title'),
      t('trip.sos_body'),
      [
        { text: t('trip.sos_cancel'), style: 'cancel' },
        {
          text: t('trip.sos_call_emergency'),
          style: 'destructive',
          onPress: async () => {
            if (driverProfile?.user_id) {
              incidentService.createSOSReport({
                ride_id: activeTrip.id,
                reported_by: driverProfile.user_id,
                against_user_id: activeTrip.customer_id,
                description: 'SOS activado por conductor durante viaje',
              }).catch(() => { /* best-effort: SOS report, phone call is primary */ });
            }
            Linking.openURL('tel:106');
          },
        },
      ],
    );
  };

  const handleCancel = () => {
    if (Platform.OS === 'web') {
      // Alert.alert buttons don't work on web — use window.confirm
      const confirmed = window.confirm(
        `${t('trip.cancel_title')}\n\n${t('trip.cancel_body')}`,
      );
      if (confirmed) cancelTrip('Cancelado por el conductor');
      return;
    }
    Alert.alert(
      t('trip.cancel_title'),
      t('trip.cancel_body'),
      [
        { text: t('trip.sos_cancel'), style: 'cancel' },
        {
          text: t('trip.cancel_confirm'),
          style: 'destructive',
          onPress: () => cancelTrip('Cancelado por el conductor'),
        },
      ],
    );
  };

  return (
    <DraggableSheet
      // Round 5: smaller default sheet so the map dominates the view
      // (Uber-style). Previous: ['25%', '55%', '90%'] @ index 1 (55%)
      // gave only ~45% of the viewport to the map — too cramped on
      // mid-range Pixels. New: ['20%', '38%', '90%'] @ index 1 (38%)
      // recovers ~135px of map. The 90% snap is preserved for chat /
      // detailed actions when the driver pulls up.
      snapPoints={['20%', '38%', '90%']}
      initialIndex={1}
      theme="dark"
      scrollable
      onChange={(_index: number) => {
        // Could track sheet position for analytics
      }}
    >
      {/* UX: on web, the NavigationOverlay is absolutely positioned at top:0 z:50
          and overlaps the DraggableSheet (which on web is a fixed bottom panel
          with maxHeight 85%). Shift the sheet content down when nav is active
          so the primary action button stays tappable. On native, the sheet is
          a proper bottom drawer — no overlap, so padding only applies to web. */}
      {Platform.OS === 'web' && inAppNav.isNavigating && (
        <View style={{ height: 180 }} aria-hidden />
      )}

      {/* 0. Navigation overlay (when in-app nav active) */}
      {inAppNav.isNavigating && (
        <NavigationOverlay
          currentStep={inAppNav.currentStep}
          nextStep={inAppNav.nextStep}
          remainingDistance_m={inAppNav.remainingDistance_m}
          remainingDuration_s={inAppNav.remainingDuration_s}
          isRerouting={inAppNav.isRerouting}
          onStop={inAppNav.stopNavigation}
          destinationLabel={
            activeTrip.status === 'driver_en_route' || activeTrip.status === 'accepted'
              ? `Pickup: ${activeTrip.pickup_address}`
              : `Destino: ${nextWaypoint?.address || activeTrip.dropoff_address}`
          }
          voiceEnabled={voiceGuidanceEnabled}
          onToggleVoice={() => setVoiceGuidanceEnabled(!voiceGuidanceEnabled)}
        />
      )}

      {/* Round 5: stepper moved to TOP of the sheet so the driver
          glances down once and sees: where they are in the flow → who/
          what is next → CTA. Was buried after the action button + a
          dozen banners. */}
      <TripStepper
        steps={TRIP_STEPS}
        currentStatus={activeTrip.status}
        activeDotColor={actionButtonColor}
        tintBackground={stepperTint}
      />

      {/* Round 5: status-aware HERO block. Replaces the standalone
          ETABadge (which was floating below the action button and added
          one more banner). All key info — ETA, primary address, wait
          timer when applicable — lives here. */}
      <View
        style={{
          marginBottom: 12,
          paddingVertical: 12,
          paddingHorizontal: 14,
          backgroundColor: midnightEmber.map.bg.elevated,
          borderRadius: midnightEmber.radius.sheet,
          borderWidth: 1,
          borderColor: midnightEmber.map.line.hairline,
          borderTopColor: midnightEmber.map.line.strong,
        }}
      >
        {(() => {
          const status = activeTrip.status;
          const isToPickup = status === 'accepted' || status === 'driver_en_route';
          const isAtPickup = status === 'arrived_at_pickup';
          const isOnTrip = status === 'in_progress';
          const isAtDest = status === 'arrived_at_destination';
          // Primary line: status-specific summary
          let primary: string;
          if (isToPickup) {
            primary = etaMinutes !== null
              ? t('trip.eta_driver_to_pickup', { minutes: etaMinutes, defaultValue: `~${etaMinutes} min al pickup` })
              : t('trip.heading_to_pickup', { defaultValue: 'En camino al pickup' });
          } else if (isAtPickup) {
            primary = t('trip.eta_driver_arrived', { defaultValue: 'Llegaste al pickup' });
          } else if (isOnTrip) {
            primary = etaMinutes !== null
              ? t('trip.eta_to_destination', { minutes: etaMinutes, defaultValue: `~${etaMinutes} min al destino` })
              : t('trip.heading_to_destination', { defaultValue: 'En camino al destino' });
          } else if (isAtDest) {
            primary = t('trip.arrived_at_destination', { defaultValue: 'Llegaste al destino' });
          } else {
            primary = t('trip.in_progress', { defaultValue: 'Viaje activo' });
          }
          // Secondary line: relevant address (pickup or dropoff)
          const secondaryAddress = (isToPickup || isAtPickup)
            ? activeTrip.pickup_address
            : activeTrip.dropoff_address;
          return (
            <>
              <Text
                variant="h4"
                style={{
                  color: midnightEmber.map.text.primary,
                  fontWeight: '700',
                  marginBottom: 4,
                }}
                numberOfLines={1}
              >
                {primary}
              </Text>
              {secondaryAddress ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Ionicons
                    name="location-outline"
                    size={14}
                    color={midnightEmber.map.text.tertiary}
                  />
                  <Text
                    variant="bodySmall"
                    style={{ color: midnightEmber.map.text.secondary, flex: 1 }}
                    numberOfLines={1}
                  >
                    {secondaryAddress}
                  </Text>
                </View>
              ) : null}
              {/* WaitTimer renders INSIDE the hero block now during
                  arrived_at_pickup — it's the most prominent info while
                  the rider is on the curb. */}
              {isAtPickup && activeTrip.driver_arrived_at ? (
                <View style={{ marginTop: 8 }}>
                  <WaitTimer arrivedAt={activeTrip.driver_arrived_at} freeMinutes={5} />
                </View>
              ) : null}
            </>
          );
        })()}
      </View>

      {/* BUG-244 polish: live distance hint + GPS health detection. */}
      <LiveDistanceHint
        driverLocation={driverLocation}
        target={liveHintTarget ?? null}
        targetType={liveHintTargetType}
      />

      {/* 1. Action button — color-coded by phase, always visible at top */}
      {actionLabel && !(activeTrip.status === 'in_progress' && nextWaypoint) && !needsDeliveryPhoto && !needsPickupPhoto && (
        <Animated.View style={{ transform: [{ scale: nearDropoff ? pulseAnim : 1 }], marginBottom: 8 }}>
          <Button
            title={actionLabel}
            size="lg"
            fullWidth
            onPress={debouncedAdvanceStatus}
            loading={isAdvancing}
            disabled={isAdvancing}
            style={{ backgroundColor: actionButtonColor, minHeight: 56 }}
          />
        </Animated.View>
      )}

      {/* BUG-246: GPS unavailable + rider consent state */}
      <GpsConsentBanner
        rideId={activeTrip.id}
        driverLocation={driverLocation}
        driverGpsStatus={activeTrip.driver_gps_status}
        rideStatus={activeTrip.status}
      />

      {/* Waypoint action buttons (arrive / depart) */}
      {activeTrip.status === 'in_progress' && nextWaypoint && !isAtWaypoint && (
        <Button
          title={t('trip.arrive_at_stop', { n: nextWaypoint.sort_order, defaultValue: `Llegué a Parada ${nextWaypoint.sort_order}` })}
          variant="outline"
          size="lg"
          fullWidth
          forceDark
          onPress={handleArriveAtWaypoint}
          loading={waypointLoading === nextWaypoint.id}
          className="mb-2"
        />
      )}
      {activeTrip.status === 'in_progress' && isAtWaypoint && nextWaypoint && (
        <Button
          title={t('trip.depart_from_stop', { n: nextWaypoint.sort_order, defaultValue: `Continuar desde Parada ${nextWaypoint.sort_order}` })}
          size="lg"
          fullWidth
          onPress={handleDepartFromWaypoint}
          loading={waypointLoading === nextWaypoint.id}
          className="mb-2"
        />
      )}

      {/* Pickup photo required when arriving at pickup for cargo ride */}
      {needsPickupPhoto && (
        <DeliveryPhotoSheet
          rideId={activeTrip.id}
          phase="pickup"
          onPhotoUploaded={() => {
            setPickupPhotoUploaded(true);
          }}
          recipientName={deliveryDetails?.recipient_name}
          recipientPhone={deliveryDetails?.recipient_phone}
          specialInstructions={deliveryDetails?.special_instructions}
        />
      )}

      {/* Delivery photo required before completing a cargo ride */}
      {needsDeliveryPhoto && !nextWaypoint && (
        <DeliveryPhotoSheet
          rideId={activeTrip.id}
          phase="delivery"
          onPhotoUploaded={() => {
            setDeliveryPhotoUploaded(true);
            // Auto-advance to complete after photo upload
            debouncedAdvanceStatus();
          }}
          recipientName={deliveryDetails?.recipient_name}
          recipientPhone={deliveryDetails?.recipient_phone}
          specialInstructions={deliveryDetails?.special_instructions}
        />
      )}

      {/* Cancel — lower visual hierarchy than the primary action */}
      {canCancel && (
        <Button
          title={t('trip.cancel_trip')}
          variant="outline"
          size="md"
          fullWidth
          forceDark
          onPress={handleCancel}
          className="mb-2 opacity-80"
        />
      )}

      {/* 2. Bottom toolbar — navigate / compass / chat / SOS */}
      <TripActionToolbar
        navTarget={navTarget ?? null}
        inAppNavActive={inAppNav.isNavigating}
        onStartInAppNav={inAppNav.startNavigation}
        onSOS={handleSOS}
        rideId={activeTrip.id}
      />

      {/* Chained ride banner */}
      {activeTrip.next_ride_id && (
        <View
          style={{
            backgroundColor: `${midnightEmber.state.info}1F`, // ~12% tint
            borderColor: `${midnightEmber.state.info}66`, // ~40%
            borderWidth: 1,
            borderRadius: midnightEmber.radius.card,
            paddingVertical: 10,
            paddingHorizontal: 14,
            marginBottom: 12,
            flexDirection: 'row',
            alignItems: 'center',
          }}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          <Ionicons name="link-outline" size={18} color={midnightEmber.state.info} />
          <Text
            variant="bodySmall"
            style={{ marginLeft: 8, flex: 1, color: midnightEmber.state.info }}
          >
            {t('trip.next_ride_queued', { defaultValue: 'Proximo viaje asignado' })}
          </Text>
        </View>
      )}

      {/* Round 5: stepper, ETABadge, and WaitTimer all moved into the
          hero block at the top of the sheet. The standalone components
          are gone — their content lives in the same visual zone now. */}

      {/* No-show button — appears after 5 min wait */}
      {activeTrip.status === 'arrived_at_pickup' && activeTrip.driver_arrived_at &&
        Math.floor((Date.now() - new Date(activeTrip.driver_arrived_at).getTime()) / 60000) >= 5 && (
        <Pressable
          style={{
            backgroundColor: midnightEmber.state.warning,
            borderRadius: midnightEmber.radius.card,
            paddingVertical: 14,
            paddingHorizontal: 24,
            marginHorizontal: 16,
            marginBottom: 8,
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onPress={() => cancelTrip('passenger_no_show')}
          accessibilityRole="button"
          accessibilityLabel={`${t('trip.passenger_no_show')} — ${t('trip.cancel_no_show')}`}
        >
          <Text
            variant="body"
            style={{ color: midnightEmber.map.text.onAccent, fontWeight: '700' }}
          >
            {t('trip.passenger_no_show')} — {t('trip.cancel_no_show')}
          </Text>
        </Pressable>
      )}

      {/* DE-2.1: Arriving at waypoint banner */}
      {nearWaypoint && nextWaypoint && (
        <View
          style={{
            backgroundColor: `${midnightEmber.state.success}1F`,
            padding: 10,
            borderRadius: midnightEmber.radius.input,
            marginBottom: 6,
            borderWidth: 1,
            borderColor: midnightEmber.map.line.hairline,
          }}
        >
          <Text
            variant="caption"
            style={{ color: midnightEmber.state.success, textAlign: 'center' }}
          >
            {t('trip.arriving_waypoint', { n: nextWaypoint.sort_order })}
          </Text>
        </View>
      )}

      {/* 7. Route info (pickup / dropoff / waypoints) */}
      <RouteInfoCard
        status={activeTrip.status}
        pickupAddress={activeTrip.pickup_address}
        dropoffAddress={activeTrip.dropoff_address}
        waypoints={waypoints}
        nextLegAddress={nextWaypoint?.address ?? null}
      />

      {/* Scheduled ride banner */}
      {activeTrip.scheduled_at && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: `${midnightEmber.state.info}1F`,
            borderColor: midnightEmber.map.line.hairline,
            borderWidth: 1,
            borderRadius: midnightEmber.radius.card,
            paddingVertical: 8,
            paddingHorizontal: 12,
            marginBottom: 12,
          }}
        >
          <Ionicons name="time-outline" size={16} color={midnightEmber.state.info} />
          <Text
            variant="bodySmall"
            style={{ marginLeft: 8, color: midnightEmber.state.info }}
          >
            {t('home.scheduled_at', { time: new Date(activeTrip.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
          </Text>
        </View>
      )}

      {/* 9. Rider preferences (collapsible) */}
      <RiderPreferencesChips preferences={activeTrip.rider_preferences as any} />

      {/* 10. Delivery details (cargo) */}
      {isDeliveryRide && <DeliveryDetailsCard details={deliveryDetails} />}

      {/* Cargo + Corporate badges */}
      <TripBadgesRow
        isCargo={activeTrip.service_type === 'triciclo_cargo'}
        isCorporate={!!activeTrip.corporate_account_id}
      />

      {/* Fare — only visible during accepted (hidden while driving;
          completed has its own view) */}
      {activeTrip.status === 'accepted' && (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
            paddingHorizontal: 8,
          }}
          accessible
          accessibilityLabel={t('a11y.fare_amount', { ns: 'common', amount: formatCUP(activeTrip.estimated_fare_cup) })}
        >
          <Text
            variant="bodySmall"
            style={{ color: midnightEmber.map.text.tertiary }}
          >
            {t('trip.earned', { defaultValue: 'Vas a ganar' })}
          </Text>
          <View style={{ alignItems: 'flex-end' }}>
            <Text
              variant="h4"
              style={{ color: midnightEmber.accent[500] }}
            >
              {formatCUP(activeTrip.estimated_fare_cup)}
            </Text>
            {activeTrip.estimated_fare_trc != null && (
              <Text
                variant="caption"
                style={{ color: midnightEmber.map.text.tertiary }}
              >
                ~{formatTRC(activeTrip.estimated_fare_trc)}
              </Text>
            )}
          </View>
        </View>
      )}

      {/* PR-C: surge indicator removed from the active-trip view. The
          driver already saw the surge multiplier in the IncomingRideCard
          before accepting; repeating it during the drive adds noise.
          The post-trip TripCompleteView still shows it as part of the
          earnings breakdown so the surge stays visible where it
          actually matters (the receipt). */}

    </DraggableSheet>
  );
}
