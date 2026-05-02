import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { View, Pressable, Linking, Alert, Animated, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { DraggableSheet } from '@tricigo/ui/DraggableSheet';
import { formatCUP, formatTRC, generateReceiptHTML, triggerHaptic, haversineDistance } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { incidentService, walletService, deliveryService, driverService, trackValidationEvent } from '@tricigo/api';
import type { DeliveryDetails } from '@tricigo/api';
import { useDriverRideStore } from '@/stores/ride.store';
import { useDriverRideActions } from '@/hooks/useDriverRide';
import { useRoutePolyline } from '@/hooks/useRoutePolyline';
import { useLiveDriverRoute } from '@/hooks/useLiveDriverRoute';
import { useRiderLocation } from '@/hooks/useRiderLocation';
import { useDriverStore } from '@/stores/driver.store';
import { openNavigation } from '@/utils/navigation';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';
import { useDriverETA } from '@/hooks/useDriverETA';
import { ETABadge } from '@tricigo/ui/ETABadge';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useInAppNavigation } from '@/hooks/useInAppNavigation';
import { useVoiceGuidancePref } from '@/hooks/useVoiceGuidancePref';
import { NavigationOverlay } from '@/components/NavigationOverlay';
import { useLocationStore } from '@/stores/location.store';
import { useDriverProximityAlert } from '@/hooks/useDriverProximityAlert';
import { RiderRatingSheet } from './RiderRatingSheet';
import { ExcessDistanceSheet } from './ExcessDistanceSheet';
import { DeliveryPhotoSheet } from './DeliveryPhotoSheet';
import { rideService, getSupabaseClient } from '@tricigo/api';
import type { RideStatus, RideWithRider } from '@tricigo/types';

/** Wait timer shown when driver has arrived and is waiting for passenger */
function WaitTimer({ arrivedAt, freeMinutes }: { arrivedAt: string; freeMinutes: number }) {
  const { t } = useTranslation('driver');
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const arrived = new Date(arrivedAt).getTime();
    if (isNaN(arrived)) return;
    const update = () => setElapsed(Math.floor((Date.now() - arrived) / 1000));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [arrivedAt]);

  // HF-3: Guard against invalid arrivedAt date
  const arrivedTime = new Date(arrivedAt).getTime();
  if (isNaN(arrivedTime)) return null;

  const elapsedMin = Math.floor(elapsed / 60);
  const elapsedSec = elapsed % 60;
  const isFree = elapsedMin < freeMinutes;
  const billableMin = Math.max(0, elapsedMin - freeMinutes);

  return (
    <View className={`rounded-2xl p-3 mb-3 items-center border border-white/[0.06] ${isFree ? 'bg-green-900/30' : 'bg-red-900/30'}`}>
      <Text variant="caption" color="inverse" className="opacity-60 mb-1">
        {t('trip.waiting_passenger', { defaultValue: 'Esperando al pasajero' })}
      </Text>
      <Text variant="h3" color="inverse" className="font-mono">
        {String(elapsedMin).padStart(2, '0')}:{String(elapsedSec).padStart(2, '0')}
      </Text>
      {isFree ? (
        <Text variant="caption" style={{ color: '#10B981' }} className="mt-1">
          {t('trip.wait_free', { defaultValue: 'Gratis' })} ({freeMinutes - elapsedMin} min)
        </Text>
      ) : (
        <Text variant="caption" style={{ color: '#EF4444' }} className="mt-1 font-semibold">
          {t('trip.wait_charging', { defaultValue: 'Cobrando espera' })} +{billableMin} min
        </Text>
      )}
    </View>
  );
}

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
  return {
    accepted: t('trip.action_en_route', { defaultValue: 'En camino al pasajero' }),
    driver_en_route: t('trip.action_arrived', { defaultValue: 'Llegué al punto de recogida' }),
    arrived_at_pickup: t('trip.action_start', { defaultValue: 'Iniciar viaje' }),
    in_progress: t('trip.action_arrived_destination', { defaultValue: 'Llegué al destino' }),
    arrived_at_destination: t('trip.action_finish', { defaultValue: 'Finalizar viaje' }),
  };
}

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
  const fullRoute = useRoutePolyline(
    activeTrip?.pickup_location ?? null,
    activeTrip?.dropoff_location ?? null,
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
  };
}

export function DriverTripView() {
  const { t } = useTranslation('driver');
  const { isTablet } = useResponsive();
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const driverProfile = useDriverStore((s) => s.profile);
  const { advanceStatus, cancelTrip, clearCompletedTrip, isAdvancing } = useDriverRideActions();

  // Subscribe to rider's real-time location during pickup phase
  const isPickupPhase = activeTrip?.status === 'accepted' || activeTrip?.status === 'driver_en_route';
  const riderLocation = useRiderLocation(activeTrip?.id, isPickupPhase);
  type LocalWaypoint = { id: string; address: string; sort_order: number; latitude: number; longitude: number; arrived_at?: string | null; departed_at?: string | null };
  const [waypoints, setWaypoints] = useState<LocalWaypoint[]>([]);
  const [waypointLoading, setWaypointLoading] = useState<string | null>(null);
  const [prefsExpanded, setPrefsExpanded] = useState(false);
  const [routeExpanded, setRouteExpanded] = useState(false);
  // DE-2.1: Auto-detect waypoint arrival
  const [nearWaypoint, setNearWaypoint] = useState(false);
  // DE-2.2: Pulsing button near dropoff
  const [nearDropoff, setNearDropoff] = useState(false);
  // Delivery photo state (2-photo flow: pickup + delivery)
  const [pickupPhotoUploaded, setPickupPhotoUploaded] = useState(false);
  const [deliveryPhotoUploaded, setDeliveryPhotoUploaded] = useState(false);
  const isDeliveryRide = activeTrip?.ride_mode === 'cargo';
  const [deliveryDetails, setDeliveryDetails] = useState<DeliveryDetails | null>(null);
  const needsPickupPhoto = isDeliveryRide && activeTrip?.status === 'arrived_at_pickup' && !pickupPhotoUploaded;
  const needsDeliveryPhoto = isDeliveryRide && activeTrip?.status === 'in_progress' && !deliveryPhotoUploaded;
  const lastAdvancePressRef = useRef(0);
  const nearDropoffTrackedRef = useRef(false);
  const prevNearDropoffRef = useRef(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // In-app navigation (with TTS voice guidance toggle)
  const driverLat = useLocationStore((s) => s.latitude);
  const driverLng = useLocationStore((s) => s.longitude);
  const driverLocation = driverLat != null && driverLng != null
    ? { latitude: driverLat, longitude: driverLng }
    : null;
  const [voiceGuidanceEnabled, setVoiceGuidanceEnabled] = useVoiceGuidancePref();
  const inAppNav = useInAppNavigation(driverLocation, voiceGuidanceEnabled);

  // ── Driver proximity haptic alert ──
  useDriverProximityAlert(
    activeTrip?.pickup_location ?? null,
    activeTrip?.status ?? null,
  );

  // ── Phase 3: Camera follow-mode ──
  const [followMode, setFollowMode] = useState(false);
  const heading = useLocationStore((s) => s.heading);

  // Enable follow mode when navigation activates
  useEffect(() => {
    setFollowMode(inAppNav.isNavigating);
  }, [inAppNav.isNavigating]);

  // ── Phase 2: Auto-start navigation when ride is accepted ──
  const autoNavStartedRef = useRef(false);

  useEffect(() => {
    autoNavStartedRef.current = false;
  }, [activeTrip?.id]);

  useEffect(() => {
    if (!activeTrip || !driverLocation || inAppNav.isNavigating || inAppNav.isLoading) return;
    if (autoNavStartedRef.current) return;

    const status = activeTrip.status;
    if ((status === 'accepted' || status === 'driver_en_route') && activeTrip.pickup_location) {
      autoNavStartedRef.current = true;
      inAppNav.startNavigation(activeTrip.pickup_location);
    }
  }, [activeTrip?.id, activeTrip?.status, !!driverLocation, inAppNav.isNavigating, inAppNav.isLoading]);

  // Fetch delivery details for cargo rides
  useEffect(() => {
    if (!isDeliveryRide || !activeTrip?.id) return;
    deliveryService.getDeliveryDetails(activeTrip.id)
      .then(setDeliveryDetails)
      .catch((err) => console.error('[DriverTripView] Failed to load delivery details', err instanceof Error ? err.message : 'unknown'));
  }, [isDeliveryRide, activeTrip?.id]);

  // Subscribe to waypoints first, then fetch (avoids race condition where a
  // waypoint inserted between fetch and subscribe would be missed)
  useEffect(() => {
    if (!activeTrip) return;

    // Subscribe first so we don't miss any events during the fetch
    const channel = rideService.subscribeToWaypoints(
      activeTrip.id,
      (newWp) => {
        const w = newWp as any;
        const flat: LocalWaypoint = { id: w.id, address: w.address, sort_order: w.sort_order, latitude: w.latitude ?? w.location?.latitude ?? 0, longitude: w.longitude ?? w.location?.longitude ?? 0, arrived_at: w.arrived_at ?? null, departed_at: w.departed_at ?? null };
        setWaypoints((prev) => {
          if (prev.some((p) => p.id === flat.id)) return prev;
          return [...prev, flat];
        });
        Alert.alert('', t('trip.new_stop_added', { defaultValue: 'El pasajero agregó una parada' }));
      },
      (updatedWp) => {
        const w = updatedWp as any;
        const flat: LocalWaypoint = { id: w.id, address: w.address, sort_order: w.sort_order, latitude: w.latitude ?? w.location?.latitude ?? 0, longitude: w.longitude ?? w.location?.longitude ?? 0, arrived_at: w.arrived_at ?? null, departed_at: w.departed_at ?? null };
        setWaypoints((prev) =>
          prev.map((wp) => (wp.id === flat.id ? { ...wp, ...flat } : wp)),
        );
      },
    );

    // Then fetch existing waypoints (merge with any that arrived via subscription)
    rideService.getRideWaypoints(activeTrip.id)
      .then((wps) => setWaypoints((prev) => {
        const flatWps: LocalWaypoint[] = (wps as any[]).map((w: any) => ({ id: w.id, address: w.address, sort_order: w.sort_order, latitude: w.latitude ?? w.location?.latitude ?? 0, longitude: w.longitude ?? w.location?.longitude ?? 0, arrived_at: w.arrived_at ?? null, departed_at: w.departed_at ?? null }));
        const fetchedIds = new Set(flatWps.map((w) => w.id));
        const subscriptionOnly = prev.filter((w) => !fetchedIds.has(w.id));
        return [...flatWps, ...subscriptionOnly];
      }))
      .catch(() => {});

    return () => {
      const supabase = getSupabaseClient();
      supabase.removeChannel(channel);
    };
  }, [activeTrip?.id]);

  // Next incomplete waypoint (not yet departed)
  const nextWaypoint = waypoints.find((wp) => !wp.departed_at);
  const isAtWaypoint = nextWaypoint?.arrived_at && !nextWaypoint?.departed_at;

  // ── Phase 2: Auto-retarget navigation to dropoff when trip starts ──
  const autoRetargetRef = useRef(false);

  useEffect(() => {
    autoRetargetRef.current = false;
  }, [activeTrip?.id]);

  useEffect(() => {
    if (!activeTrip || activeTrip.status !== 'in_progress' || !driverLocation) return;
    if (inAppNav.isNavigating || inAppNav.isLoading) return;
    if (autoRetargetRef.current) return;

    const target = (nextWaypoint && !nextWaypoint.arrived_at)
      ? { latitude: nextWaypoint.latitude, longitude: nextWaypoint.longitude }
      : activeTrip.dropoff_location;

    if (target) {
      autoRetargetRef.current = true;
      inAppNav.startNavigation(target);
    }
  }, [activeTrip?.status, !!driverLocation, inAppNav.isNavigating, inAppNav.isLoading, nextWaypoint?.id]);

  const handleArriveAtWaypoint = async () => {
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
  };

  const handleDepartFromWaypoint = async () => {
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
  };

  // DE-2.1: Auto-detect waypoint arrival by GPS proximity
  useEffect(() => {
    if (activeTrip?.status !== 'in_progress' || !nextWaypoint || !driverLocation) {
      setNearWaypoint(false);
      return;
    }

    const dist = haversineDistance(
      driverLocation,
      { latitude: nextWaypoint.latitude, longitude: nextWaypoint.longitude },
    );

    if (dist < 100) {
      setNearWaypoint(true);
    } else {
      setNearWaypoint(false);
    }

    if (dist < 50) {
      Toast.show({ type: 'info', text1: t('trip.auto_arriving', { defaultValue: 'Marcando llegada automáticamente...' }), visibilityTime: 3000 });
      const timeout = setTimeout(() => {
        trackValidationEvent('driver_waypoint_auto_arrived', {
          waypoint_sort_order: nextWaypoint.sort_order,
          gps_distance_m: Math.round(dist),
        }, activeTrip.id);
        handleArriveAtWaypoint();
      }, 8000);
      return () => clearTimeout(timeout);
    }
  }, [driverLat, driverLng, nextWaypoint?.id, activeTrip?.status]);

  // DE-2.2: Detect proximity to dropoff for pulsing finish button
  useEffect(() => {
    if (activeTrip?.status !== 'in_progress' || !driverLocation || nextWaypoint) {
      setNearDropoff(false);
      return;
    }

    // HF-3: Guard against null dropoff coordinates
    if (!activeTrip?.dropoff_location?.latitude || !activeTrip?.dropoff_location?.longitude) {
      setNearDropoff(false);
      return;
    }

    const dist = haversineDistance(
      driverLocation,
      {
        latitude: activeTrip.dropoff_location.latitude,
        longitude: activeTrip.dropoff_location.longitude,
      },
    );

    if (dist < 80) {
      setNearDropoff(true);
      if (!prevNearDropoffRef.current) {
        prevNearDropoffRef.current = true;
        triggerHaptic('light');
      }
      if (!nearDropoffTrackedRef.current) {
        nearDropoffTrackedRef.current = true;
        trackValidationEvent('driver_near_dropoff', {
          distance_m: Math.round(dist),
        }, activeTrip.id);
      }
    } else {
      setNearDropoff(false);
      prevNearDropoffRef.current = false;
      nearDropoffTrackedRef.current = false;
    }
  }, [driverLat, driverLng, activeTrip?.status, nextWaypoint]);

  // DE-2.2: Pulse animation for "Finalizar viaje" button
  useEffect(() => {
    if (nearDropoff) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.05, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ]),
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [nearDropoff, pulseAnim]);

  const debouncedAdvanceStatus = useCallback(() => {
    const now = Date.now();
    if (now - lastAdvancePressRef.current < 1000) return;
    lastAdvancePressRef.current = now;
    triggerHaptic('medium');
    advanceStatus();
  }, [advanceStatus]);
  const TRIP_STEPS = useTripSteps();
  const ACTION_LABELS = useActionLabels();
  const routeCoordinates = useRoutePolyline(
    activeTrip?.pickup_location ?? null,
    activeTrip?.dropoff_location ?? null,
  );
  const { etaMinutes, isCalculating } = useDriverETA({
    pickupLocation: activeTrip?.pickup_location ?? null,
    dropoffLocation: activeTrip?.dropoff_location ?? null,
    rideStatus: activeTrip?.status ?? null,
  });

  // DT-3: Color-coded action button by phase
  const actionButtonColor = useMemo(() => {
    switch (activeTrip?.status) {
      case 'accepted': return '#3B82F6'; // blue
      case 'driver_en_route': return '#FF4D00'; // brand orange
      case 'arrived_at_pickup': return '#10B981'; // success green
      case 'in_progress': return '#8B5CF6'; // purple — "Llegué al destino"
      case 'arrived_at_destination': return '#EF4444'; // error red — "Finalizar viaje"
      default: return '#FF4D00'; // brand orange fallback
    }
  }, [activeTrip?.status]);

  // DT-4: Stepper tint by phase
  const stepperTint = useMemo(() => {
    switch (activeTrip?.status) {
      case 'accepted': return 'rgba(59,130,246,0.1)'; // blue tint
      case 'driver_en_route': return 'rgba(255,77,0,0.1)'; // brand orange tint
      case 'arrived_at_pickup': return 'rgba(16,185,129,0.1)'; // success green tint
      case 'in_progress': return 'rgba(168,85,247,0.1)'; // purple tint
      case 'arrived_at_destination': return 'rgba(239,68,68,0.1)'; // red tint
      default: return 'transparent';
    }
  }, [activeTrip?.status]);

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
      snapPoints={['25%', '55%', '90%']}
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

      {/* 0. Navigation overlay (when in-app nav active) — moved BEFORE the
            action button. Was rendered absolute-positioned, but the
            absolute anchored to the bottom sheet not the screen, causing
            it to overlap the action button. Now rendered inline at top. */}
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

      {/* BUG-244 polish: live distance hint + GPS health detection.
           Shows the driver in real time how far from the next target
           they are and warns if GPS feed seems broken. */}
      {(() => {
        const target = (activeTrip.status === 'driver_en_route' || activeTrip.status === 'accepted')
          ? activeTrip.pickup_location
          : (activeTrip.status === 'in_progress' || activeTrip.status === 'arrived_at_destination')
            ? activeTrip.dropoff_location
            : null;
        if (!target) return null;
        if (!driverLocation) {
          return (
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
              padding: 8, marginBottom: 8, borderRadius: 8,
              backgroundColor: 'rgba(239,68,68,0.1)',
              borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)',
            }}>
              <Ionicons name="warning" size={14} color="#EF4444" />
              <Text variant="caption" style={{ color: '#EF4444', marginLeft: 6, fontWeight: '600' }}>
                {t('trip.gps_unavailable', { defaultValue: 'GPS no disponible. Reiniciá la ubicación o contactá soporte.' })}
              </Text>
            </View>
          );
        }
        const distM = haversineDistance(driverLocation, target);
        const targetLabel = (activeTrip.status === 'driver_en_route' || activeTrip.status === 'accepted')
          ? t('trip.target_pickup', { defaultValue: 'pasajero' })
          : t('trip.target_dropoff', { defaultValue: 'destino' });
        const isClose = distM <= 100;
        const isInBypassRange = distM > 100 && distM <= 500;
        return (
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            paddingVertical: 6, paddingHorizontal: 10, marginBottom: 8, borderRadius: 8,
            backgroundColor: isClose
              ? 'rgba(16,185,129,0.12)'
              : isInBypassRange
                ? 'rgba(245,158,11,0.12)'
                : 'rgba(255,255,255,0.04)',
          }}>
            <Ionicons
              name={isClose ? 'checkmark-circle' : 'location'}
              size={14}
              color={isClose ? '#10B981' : isInBypassRange ? '#F59E0B' : '#9CA3AF'}
            />
            <Text
              variant="caption"
              style={{
                marginLeft: 6,
                color: isClose ? '#10B981' : isInBypassRange ? '#F59E0B' : '#9CA3AF',
                fontWeight: '600',
              }}
            >
              {isClose
                ? t('trip.distance_at_target', { defaultValue: `Llegaste al ${targetLabel}`, target: targetLabel })
                : t('trip.distance_to_target', { defaultValue: `Estás a ${distM < 1000 ? Math.round(distM) + 'm' : (distM/1000).toFixed(1) + 'km'} del ${targetLabel}`, distance: distM < 1000 ? `${Math.round(distM)}m` : `${(distM / 1000).toFixed(1)}km`, target: targetLabel })}
            </Text>
          </View>
        );
      })()}

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

      {/* BUG-246: GPS unavailable status + rider consent state. Replaces
           the previous self-bypass cap. Now: when GPS broken, driver tells
           the rider via the backend, rider decides via modal in their app. */}
      {!driverLocation && activeTrip.status !== 'canceled' && (
        <View style={{
          marginBottom: 8,
          padding: 10,
          borderRadius: 10,
          backgroundColor: activeTrip.driver_gps_status === 'rider_consented'
            ? 'rgba(16,185,129,0.1)'
            : 'rgba(239,68,68,0.1)',
          borderWidth: 1,
          borderColor: activeTrip.driver_gps_status === 'rider_consented'
            ? 'rgba(16,185,129,0.4)'
            : 'rgba(239,68,68,0.4)',
        }}>
          {activeTrip.driver_gps_status === 'rider_consented' ? (
            <Text variant="caption" style={{ color: '#10B981', fontWeight: '600', textAlign: 'center' }}>
              {t('trip.gps_consented', { defaultValue: '✓ El pasajero aceptó continuar sin GPS' })}
            </Text>
          ) : activeTrip.driver_gps_status === 'unavailable' ? (
            <Text variant="caption" style={{ color: '#F59E0B', fontWeight: '600', textAlign: 'center' }}>
              {t('trip.gps_waiting_rider', { defaultValue: '⏳ Esperando respuesta del pasajero…' })}
            </Text>
          ) : (
            <View>
              <Text variant="caption" style={{ color: '#EF4444', fontWeight: '600', textAlign: 'center', marginBottom: 6 }}>
                {t('trip.gps_unavailable_warning', { defaultValue: '⚠️ GPS no disponible' })}
              </Text>
              <Pressable
                onPress={async () => {
                  try {
                    await driverService.reportGpsUnavailable(activeTrip.id);
                    Toast.show({
                      type: 'info',
                      text1: t('trip.gps_notify_rider_sent', { defaultValue: 'Le avisamos al pasajero' }),
                      text2: t('trip.gps_notify_rider_hint', { defaultValue: 'Esperá su respuesta para continuar' }),
                    });
                  } catch (err) {
                    Toast.show({ type: 'error', text1: t('trip.gps_notify_rider_failed', { defaultValue: 'No se pudo notificar' }) });
                  }
                }}
                style={{
                  alignSelf: 'center',
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                  backgroundColor: '#EF4444',
                }}
              >
                <Text variant="caption" style={{ color: '#fff', fontWeight: '700' }}>
                  {t('trip.gps_notify_rider', { defaultValue: 'Avisarle al pasajero' })}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      {/* GPS recovered notice (driver had GPS broken, now restored) */}
      {driverLocation
        && activeTrip.driver_gps_status === 'unavailable'
        && (() => {
          // Auto-clear: if GPS came back, ping the recovered RPC
          driverService.reportGpsRecovered(activeTrip.id).catch(() => {});
          return null;
        })()}

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

      {/* Cancel — lower visual hierarchy than the primary action (size md vs lg,
          dimmed). Keeps full width for tap-ability but doesn't compete for
          attention with the color-coded "advance status" button above. */}
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

      {/* 2. Bottom toolbar row — navigate (external), compass (in-app nav),
           chat, SOS. Labeled with tiny captions below each icon so new
           drivers can identify each action without memorising icons. */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginBottom: 8, marginTop: 4 }}>
        {navTarget && !inAppNav.isNavigating && (
          <Pressable
            onPress={() => {
              AsyncStorage.setItem('preferred_nav', 'external');
              openNavigation(navTarget.latitude, navTarget.longitude);
            }}
            style={{ padding: 10, minHeight: 56, minWidth: 56, alignItems: 'center', justifyContent: 'center' }}
            accessibilityRole="button"
            accessibilityLabel={t('trip.navigate', { defaultValue: 'Navegar' })}
          >
            <Ionicons name="navigate" size={22} color="#60A5FA" />
            <Text variant="caption" style={{ color: '#60A5FA', fontSize: 10, marginTop: 2 }}>
              {t('trip.toolbar_maps', { defaultValue: 'Maps' })}
            </Text>
          </Pressable>
        )}
        {navTarget && !inAppNav.isNavigating && (
          <Pressable
            onPress={() => {
              AsyncStorage.setItem('preferred_nav', 'inapp');
              inAppNav.startNavigation(navTarget);
            }}
            style={{ padding: 10, minHeight: 56, minWidth: 56, alignItems: 'center', justifyContent: 'center' }}
            accessibilityRole="button"
            accessibilityLabel={t('trip.restart_nav', { defaultValue: 'Restart navigation' })}
          >
            <Ionicons name="compass" size={22} color="#FF4D00" />
            <Text variant="caption" style={{ color: '#FF4D00', fontSize: 10, marginTop: 2 }}>
              {t('trip.toolbar_guide', { defaultValue: 'Guía' })}
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => router.push(`/chat/${activeTrip.id}`)}
          style={{ padding: 10, minHeight: 56, minWidth: 56, alignItems: 'center', justifyContent: 'center' }}
          accessibilityRole="button"
          accessibilityLabel={t('chat.title', { defaultValue: 'Chat' })}
        >
          <Ionicons name="chatbubble" size={22} color="#9CA3AF" />
          <Text variant="caption" style={{ color: '#9CA3AF', fontSize: 10, marginTop: 2 }}>
            {t('trip.toolbar_chat', { defaultValue: 'Chat' })}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleSOS}
          style={{ padding: 10, minHeight: 56, minWidth: 56, alignItems: 'center', justifyContent: 'center' }}
          accessibilityRole="button"
          accessibilityLabel="SOS"
          accessibilityHint={t('trip.sos_body')}
        >
          <Ionicons name="alert-circle" size={22} color="#EF4444" />
          <Text variant="caption" style={{ color: '#EF4444', fontSize: 10, marginTop: 2 }}>
            SOS
          </Text>
        </Pressable>
      </View>

      {/* (was here: NavigationOverlay — moved to position 0 above the
           action button to fix overlap on Android, see BUG-238 fix) */}

      {/* Chained ride banner */}
      {activeTrip.next_ride_id && (
        <View className="bg-info px-4 py-3 rounded-2xl mb-3 flex-row items-center border border-white/[0.06]" accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Ionicons name="link-outline" size={18} color="white" />
          <Text variant="bodySmall" color="inverse" className="ml-2 flex-1">
            {t('trip.next_ride_queued', { defaultValue: 'Proximo viaje asignado' })}
          </Text>
        </View>
      )}

      {/* 4. Compact status stepper — BUG-236 redesign:
            Was 6 truncated labels stacked horizontally (~70pt). Now: 6 small
            dots + only the CURRENT step label prominent below. Driver
            instantly sees "where am I" instead of reading 6 labels. */}
      <View style={{ backgroundColor: stepperTint, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, marginTop: 4, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
        <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', marginBottom: 6 }}>
          {TRIP_STEPS.map((step, idx) => {
            const currentIdx = TRIP_STEPS.findIndex((s) => s.key === activeTrip.status);
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
                    ? actionButtonColor
                    : isPast
                      ? 'rgba(255,255,255,0.4)'
                      : 'rgba(255,255,255,0.12)',
                }}
              />
            );
          })}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 6 }}>
          <Text variant="bodySmall" style={{ color: '#fff', fontWeight: '600' }}>
            {TRIP_STEPS.find((s) => s.key === activeTrip.status)?.label ?? ''}
          </Text>
          <Text variant="caption" style={{ color: 'rgba(255,255,255,0.5)' }}>
            · {TRIP_STEPS.findIndex((s) => s.key === activeTrip.status) + 1}/{TRIP_STEPS.length}
          </Text>
        </View>
      </View>

      {/* 5. ETA Badge */}
      {etaMinutes !== null && (
        <View className="items-center mb-3">
          <ETABadge
            label={
              activeTrip.status === 'arrived_at_pickup'
                ? t('trip.eta_driver_arrived')
                : activeTrip.status === 'in_progress'
                  ? t('trip.eta_to_destination', { minutes: etaMinutes })
                  : t('trip.eta_driver_to_pickup', { minutes: etaMinutes })
            }
            isCalculating={isCalculating}
            urgent={etaMinutes > 0 && etaMinutes <= 3}
            variant="dark"
          />
        </View>
      )}

      {/* 6. Wait timer (visible when arrived at pickup) */}
      {activeTrip.status === 'arrived_at_pickup' && activeTrip.driver_arrived_at && (
        <WaitTimer arrivedAt={activeTrip.driver_arrived_at} freeMinutes={5} />
      )}

      {/* No-show button — appears after 5 min wait */}
      {activeTrip.status === 'arrived_at_pickup' && activeTrip.driver_arrived_at &&
        Math.floor((Date.now() - new Date(activeTrip.driver_arrived_at).getTime()) / 60000) >= 5 && (
        <Pressable
          style={{
            backgroundColor: '#F59E0B',
            borderRadius: 16,
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
          <Text variant="body" style={{ color: '#fff', fontWeight: '700' }}>
            {t('trip.passenger_no_show')} — {t('trip.cancel_no_show')}
          </Text>
        </Pressable>
      )}

      {/* DE-2.1: Arriving at waypoint banner */}
      {nearWaypoint && nextWaypoint && (
        <View style={{ backgroundColor: 'rgba(16,185,129,0.12)', padding: 8, borderRadius: 16, marginBottom: 4, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
          <Text variant="caption" style={{ color: '#10B981', textAlign: 'center' }}>
            {t('trip.arriving_waypoint', { n: nextWaypoint.sort_order })}
          </Text>
        </View>
      )}

      {/* 7. Route info (pickup/dropoff addresses) */}
      {activeTrip.status === 'in_progress' ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 8 }}>
            <Ionicons name="location" size={16} color="#FF4D00" />
            <Text variant="body" color="primary" style={{ marginLeft: 8, flex: 1 }} numberOfLines={1}>
              {nextWaypoint?.address || activeTrip.dropoff_address}
            </Text>
          </View>
          <Pressable
            onPress={() => setRouteExpanded(!routeExpanded)}
            style={{ minHeight: 48, justifyContent: 'center' }}
            accessibilityRole="button"
            accessibilityLabel={routeExpanded ? t('trip.hide_route') : t('trip.view_full_route')}
          >
            <Text variant="caption" color="accent" style={{ textAlign: 'center' }}>
              {routeExpanded ? t('trip.hide_route') : t('trip.view_full_route')}
            </Text>
          </Pressable>
          {routeExpanded && (
            <Card forceDark variant="filled" padding="md" className="bg-[#1a1a2e] mb-4 mt-2 rounded-2xl border border-white/[0.06]">
              <View className="flex-row items-start mb-3">
                <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
                <View className="flex-1">
                  <Text variant="caption" color="inverse" className="opacity-50">
                    {t('trip.pickup_address')}
                  </Text>
                  <Text variant="bodySmall" color="inverse">
                    {activeTrip.pickup_address}
                  </Text>
                </View>
              </View>
              {waypoints.map((wp) => (
                <View key={wp.id} className="flex-row items-start mb-3">
                  <View className={`w-2.5 h-2.5 rounded-full mt-1 mr-3 ml-[1px] ${wp.departed_at ? 'bg-success' : wp.arrived_at ? 'bg-warning' : 'bg-primary-400'}`} />
                  <View className="flex-1">
                    <View className="flex-row items-center gap-2">
                      <Text variant="caption" color="accent" className="opacity-70">
                        {t('trip.waypoint_n', { n: wp.sort_order, defaultValue: `Parada ${wp.sort_order}` })}
                      </Text>
                      {wp.departed_at && (
                        <Text variant="caption" color="inverse" className="opacity-40">✅</Text>
                      )}
                      {wp.arrived_at && !wp.departed_at && (
                        <Text variant="caption" color="inverse" className="opacity-40">📍</Text>
                      )}
                    </View>
                    <Text variant="bodySmall" color="inverse">
                      {wp.address}
                    </Text>
                  </View>
                </View>
              ))}
              <View className="flex-row items-start">
                <View className="w-3 h-3 rounded-full bg-neutral-400 mt-1 mr-3" />
                <View className="flex-1">
                  <Text variant="caption" color="inverse" className="opacity-50">
                    {t('trip.dropoff_address')}
                  </Text>
                  <Text variant="bodySmall" color="inverse">
                    {activeTrip.dropoff_address}
                  </Text>
                </View>
              </View>
            </Card>
          )}
        </>
      ) : (
        // BUG-237: collapsed route summary truncates addresses to 1 line.
        // Driver doesn't need to read full addresses while driving — Maps
        // already shows turn-by-turn. Tap "Ver ruta completa" expands.
        <Pressable onPress={() => setRouteExpanded(true)}>
          <Card forceDark variant="filled" padding="md" className="bg-[#1a1a2e] mb-4 rounded-2xl border border-white/[0.06]">
            <View className="flex-row items-center mb-2">
              <View className="w-2.5 h-2.5 rounded-full bg-primary-500 mr-2" />
              <Text variant="caption" color="inverse" className="opacity-50 mr-2">
                {t('trip.pickup_address')}
              </Text>
              <Text variant="bodySmall" color="inverse" numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1 }}>
                {activeTrip.pickup_address}
              </Text>
            </View>
            {waypoints.length > 0 && (
              <View className="flex-row items-center mb-2">
                <View className={`w-2.5 h-2.5 rounded-full mr-2 ${waypoints.find((w) => !w.departed_at) ? 'bg-warning' : 'bg-success'}`} />
                <Text variant="caption" color="accent" className="opacity-70 mr-2">
                  {t('trip.stops_count', { count: waypoints.length, defaultValue: `${waypoints.length} parada(s)` })}
                </Text>
              </View>
            )}
            <View className="flex-row items-center">
              <View className="w-2.5 h-2.5 rounded-full bg-neutral-400 mr-2" />
              <Text variant="caption" color="inverse" className="opacity-50 mr-2">
                {t('trip.dropoff_address')}
              </Text>
              <Text variant="bodySmall" color="inverse" numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1 }}>
                {activeTrip.dropoff_address}
              </Text>
            </View>
            <Text variant="caption" color="accent" style={{ textAlign: 'center', marginTop: 8, opacity: 0.7 }}>
              {t('trip.tap_to_expand', { defaultValue: 'Tocá para ver direcciones completas' })}
            </Text>
          </Card>
        </Pressable>
      )}

      {/* Scheduled ride banner */}
      {activeTrip.scheduled_at && (
        <View className="flex-row items-center bg-blue-900/30 rounded-2xl py-2 px-3 mb-3 border border-white/[0.06]">
          <Ionicons name="time-outline" size={16} color="#60A5FA" />
          <Text variant="bodySmall" color="inverse" className="ml-2">
            {t('home.scheduled_at', { time: new Date(activeTrip.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
          </Text>
        </View>
      )}

      {/* 8. Waypoint controls */}
      {/* (Waypoint arrive/depart buttons already rendered above in the action section) */}

      {/* 9. Rider preferences (collapsible) */}
      {activeTrip.rider_preferences && Object.values(activeTrip.rider_preferences).some(Boolean) && (
        <View className="mb-3">
          <Pressable
            onPress={() => setPrefsExpanded(!prefsExpanded)}
            style={{ minHeight: 48, justifyContent: 'center' }}
            accessibilityRole="button"
            accessibilityLabel={prefsExpanded ? t('trip.hide_preferences') : t('trip.view_preferences')}
          >
            <Text variant="bodySmall" color="accent" style={{ textAlign: 'center', marginVertical: 4 }}>
              {prefsExpanded ? t('trip.hide_preferences') : t('trip.view_preferences')}
            </Text>
          </Pressable>
          {prefsExpanded && (
            <View className="flex-row flex-wrap gap-1.5 px-1">
              <Ionicons name="options-outline" size={14} color="#9CA3AF" />
              {activeTrip.rider_preferences.quiet_mode && (
                <View className="flex-row items-center bg-[#1a1a2e] px-2.5 py-1 rounded-full gap-1">
                  <Ionicons name="volume-mute" size={12} color="#FFA726" />
                  <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_quiet', { defaultValue: 'Silencio' })}</Text>
                </View>
              )}
              {activeTrip.rider_preferences.temperature === 'cool' && (
                <View className="flex-row items-center bg-[#1a1a2e] px-2.5 py-1 rounded-full gap-1">
                  <Ionicons name="snow" size={12} color="#42A5F5" />
                  <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_cool', { defaultValue: 'AC fresco' })}</Text>
                </View>
              )}
              {activeTrip.rider_preferences.temperature === 'warm' && (
                <View className="flex-row items-center bg-[#1a1a2e] px-2.5 py-1 rounded-full gap-1">
                  <Ionicons name="sunny" size={12} color="#FFA726" />
                  <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_warm', { defaultValue: 'Cálido' })}</Text>
                </View>
              )}
              {activeTrip.rider_preferences.conversation_ok && (
                <View className="flex-row items-center bg-[#1a1a2e] px-2.5 py-1 rounded-full gap-1">
                  <Ionicons name="chatbubbles" size={12} color="#66BB6A" />
                  <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_conversation', { defaultValue: 'Conversación' })}</Text>
                </View>
              )}
              {activeTrip.rider_preferences.luggage_trunk && (
                <View className="flex-row items-center bg-[#1a1a2e] px-2.5 py-1 rounded-full gap-1">
                  <Ionicons name="briefcase" size={12} color="#AB47BC" />
                  <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_trunk', { defaultValue: 'Maletero' })}</Text>
                </View>
              )}
              {activeTrip.rider_preferences.accessibility_needs?.includes('wheelchair') && (
                <View className="flex-row items-center bg-blue-900 px-2.5 py-1 rounded-full gap-1">
                  <Ionicons name="accessibility" size={12} color="#64B5F6" />
                  <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_wheelchair', { defaultValue: 'Silla de ruedas' })}</Text>
                </View>
              )}
              {activeTrip.rider_preferences.accessibility_needs?.includes('hearing_impaired') && (
                <View className="flex-row items-center bg-blue-900 px-2.5 py-1 rounded-full gap-1">
                  <Ionicons name="ear" size={12} color="#64B5F6" />
                  <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_hearing', { defaultValue: 'Dificultad auditiva' })}</Text>
                </View>
              )}
              {activeTrip.rider_preferences.accessibility_needs?.includes('visual_impaired') && (
                <View className="flex-row items-center bg-blue-900 px-2.5 py-1 rounded-full gap-1">
                  <Ionicons name="eye-off" size={12} color="#64B5F6" />
                  <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_visual', { defaultValue: 'Dificultad visual' })}</Text>
                </View>
              )}
              {activeTrip.rider_preferences.accessibility_needs?.includes('service_animal') && (
                <View className="flex-row items-center bg-blue-900 px-2.5 py-1 rounded-full gap-1">
                  <Ionicons name="paw" size={12} color="#64B5F6" />
                  <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_service_animal', { defaultValue: 'Animal de servicio' })}</Text>
                </View>
              )}
              {activeTrip.rider_preferences.accessibility_needs?.includes('extra_space') && (
                <View className="flex-row items-center bg-blue-900 px-2.5 py-1 rounded-full gap-1">
                  <Ionicons name="resize" size={12} color="#64B5F6" />
                  <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_extra_space', { defaultValue: 'Espacio extra' })}</Text>
                </View>
              )}
            </View>
          )}
        </View>
      )}

      {/* 10. Delivery details (for cargo rides) */}
      {isDeliveryRide && deliveryDetails && (
        <Card forceDark variant="filled" padding="md" className="bg-[#1a1a2e] mb-3 rounded-2xl border border-white/[0.06]">
          {/* Recipient */}
          <View className="flex-row items-center mb-2">
            <Ionicons name="person" size={16} color="#FF4D00" />
            <Text variant="body" color="inverse" className="ml-2 font-semibold flex-1">
              {deliveryDetails.recipient_name}
            </Text>
          </View>
          <Pressable
            onPress={() => Linking.openURL(`tel:${deliveryDetails.recipient_phone}`)}
            className="flex-row items-center mb-3 bg-neutral-700 rounded-2xl py-2 px-3"
            style={{ minHeight: 48 }}
            accessibilityRole="button"
            accessibilityLabel={`${t('delivery.tap_to_call')} ${deliveryDetails.recipient_phone}`}
          >
            <Ionicons name="call" size={14} color="#10B981" />
            <Text variant="bodySmall" color="inverse" className="ml-2">
              {deliveryDetails.recipient_phone}
            </Text>
            <Text variant="caption" color="accent" className="ml-auto">
              {t('delivery.tap_to_call')}
            </Text>
          </Pressable>

          {/* Package info */}
          <View className="mb-2">
            <Text variant="caption" color="secondary" className="mb-1">
              {t('delivery.package_description')}
            </Text>
            <Text variant="bodySmall" color="inverse">
              {deliveryDetails.package_description}
            </Text>
          </View>

          {/* Category + weight badges */}
          <View className="flex-row flex-wrap gap-1.5 mb-2">
            {deliveryDetails.package_category && (
              <View className="px-2.5 py-1 rounded-full" style={{ backgroundColor: 'rgba(255,77,0,0.2)' }}>
                <Text variant="caption" color="inverse" className="text-xs">
                  {t(`delivery.cat_${deliveryDetails.package_category}`, { defaultValue: deliveryDetails.package_category })}
                </Text>
              </View>
            )}
            {deliveryDetails.estimated_weight_kg != null && (
              <View className="bg-neutral-700 px-2.5 py-1 rounded-full">
                <Text variant="caption" color="inverse" className="text-xs">
                  {t('delivery.weight_kg', { weight: deliveryDetails.estimated_weight_kg })}
                </Text>
              </View>
            )}
            {deliveryDetails.client_accompanies && (
              <View className="bg-blue-600/20 px-2.5 py-1 rounded-full flex-row items-center gap-1">
                <Ionicons name="people" size={10} color="#60A5FA" />
                <Text variant="caption" color="inverse" className="text-xs">
                  {t('delivery.client_accompanies')}
                </Text>
              </View>
            )}
          </View>

          {/* Special instructions */}
          {deliveryDetails.special_instructions ? (
            <View className="bg-yellow-900/20 rounded-lg p-2.5 mt-1">
              <View className="flex-row items-center mb-1">
                <Ionicons name="alert-circle" size={14} color="#F59E0B" />
                <Text variant="caption" color="inverse" className="ml-1 font-semibold">
                  {t('delivery.special_instructions')}
                </Text>
              </View>
              <Text variant="bodySmall" color="inverse" className="opacity-80">
                {deliveryDetails.special_instructions}
              </Text>
            </View>
          ) : null}
        </Card>
      )}

      {/* Cargo badge */}
      {activeTrip.service_type === 'triciclo_cargo' && (
        <View className="flex-row items-center justify-center mb-3 rounded-2xl py-2 px-4 border border-white/[0.06]" style={{ backgroundColor: '#FF4D00' }}>
          <Ionicons name="cube" size={16} color="white" />
          <Text variant="bodySmall" color="inverse" className="ml-2 font-bold">CARGO</Text>
        </View>
      )}

      {/* Corporate ride badge */}
      {activeTrip.corporate_account_id && (
        <View className="flex-row items-center justify-center mb-3 bg-blue-600/80 rounded-2xl py-2 px-4 border border-white/[0.06]">
          <Ionicons name="business" size={16} color="white" />
          <Text variant="bodySmall" color="inverse" className="ml-2 font-bold">
            {t('home.corporate_ride')}
          </Text>
        </View>
      )}

      {/* Fare — only visible during accepted (hidden while driving; completed has its own view) */}
      {activeTrip.status === 'accepted' && (
        <View className="flex-row justify-between items-center mb-4 px-2" accessible={true} accessibilityLabel={t('a11y.fare_amount', { ns: 'common', amount: formatCUP(activeTrip.estimated_fare_cup) })}>
          <Text variant="bodySmall" color="inverse" className="opacity-50">
            {t('trip.earned', { defaultValue: 'Tarifa estimada' })}
          </Text>
          <View className="items-end">
            <Text variant="h4" color="accent">
              {formatCUP(activeTrip.estimated_fare_cup)}
            </Text>
            {activeTrip.estimated_fare_trc != null && (
              <Text variant="caption" color="inverse" className="opacity-50">
                ~{formatTRC(activeTrip.estimated_fare_trc)}
              </Text>
            )}
          </View>
        </View>
      )}

      {/* Surge indicator */}
      {(activeTrip.surge_multiplier ?? 1) > 1 && (
        <Text variant="caption" color="inverse" className="opacity-50 text-center mb-4">
          {t('trip.surge_active', { multiplier: activeTrip.surge_multiplier, defaultValue: `Tarifa dinámica ${activeTrip.surge_multiplier}x activa` })}
        </Text>
      )}
    </DraggableSheet>
  );
}

function TripCompleteView() {
  const { t } = useTranslation('driver');
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const driverProfile = useDriverStore((s) => s.profile);
  const { clearCompletedTrip } = useDriverRideActions();
  const [commissionRate, setCommissionRate] = useState(0.15);
  const [rideWithRider, setRideWithRider] = useState<RideWithRider | null>(null);
  const [showRating, setShowRating] = useState(true);
  // BUG-222: show excess-distance justification modal first if driver
  // exceeded 1.3× the estimated distance and hasn't yet provided a reason.
  const excessMeters = activeTrip?.excess_distance_uncharged_m ?? 0;
  const alreadyJustified = !!activeTrip?.excess_distance_reason;
  const [showExcessSheet, setShowExcessSheet] = useState(excessMeters > 0 && !alreadyJustified);

  useEffect(() => {
    walletService.getConfigValue('commission_rate')
      .then((val) => {
        if (val) {
          const parsed = parseFloat(String(val).replace(/"/g, ''));
          if (!isNaN(parsed) && parsed > 0 && parsed < 1) setCommissionRate(parsed);
        }
      })
      .catch(() => { /* best-effort: use default 0.15 */ });
  }, []);

  // Fetch rider info for rating
  useEffect(() => {
    if (!activeTrip) return;
    rideService.getRideWithRider(activeTrip.id)
      .then(setRideWithRider)
      .catch(() => { /* best-effort: rating still works without rider info */ });
  }, [activeTrip?.id]);

  // Driver must tap "Listo" manually to dismiss — no auto-advance.
  // This ensures they have time to see earnings, rate the rider, and download receipt.

  if (!activeTrip) return null;

  const fare = activeTrip.final_fare_cup ?? activeTrip.estimated_fare_cup;
  const commissionAmount = Math.round(fare * commissionRate);
  const netEarnings = fare - commissionAmount;
  const isCash = activeTrip.payment_method === 'cash' || activeTrip.payment_method === 'mixed';

  const handleDownloadReceipt = async () => {
    if (!activeTrip) return;
    try {
      const data = await rideService.getReceiptData(activeTrip.id, 'driver');
      // Localise the raw payment_method enum on the way out.
      const paymentLabel =
        activeTrip.payment_method === 'cash'
          ? t('payment.cash', { defaultValue: 'Efectivo' })
          : activeTrip.payment_method === 'corporate'
            ? t('payment.corporate', { defaultValue: 'Cuenta corporativa' })
            : activeTrip.payment_method === 'mixed'
              ? t('payment.mixed', { defaultValue: 'Mixto' })
              : 'TriciCoin';
      const html = generateReceiptHTML({ ...data, paymentMethod: paymentLabel });
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Recibo TriciGo' });
      }
    } catch (err) {
      console.error('Receipt generation failed:', err);
    }
  };

  return (
    <DraggableSheet
      snapPoints={['50%', '90%']}
      initialIndex={0}
      theme="dark"
      scrollable
    >
      <View className="pt-8 items-center">
        {/* DT-6: Earnings delta — large green amount at top */}
        {activeTrip.final_fare_cup != null && (
          <Text variant="h2" style={{
            color: '#22C55E',
            textAlign: 'center',
            marginBottom: 8,
          }}>
            {t('trip.earned_this_ride', {
              amount: `$${Math.round((activeTrip.final_fare_cup || 0) * 0.85).toLocaleString()}`,
            })}
          </Text>
        )}

        <View className="w-20 h-20 rounded-full bg-success items-center justify-center mb-4">
          <Ionicons name="checkmark" size={40} color="white" />
        </View>

        <Text variant="h3" color="inverse" className="mb-2">
          {t('trip.trip_completed')}
        </Text>

        {/* DT-6: Compressed trip summary — single line */}
        <Text variant="bodySmall" style={{ color: '#9CA3AF', textAlign: 'center', marginBottom: 8 }}>
          {formatCUP(activeTrip.final_fare_cup ?? activeTrip.estimated_fare_cup)} · {((activeTrip.actual_distance_m ?? 0) / 1000).toFixed(1)} km · {Math.ceil((activeTrip.actual_duration_s || 0) / 60)} min
        </Text>

        {/* Commission breakdown */}
        <Card forceDark variant="filled" padding="md" className="w-full bg-[#1a1a2e] mb-6 rounded-2xl border border-white/[0.06]">
          <View className="flex-row justify-between mb-2">
            <Text variant="bodySmall" style={{ color: '#9CA3AF' }}>
              {t('trip.total_fare', { defaultValue: 'Tarifa total' })}
            </Text>
            <Text variant="bodySmall" color="inverse">
              {formatCUP(fare)}
            </Text>
          </View>
          <View className="flex-row justify-between mb-2">
            <Text variant="bodySmall" style={{ color: '#9CA3AF' }}>
              {t('trip.platform_commission', { defaultValue: 'Comisión plataforma (15%)' })}
            </Text>
            <Text variant="bodySmall" style={{ color: '#EF4444' }}>
              -{formatCUP(commissionAmount)}
            </Text>
          </View>
          <View className="h-px my-2" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }} />
          <View className="flex-row justify-between">
            <Text variant="body" color="inverse" className="font-bold">
              {isCash ? t('trip.collect_cash', { defaultValue: 'Cobras en efectivo' }) : t('trip.net_earnings', { defaultValue: 'Ganancia neta' })}
            </Text>
            <Text variant="body" color="accent" className="font-bold">
              {formatCUP(netEarnings)}
            </Text>
          </View>
          {isCash && (
            <Text variant="caption" style={{ color: '#9CA3AF' }} className="mt-1">
              {t('trip.commission_deducted', { defaultValue: 'La comisión se descuenta de tu saldo' })}
            </Text>
          )}
          {activeTrip.payment_method === 'mixed' && (
            <View className="mt-3 p-3 rounded-xl" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}>
              <Text variant="body" color="inverse" className="font-bold mb-1">
                {t('trip.collect_cash_amount', {
                  amount: formatCUP((activeTrip as any).cash_amount_cup ?? Math.round(fare * 0.5)),
                  defaultValue: `Cobrar $${((activeTrip as any).cash_amount_cup ?? Math.round(fare * 0.5)).toLocaleString()} en efectivo`,
                })}
              </Text>
              <Text variant="caption" style={{ color: '#9CA3AF' }}>
                {t('trip.wallet_portion', {
                  amount: formatCUP((activeTrip as any).wallet_amount_cup ?? Math.round(fare * 0.5)),
                  defaultValue: `$${((activeTrip as any).wallet_amount_cup ?? Math.round(fare * 0.5)).toLocaleString()} del wallet del pasajero`,
                })}
              </Text>
            </View>
          )}
        </Card>

        {/* Tip received */}
        {(activeTrip.tip_amount ?? 0) > 0 && (
          <Card forceDark variant="filled" padding="md" className="w-full bg-[#1a1a2e] mb-6 rounded-2xl border border-white/[0.06]">
            <View className="flex-row justify-between items-center" accessibilityRole="alert" accessibilityLiveRegion="polite">
              <View className="flex-row items-center gap-1">
                <Ionicons name="gift-outline" size={16} color="white" />
                <Text variant="body" color="inverse">{t('trip.tip_received', { amount: formatTRC(activeTrip.tip_amount!), defaultValue: '¡Recibiste una propina!' })}</Text>
              </View>
              <Text variant="body" color="accent" className="font-bold">
                +{formatTRC(activeTrip.tip_amount!)}
              </Text>
            </View>
          </Card>
        )}

        {/* Surge indicator */}
        {(activeTrip.surge_multiplier ?? 1) > 1 && (
          <Text variant="caption" color="inverse" className="opacity-50 text-center mb-4">
            {t('trip.surge_active', { multiplier: activeTrip.surge_multiplier, defaultValue: `Tarifa dinámica ${activeTrip.surge_multiplier}x activa` })}
          </Text>
        )}

        {/* Receipt download: native-only. expo-print.printToFileAsync is not
            implemented on web (returns undefined), so the button is hidden
            there to avoid a destructure crash. Native APK keeps the feature. */}
        {Platform.OS !== 'web' && (
          <Button
            title={t('trip.download_receipt', { defaultValue: 'Descargar recibo' })}
            variant="outline"
            size="lg"
            fullWidth
            forceDark
            onPress={handleDownloadReceipt}
            className="mb-3"
          />
        )}

        {/* BUG-222: excess-distance justification (shown FIRST, blocks rating) */}
        {showExcessSheet && (
          <View className="w-full mb-3">
            <ExcessDistanceSheet
              rideId={activeTrip.id}
              excessMeters={excessMeters}
              chargeableM={Math.max(0, (activeTrip.actual_distance_m ?? 0) - excessMeters)}
              actualM={activeTrip.actual_distance_m ?? 0}
              onComplete={() => setShowExcessSheet(false)}
            />
          </View>
        )}

        {/* Rider rating (only after excess sheet dismissed) */}
        {!showExcessSheet && showRating && rideWithRider && driverProfile?.user_id && (
          <View className="w-full mb-3">
            <RiderRatingSheet
              rideId={activeTrip.id}
              reviewerId={driverProfile.user_id}
              riderId={rideWithRider.customer_id}
              riderName={rideWithRider.rider_name}
              riderAvatarUrl={rideWithRider.rider_avatar_url}
              onComplete={clearCompletedTrip}
              onSkip={() => setShowRating(false)}
            />
          </View>
        )}

        <Button
          title={t('trip.done', { defaultValue: 'Listo' })}
          size="lg"
          fullWidth
          onPress={() => {
            // UX: give positive feedback on trip dismissal instead of an
            // abrupt cut to the home "searching" screen. Haptic + toast
            // make the transition feel intentional and celebrate the driver.
            triggerHaptic('success');
            Toast.show({
              type: 'success',
              text1: t('trip.done_toast_title', { defaultValue: '¡Viaje cobrado!' }),
              text2: t('trip.done_toast_subtitle', { defaultValue: 'Buscando tu próximo viaje...' }),
              visibilityTime: 2500,
            });
            clearCompletedTrip();
          }}
        />
      </View>
    </DraggableSheet>
  );
}
