import React, { useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { View, Text, Animated, AppState, Platform, Image, TouchableOpacity, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, darkColors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { MAP_STYLE_LIGHT, MAP_STYLE_DARK, MAP_COLORS, MARKER, ROUTE, haversineDistance, snapDriverToRoute, smoothHeading, vehicleMarkerRotationOffset, useAnimatedCoordinate, useAnimatedHeading, estimateVehicleEtaMinutes, formatVehicleEtaMinutes, formatVehicleDistance, triggerSelection, triggerHaptic, POI_LAYER_ID, POI_SOURCE_ID, poiNameFromFeature, isNearScreenPoint, coordsEqual } from '@tricigo/utils';
import { PlacesLayer } from './PlacesLayer';
import { StopMarker } from '@tricigo/ui';
import { useThemeStore } from '@/stores/theme.store';
import { getMapFallbackCoordLngLat } from '@/config/demo';
import { getMapboxGL, ensureMapboxToken, toLngLat as toCoord } from '@/lib/mapbox';
import { useAnimatedVehicles } from '@/hooks/useAnimatedVehicles';
import { WebMapView } from './WebMapView';
import { mapLogger } from '@tricigo/utils';
import { SearchingDriverMarkers } from './SearchingDriverMarkers';
import type { SearchingDriverPresence } from '@tricigo/types';

// Token before any MapView mounts — see the note in lib/mapbox.ts.
ensureMapboxToken();

// Vehicle marker images (top-down view)
// BUG-218: "auto" is the Cuban classic almendrón, NOT a modern sedan.
const vehicleMarkerImages: Record<string, any> = {
  'marker-triciclo': require('../../assets/vehicles/markers/triciclo.png'),
  'marker-moto': require('../../assets/vehicles/markers/moto.png'),
  'marker-auto': require('../../assets/vehicles/markers/auto_clasico.png'),
  'marker-confort': require('../../assets/vehicles/markers/confort.png'),
  'marker-mensajeria': require('../../assets/vehicles/markers/mensajeria.png'),
};

// Service slugs whose marker has no inherent "front" direction — rotation
// by bearing would feel arbitrary (e.g. mensajeria is rendered as a square
// cargo box, not a vehicle silhouette).
const NON_ROTATING_MARKERS = new Set<string>(['mensajeria']);

interface GeoPoint {
  latitude: number;
  longitude: number;
}

interface NearbyVehicleMarker {
  driver_profile_id: string;
  latitude: number;
  longitude: number;
  vehicle_type: string;
  heading?: number | null;
}

interface RideMapViewProps {
  pickupLocation?: GeoPoint | null;
  dropoffLocation?: GeoPoint | null;
  driverLocation?: GeoPoint | null;
  /** BUG-270b: explicit heading prop. Without this the marker can't rotate
   *  because driverLocation may not carry heading, and we destructured it
   *  unconditionally in RideMapViewInner. Adding to the interface so the
   *  prop flows through TypeScript and from callers. */
  driverHeading?: number | null;
  routeCoordinates?: GeoPoint[] | null;
  waypointLocations?: GeoPoint[];
  /** Status per waypoint (same order as waypointLocations). Used to
   *  drive the StopMarker pulse: the first 'current' one pulses. */
  waypointStatuses?: Array<'pending' | 'current' | 'completed'>;
  nearbyVehicles?: NearbyVehicleMarker[];
  /** Opacity for the driver marker (0-1). Use < 1 when showing cached position. */
  driverMarkerOpacity?: number;
  /** Drivers currently reviewing the ride request (searching phase) */
  searchingDrivers?: SearchingDriverPresence[];
  /** Highlight a specific driver (e.g. the one who accepted) */
  acceptedDriverId?: string | null;
  /** Whether the accept animation is playing (camera flyTo) */
  isAcceptAnimating?: boolean;
  /** Location to fly the camera to on accept */
  acceptedDriverLocation?: GeoPoint | null;
  /** Route from driver's current position to pickup (blue dashed line) */
  driverToPickupRoute?: GeoPoint[] | null;
  /** Vehicle type slug for driver marker (triciclo, moto, auto, confort) */
  vehicleType?: string;
  height?: number;
  /** When true, map fills all available space via flex:1 instead of fixed height */
  fullscreen?: boolean;
  /**
   * BUG-282 — initial map center as [longitude, latitude]. Pass the user's
   * GPS (cached or live) so the map opens centered on the user, not the
   * Havana / demo-city fallback. Only consulted when no pickup/dropoff/
   * driver bounds are active.
   */
  initialUserCenter?: [number, number] | null;
  /**
   * BUG-267 v3 — current ride status. Drives the Uber-style camera follow
   * profile: when the ride is between `accepted` and `in_progress` the
   * camera centers on the driver with state-specific zoom/pitch/heading
   * (heading-up navigation). When null/undefined the camera falls back to
   * the static bounds fit (previous behavior).
   */
  rideStatus?: string | null;
  /** Long-press anywhere on the map. Receives [lng, lat]. */
  onLongPressMap?: (lng: number, lat: number) => void;
  /** Make the pickup marker draggable (long-press it, then move). Called with
   *  [lng, lat] when the finger lifts. Only the vehicle-selection map passes
   *  these; the review and active-ride maps keep their pins fixed. */
  onPickupDragEnd?: (lng: number, lat: number) => void;
  /** Same for the dropoff pin. */
  onDropoffDragEnd?: (lng: number, lat: number) => void;
  /** Minutes until the driver arrives, drawn in a bubble on the marker.
   *  Omit (or pass null) to draw no bubble. */
  driverEtaMinutes?: number | null;
  /** How much of the route is behind you, 0-1. Paints that much of the line
   *  in the progress colour. Omit while there's no trip underway. */
  routeProgress?: number | null;
  /** Draw the places layer. Off while the rider is choosing nothing. */
  showPlaces?: boolean;
  /** A place on the map was chosen. Receives its name and [lng, lat]. */
  onPlacePress?: (name: string, lng: number, lat: number) => void;
  /** Draw 3D buildings. Opt-in — see useMapDetail. */
  show3dBuildings?: boolean;
}

// Fallback center: Havana by default, but switchable via EXPO_PUBLIC_DEMO_CITY
// when the demo flag is on (see config/demo.ts + docs/DEMO_MODE.md).
const HAVANA_CENTER: [number, number] = getMapFallbackCoordLngLat();

/* Ant-march dash animation — 28 frames (interpolated from web's 14 for smoother motion) */
const DASH_SEQUENCE: number[][] = [
  [0, 4, 3], [0.25, 4, 2.75], [0.5, 4, 2.5], [0.75, 4, 2.25],
  [1, 4, 2], [1.25, 4, 1.75], [1.5, 4, 1.5], [1.75, 4, 1.25],
  [2, 4, 1], [2.25, 4, 0.75], [2.5, 4, 0.5], [2.75, 4, 0.25],
  [3, 4, 0], [0, 0.25, 3, 3.75], [0, 0.5, 3, 3.5], [0, 0.75, 3, 3.25],
  [0, 1, 3, 3], [0, 1.25, 3, 2.75], [0, 1.5, 3, 2.5], [0, 1.75, 3, 2.25],
  [0, 2, 3, 2], [0, 2.25, 3, 1.75], [0, 2.5, 3, 1.5], [0, 2.75, 3, 1.25],
  [0, 3, 3, 1], [0, 3.25, 3, 0.75], [0, 3.5, 3, 0.5], [0, 3.75, 3, 0.25],
];

/** Compute bounding box from an array of [lng, lat] coordinates */
function computeBounds(coords: [number, number][]): {
  ne: [number, number];
  sw: [number, number];
} | null {
  const validCoords = coords.filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
  if (validCoords.length === 0) return null;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of validCoords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { ne: [maxLng, maxLat], sw: [minLng, minLat] };
}

/** Midpoint between two Mapbox [lng, lat] coords. Used for the `accepted`
 *  camera state where we want to frame both the rider's pickup and the
 *  driver's current position at the same time. */
function midpointCoord(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Ride statuses that activate the Uber-style follow camera. Outside this
 *  set the camera falls back to bounds fitting or default settings. */
const FOLLOW_STATUSES = new Set<string>([
  'accepted',
  'driver_en_route',
  'arrived_at_pickup',
  'in_progress',
]);

/** Auto re-engage delay (ms) after a user gesture pauses the follow. */
const FOLLOW_RESUME_DELAY_MS = 8000;

/** Touch box for picking a place, in dp — the platform minimum target. */
const PLACE_TAP_TOLERANCE_DP = 44;

/** Imperative handle for screens that need to move the camera themselves —
 *  today only the vehicle-selection map's "center on me" FAB. Everything
 *  else drives the camera declaratively through props. */
export interface RideMapViewHandle {
  flyTo: (lng: number, lat: number, zoom?: number) => void;
}

function RideMapViewInner({
  pickupLocation,
  dropoffLocation,
  driverLocation,
  driverHeading,
  routeCoordinates,
  waypointLocations,
  waypointStatuses,
  nearbyVehicles,
  driverMarkerOpacity = 1,
  searchingDrivers,
  acceptedDriverId,
  isAcceptAnimating,
  acceptedDriverLocation,
  driverToPickupRoute,
  vehicleType,
  height = 200,
  fullscreen,
  initialUserCenter,
  rideStatus,
  onLongPressMap,
  onPickupDragEnd,
  onDropoffDragEnd,
  driverEtaMinutes,
  routeProgress,
  showPlaces = false,
  onPlacePress,
  show3dBuildings = false,
}: RideMapViewProps, ref: React.Ref<RideMapViewHandle>) {
  ensureMapboxToken();
  const MapboxGL = getMapboxGL();
  const { t } = useTranslation('rider');
  // The app theme, not the OS one: a rider who forces light or dark in
  // Settings expects the map to follow that choice like the rest of the UI.
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);

  // Diagnostic mount log — user reported a ~700px black area where the map
  // should be during the rider `searching` state on iOS. The map renders
  // fine in accepted/driver_en_route/arrived_at_pickup, so the failure is
  // mount-time / state-specific. This log captures the inputs Mapbox got
  // at first render so we can correlate with Sentry / console logs without
  // shipping a heavier instrumentation pass.
  useEffect(() => {
    if (__DEV__) {
      console.log('[RideMapView] mount', {
        hasMapboxGL: !!MapboxGL,
        hasToken: !!process.env.EXPO_PUBLIC_MAPBOX_TOKEN,
        platform: Platform.OS,
        height,
        fullscreen: !!fullscreen,
        hasPickup: !!pickupLocation,
        hasDropoff: !!dropoffLocation,
        rideStatus: rideStatus ?? null,
        showPlaces: !!showPlaces,
        show3dBuildings: !!show3dBuildings,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Style lifecycle gate — layers mounted BEFORE the style finishes loading
  // attach (queryRenderedFeatures sees their features) but their react style
  // is lost in the race, so they draw with Mapbox's DEFAULT paint: black 5px
  // circles, symbol layers with no icon-image at all. The driver app gates
  // its custom layers on this exact event; the client never did.
  const [styleReady, setStyleReady] = useState(false);

  // Ant-march animation — 60fps via requestAnimationFrame + setState throttled
  const [dashStep, setDashStep] = useState(0);
  const dashStepRef = useRef(0);
  const lastFrameRef = useRef(0);
  useEffect(() => {
    if (!routeCoordinates || routeCoordinates.length < 2) return;
    let rafId: number | null = null;
    const animate = (timestamp: number) => {
      // Advance one frame every ~30ms (~33fps — fast and fluid)
      if (timestamp - lastFrameRef.current > 30) {
        lastFrameRef.current = timestamp;
        dashStepRef.current = (dashStepRef.current + 1) % DASH_SEQUENCE.length;
        setDashStep(dashStepRef.current);
      }
      rafId = requestAnimationFrame(animate);
    };
    const start = () => {
      if (rafId === null) rafId = requestAnimationFrame(animate);
    };
    const stop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    // Nobody is watching a marching dash while the app is backgrounded, but
    // the ~33 setState/s it costs keep running during an active ride.
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') start();
      else stop();
    });

    return () => {
      sub.remove();
      stop();
    };
  }, [routeCoordinates]);
  const isDark = resolvedScheme === 'dark';
  const styleURL = isDark ? MAP_STYLE_DARK : MAP_STYLE_LIGHT;
  // A theme toggle swaps the styleURL and Mapbox reloads the whole style.
  // Re-close the gate for the reload: layers that stay mounted through it
  // are re-added mid-load and lose their paint to the same race as on
  // first mount. Closing it also drives the veil below, which turns the
  // piecemeal repaint the user reported into one deliberate transition.
  useEffect(() => {
    setStyleReady(false);
  }, [styleURL]);
  const cameraRef = useRef<any>(null);
  // Native MapView ref — needed to query rendered features (places layer
  // taps) at a screen point. Distinct from cameraRef, which only moves
  // the camera.
  const mapRef = useRef<any>(null);
  React.useImperativeHandle(
    ref,
    () => ({
      flyTo: (lng: number, lat: number, zoom = 16) => {
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
        cameraRef.current?.setCamera({
          centerCoordinate: [lng, lat],
          zoomLevel: zoom,
          animationDuration: 600,
          animationMode: 'flyTo',
        });
      },
    }),
    [],
  );
  // Which nearby vehicle has its callout open, by driver id rather than by
  // coordinate: the vehicle keeps moving, and a bubble frozen where it used
  // to be points at empty road.
  const [tappedVehicleId, setTappedVehicleId] = useState<string | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pickupPulseAnim = useRef(new Animated.Value(1)).current;
  const pickupPulseOpacity = useRef(new Animated.Value(0.6)).current;
  const dropoffScale = useRef(new Animated.Value(0.3)).current;
  // Marker drag state. `draggingRef` keeps a long-press that started a drag
  // from also opening the pin picker; `lastDragCoordRef` tells the ghost
  // swap below that a dropoff change came from the finger, not from search.
  const draggingRef = useRef(false);
  const lastDragCoordRef = useRef<GeoPoint | null>(null);
  const [dropoffGhost, setDropoffGhost] = useState(false);

  // BUG-270: render the driver marker exactly the way the DRIVER's own
  // app does — directly from the latest position, no interpolation. The
  // useAnimatedPosition layer was adding complexity (and a layer where
  // bugs could hide) without any visible benefit. The driver's marker
  // moves perfectly using the raw coordinate; the client now does too.
  // Only build animatedDriver when both lat and lng are finite numbers.
  // When entering "viaje reciente" view a completed ride often has
  // driverLocation with stale or partial coords (lat or lng undefined),
  // and `.toFixed()` downstream blew up the whole map view via the
  // ErrorBoundary. The Number.isFinite() gate filters those out.
  //
  // BUG-293 (Round 3): snap-to-road. During an active ride, project the
  // driver's GPS onto the closest segment of the route polyline so the
  // marker visually tracks the actual road, and use the segment's bearing
  // for the marker rotation. Without this, Lockito's linear interpolation
  // (mock GPS) leaves the marker drifting through buildings/parks AND
  // rotating in directions that don't match the visible road. If the
  // driver is genuinely >30m off the polyline, snap returns null and we
  // fall back to the raw GPS (don't hide a real detour).
  const snappedDriver = useMemo(() => {
    if (!driverLocation || !routeCoordinates) return null;
    if (!Number.isFinite(driverLocation.latitude) || !Number.isFinite(driverLocation.longitude)) {
      return null;
    }
    return snapDriverToRoute(
      { latitude: driverLocation.latitude, longitude: driverLocation.longitude },
      routeCoordinates,
      30,
    );
  }, [
    driverLocation?.latitude,
    driverLocation?.longitude,
    routeCoordinates,
  ]);

  // BUG-298: smooth the effective bearing with EMA to dampen the discrete
  // jumps that happen when `snapDriverToRoute` switches polyline segments
  // along a curve. Without this, the marker rotation "ticks" 5-15° on each
  // segment change in a smooth curve. Since the client camera also reads
  // `animatedDriver.heading` (see cameraProfile), smoothing here also
  // keeps the icon and the street geometry in sync.
  //
  // Implementation: heading goes through useState + useEffect rather than
  // useMemo + ref mutation (anti-pattern: StrictMode runs useMemo twice
  // → ref overwritten twice → over-smoothing in dev). Position stays in
  // useMemo because it's a pure derivation.
  const lastSmoothedHeadingRef = useRef<number | null>(null);
  const [smoothedDriverHeading, setSmoothedDriverHeading] = useState<number>(0);

  useEffect(() => {
    if (
      !driverLocation ||
      !Number.isFinite(driverLocation.latitude) ||
      !Number.isFinite(driverLocation.longitude)
    ) {
      return;
    }
    // Bearing precedence (BUG-293):
    //   1. polyline segment bearing (most stable visually — always
    //      aligned with the road the driver is on)
    //   2. explicit driverHeading prop (GPS hardware or computed
    //      bearing from useDriverLocation v3)
    //   3. heading on driverLocation object (legacy fallback)
    const rawTarget =
      (snappedDriver != null ? snappedDriver.bearing : null) ??
      (Number.isFinite(driverHeading) ? (driverHeading as number) : null) ??
      (Number.isFinite((driverLocation as { heading?: number | null }).heading)
        ? ((driverLocation as { heading?: number | null }).heading as number)
        : null);

    if (rawTarget == null) return;
    const prev = lastSmoothedHeadingRef.current;
    const next = smoothHeading(rawTarget, prev);
    lastSmoothedHeadingRef.current = next;
    setSmoothedDriverHeading(next);
    // PR G — heading source decision visibility. Tag which input the
    // EMA consumed so QA can correlate marker rotation with snap vs
    // GPS vs prop heading.
    const sourceTag: 'snap' | 'ema' = snappedDriver?.bearing != null ? 'snap' : 'ema';
    mapLogger.markerHeading({
      source: sourceTag,
      value: next,
      prev: prev,
      delta: prev == null ? undefined : (((next - prev + 540) % 360) - 180),
      app: 'client',
    });
  }, [
    driverLocation?.latitude,
    driverLocation?.longitude,
    (driverLocation as { heading?: number | null } | null)?.heading,
    snappedDriver?.bearing,
    driverHeading,
  ]);

  // PR B — interpolate the heading at ~30 FPS between server samples
  // (driver location lands in the client roughly every 3-5 s via the
  // DB polling hook). Without this, every sample produced a discrete
  // jump in BOTH the marker rotation AND the camera bearing — combined
  // with the bearing-doubling fix from PR A, the residual UX still felt
  // "jerky" relative to the driver app (which has 1 Hz GPS + no network
  // latency). useAnimatedHeading rotates along the shortest arc and
  // snaps if the delta crosses HEADING_SNAP_THRESHOLD_DEG (60°) so
  // sharp turns at intersections don't visually drag.
  const animatedDriverHeading = useAnimatedHeading(smoothedDriverHeading, 1000);

  const animatedDriver = useMemo(() => {
    if (
      !driverLocation ||
      !Number.isFinite(driverLocation.latitude) ||
      !Number.isFinite(driverLocation.longitude)
    ) {
      return null;
    }
    return {
      latitude: snappedDriver?.latitude ?? driverLocation.latitude,
      longitude: snappedDriver?.longitude ?? driverLocation.longitude,
      heading: animatedDriverHeading ?? smoothedDriverHeading,
    };
  }, [
    driverLocation?.latitude,
    driverLocation?.longitude,
    snappedDriver?.latitude,
    snappedDriver?.longitude,
    smoothedDriverHeading,
    animatedDriverHeading,
  ]);
  // DEBUG-271: log every time the marker coordinate changes so we can
  // see in the rider's Metro log whether the prop chain is delivering
  // fresh positions to MarkerView.
  // Interpolation re-renders at ~30 FPS, so building coordKey in release
  // builds is pure waste — the whole block stays behind __DEV__.
  const lastLoggedCoordRef = useRef<string>('');
  if (__DEV__ && animatedDriver) {
    const coordKey = `${animatedDriver.latitude.toFixed(5)},${animatedDriver.longitude.toFixed(5)},${animatedDriver.heading.toFixed(0)}`;
    if (lastLoggedCoordRef.current !== coordKey) {
      lastLoggedCoordRef.current = coordKey;
      // eslint-disable-next-line no-console
      console.log('[RideMapView] driver marker coord =', coordKey);
    }
  }

  // BUG-marker-position-lag (2026-05-24): the driver MarkerView used to
  // re-mount on every coord change (1 Hz polling cadence). Replaced with
  // ShapeSource + SymbolLayer (which DOES update without remount), and
  // interpolate the coord client-side at ~30 FPS so the marker slides
  // continuously between server samples — Uber/Bolt style.
  const renderedDriverCoord = useAnimatedCoordinate(
    animatedDriver
      ? { latitude: animatedDriver.latitude, longitude: animatedDriver.longitude }
      : null,
    1000, // matches useDriverPosition poll cadence
  );

  // Pulse radius listener — the CircleLayer can't read Animated.Value
  // natively, so we mirror the animated value into React state. The
  // animation loop is started/stopped by the existing useEffect below
  // (which targets `pulseAnim`).
  const [pulseRadiusPx, setPulseRadiusPx] = useState<number>(MARKER.driver.ringSize / 2);
  useEffect(() => {
    const baseRadius = MARKER.driver.ringSize / 2;
    const id = pulseAnim.addListener(({ value }) => {
      // pulseAnim oscillates 1.0 ↔ 1.3 — multiply by base radius to get px
      setPulseRadiusPx(baseRadius * value);
    });
    return () => pulseAnim.removeListener(id);
  }, [pulseAnim]);

  // Pulsing animation for driver marker
  useEffect(() => {
    if (!driverLocation) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.3, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [driverLocation, pulseAnim]);

  // Pulsing ring animation for pickup marker
  useEffect(() => {
    if (!pickupLocation) return;
    const animation = Animated.loop(
      Animated.parallel([
        Animated.timing(pickupPulseAnim, { toValue: 2.5, duration: 2000, useNativeDriver: true }),
        Animated.timing(pickupPulseOpacity, { toValue: 0, duration: 2000, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pickupLocation, pickupPulseAnim, pickupPulseOpacity]);

  // Bounce-in animation for dropoff marker
  useEffect(() => {
    if (!dropoffLocation) return;
    dropoffScale.setValue(0.3);
    const animation = Animated.spring(dropoffScale, {
      toValue: 1,
      tension: 80,
      friction: 6,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [dropoffLocation, dropoffScale]);

  // Ghost swap (draggable dropoff only). The bounce above runs on a
  // MarkerView, which PointAnnotation cannot animate (BUG-307: it snapshots
  // its children). So for ~600 ms after a programmatic change the animated
  // MarkerView is shown, then the static draggable PointAnnotation takes
  // over. A change that came from a drag skips the bounce — the pin is
  // already where the finger left it.
  useEffect(() => {
    if (!onDropoffDragEnd || !dropoffLocation) {
      setDropoffGhost(false);
      return;
    }
    if (coordsEqual(lastDragCoordRef.current, dropoffLocation)) {
      setDropoffGhost(false);
      return;
    }
    setDropoffGhost(true);
    const timer = setTimeout(() => setDropoffGhost(false), 600);
    return () => clearTimeout(timer);
  }, [dropoffLocation, onDropoffDragEnd]);

  // Build route GeoJSON from coordinates (static — no animation)
  const routeGeoJSON = useMemo(() => {
    if (!routeCoordinates || routeCoordinates.length < 2) return null;
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: routeCoordinates.map(c => [c.longitude, c.latitude]),
      },
      properties: {},
    };
  }, [routeCoordinates]);

  // Build driver-to-pickup route GeoJSON
  const driverRouteGeoJSON = useMemo(() => {
    if (!driverToPickupRoute || driverToPickupRoute.length < 2) return null;
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: driverToPickupRoute.map(toCoord),
      },
      properties: {},
    };
  }, [driverToPickupRoute]);

  // The prop arrives in bursts (15 s in production, 1 s in the demo
  // preview); this turns those jumps into motion.
  const vehicleTargets = useMemo(
    () => (nearbyVehicles ?? []).map((v) => ({
      id: v.driver_profile_id,
      latitude: v.latitude,
      longitude: v.longitude,
      heading: v.heading ?? 0,
      vehicleType: v.vehicle_type || 'auto',
    })),
    [nearbyVehicles],
  );
  const animatedVehicles = useAnimatedVehicles(vehicleTargets);

  // Build nearby vehicles GeoJSON FeatureCollection
  const nearbyGeoJSON = useMemo(() => {
    if (animatedVehicles.length === 0) return null;
    return {
      type: 'FeatureCollection' as const,
      features: animatedVehicles.map((v) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [v.longitude, v.latitude],
        },
        properties: {
          id: v.id,
          icon: `marker-${v.vehicleType}`,
          // The SymbolLayer below reads ['get','heading'] for iconRotate.
          // Without this property every nearby vehicle rendered facing north.
          heading: v.heading,
          opacity: v.opacity,
        },
      })),
    };
  }, [animatedVehicles]);

  // The open callout, resolved against the CURRENT vehicle list on every
  // render: it follows the vehicle as it moves and disappears on its own
  // when that driver goes offline or leaves the radius. Deriving it beats
  // clearing it on every poll, which would have closed the bubble every
  // 15 seconds (every second in the demo preview) whether or not the
  // vehicle had actually gone anywhere.
  // Gate on the formatted string, not the raw number: Infinity passes a
  // `> 0` check but formats to null, which would leave an empty pill
  // floating over the driver.
  const driverEtaLabel = formatVehicleEtaMinutes(driverEtaMinutes);

  const tappedVehicle = useMemo(() => {
    if (!tappedVehicleId || !nearbyVehicles) return null;
    const v = nearbyVehicles.find((n) => n.driver_profile_id === tappedVehicleId);
    if (!v || !Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) return null;
    // Two positions on purpose. The bubble is ANCHORED to the interpolated
    // one so it rides with the icon instead of drifting away from it while
    // the vehicle slides, but the distance is MEASURED from the reported
    // one, which is the only position the server actually vouched for.
    const drawn = animatedVehicles.find((a) => a.id === tappedVehicleId);
    const anchor: [number, number] = drawn
      ? [drawn.longitude, drawn.latitude]
      : [v.longitude, v.latitude];
    // No pickup means no point to measure from, so fall back to how far the
    // vehicle is from the map's own reference point.
    const from = pickupLocation ?? null;
    const distanceM = from
      ? haversineDistance(from, { latitude: v.latitude, longitude: v.longitude })
      : null;
    const eta = formatVehicleEtaMinutes(estimateVehicleEtaMinutes(distanceM));
    const dist = formatVehicleDistance(distanceM);
    // Nothing to say means no bubble at all, rather than an empty one.
    const label = eta
      ? t('map.vehicle_eta', { eta })
      : dist
        ? t('map.vehicle_distance', { distance: dist })
        : null;
    if (!label) return null;
    return { coordinate: anchor, label };
  }, [tappedVehicleId, nearbyVehicles, animatedVehicles, pickupLocation, t]);

  // Compute camera bounds (includes searching driver positions)
  // BUG-229: stabilize bounds via primitive lat/lng deps. Object refs
  // change every render even if values are identical → bounds recomputes
  // → Camera snaps the viewport every render → user can't pan freely.
  // We use string keys for arrays so React's useMemo correctly compares.
  const pickupLat = pickupLocation?.latitude;
  const pickupLng = pickupLocation?.longitude;
  const dropoffLat = dropoffLocation?.latitude;
  const dropoffLng = dropoffLocation?.longitude;
  const driverLat = animatedDriver?.latitude;
  const driverLng = animatedDriver?.longitude;
  // Coord-array keys: filter to entries with finite lat/lng before
  // toFixed-ing them. Without the filter, a single undefined coord in
  // routeCoordinates blows up the whole map render via ErrorBoundary.
  const routeKey = useMemo(
    () =>
      routeCoordinates
        ?.filter((c) => Number.isFinite(c?.latitude) && Number.isFinite(c?.longitude))
        .map((c) => `${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}`)
        .join('|') ?? '',
    [routeCoordinates],
  );
  const driverRouteKey = useMemo(
    () =>
      driverToPickupRoute
        ?.filter((c) => Number.isFinite(c?.latitude) && Number.isFinite(c?.longitude))
        .map((c) => `${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}`)
        .join('|') ?? '',
    [driverToPickupRoute],
  );

  const bounds = useMemo(() => {
    // During accept animation, don't recompute bounds — let the Camera flyTo handle it
    if (isAcceptAnimating) return null;

    // BUG-231: only fit the trip route (pickup → dropoff). Including the
    // driver position can push bounds out to a multi-km area when the
    // driver hasn't arrived at pickup yet, making the route look like
    // an inscrutable thin line. Driver remains a moving marker that may
    // sit outside the initial viewport — that's fine, the user can pan
    // to find them, and we show driver→pickup route as a separate hint.
    const allCoords: [number, number][] = [];
    if (routeCoordinates && routeCoordinates.length > 0) {
      routeCoordinates.forEach((c) => allCoords.push(toCoord(c)));
    } else {
      if (pickupLocation) allCoords.push(toCoord(pickupLocation));
      if (dropoffLocation) allCoords.push(toCoord(dropoffLocation));
    }
    waypointLocations?.forEach((wp) => allCoords.push(toCoord(wp)));
    // BUG-284 — searching drivers used to be added to bounds so the rider
    // could see incoming offers, but when a matched driver lived 500 m+
    // away the camera zoomed all the way out to fit them ("el client se
    // aleja en el mapa"). The driver marker itself is still rendered at
    // its real coordinate and visible if the rider pans the map. The
    // initial fit now stays tight to pickup→dropoff (or the static
    // route polyline before in_progress).
    return computeBounds(allCoords);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickupLat, pickupLng, dropoffLat, dropoffLng, routeKey, isAcceptAnimating]);

  // BUG-229 + BUG-286: only push bounds to Mapbox Camera when something
  // MEANINGFUL changes — i.e. the RIDE itself (pickup/dropoff) changed.
  //
  // The previous implementation compared `boundsKey`, the bbox of the
  // current bounds set. But `bounds` is computed from `routeCoordinates`
  // when available — and `useLiveDriverRoute` refetches the polyline
  // every time the driver deviates >50 m. Each refetch produces a
  // slightly different bbox, so `boundsKey` changed, `activeBounds`
  // re-applied the new bounds, and the camera snapped to fit them.
  // User reported: "cada vez que se actualiza la ruta, el client aleja
  // el mapa". This was the cause.
  //
  // New rule: track a `rideKey` derived only from pickup + dropoff
  // (the immutable identity of the ride). The polyline can update
  // freely during in_progress without triggering a camera refit. The
  // camera only re-snaps when the user is on a brand-new ride.
  const [hasFitInitially, setHasFitInitially] = useState(false);
  const lastFitRideKey = useRef('');
  const rideKey = `${pickupLat ?? ''},${pickupLng ?? ''}|${dropoffLat ?? ''},${dropoffLng ?? ''}`;

  const activeBounds = useMemo(() => {
    if (!bounds) return null;
    if (!hasFitInitially) return bounds;
    if (rideKey === lastFitRideKey.current) return null;
    return bounds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideKey, hasFitInitially]);

  useEffect(() => {
    if (bounds && !hasFitInitially) {
      setHasFitInitially(true);
      lastFitRideKey.current = rideKey;
    } else if (bounds && hasFitInitially && rideKey !== lastFitRideKey.current) {
      // A brand-new ride started — record its key so we don't keep snapping.
      lastFitRideKey.current = rideKey;
    }
  }, [bounds, hasFitInitially, rideKey]);

  // A marker was dropped. The camera re-fits bounds whenever the
  // pickup+dropoff key changes, so record the key the parent's update will
  // produce BEFORE it lands — otherwise every drag ends with the map jumping
  // away from the finger.
  const handleMarkerDragEnd = useCallback((target: 'pickup' | 'dropoff', payload: unknown) => {
    draggingRef.current = false;
    const coords = (payload as { geometry?: { coordinates?: unknown } } | null)?.geometry?.coordinates;
    if (!Array.isArray(coords)) return;
    const [lng, lat] = coords as [number, number];
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    lastFitRideKey.current = target === 'pickup'
      ? `${lat},${lng}|${dropoffLat ?? ''},${dropoffLng ?? ''}`
      : `${pickupLat ?? ''},${pickupLng ?? ''}|${lat},${lng}`;
    if (target === 'dropoff') lastDragCoordRef.current = { latitude: lat, longitude: lng };
    void triggerHaptic('light');
    (target === 'pickup' ? onPickupDragEnd : onDropoffDragEnd)?.(lng, lat);
  }, [pickupLat, pickupLng, dropoffLat, dropoffLng, onPickupDragEnd, onDropoffDragEnd]);

  // ─── BUG-267 v3: Uber-style camera follow ──────────────────────────────
  // When the ride is between `accepted` and `in_progress` we keep the
  // camera centered on the driver with a state-specific cinematic
  // profile (zoom + pitch + heading-up). User pan/zoom pauses the
  // follow for FOLLOW_RESUME_DELAY_MS (8 s); a tappable FAB lets them
  // re-engage instantly.
  const isRideActive = useMemo(
    () => rideStatus != null && FOLLOW_STATUSES.has(rideStatus),
    [rideStatus],
  );

  const [userOverride, setUserOverride] = useState(false);
  const overrideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleUserGesture = useCallback(() => {
    setUserOverride(true);
    if (overrideTimerRef.current) clearTimeout(overrideTimerRef.current);
    overrideTimerRef.current = setTimeout(
      () => setUserOverride(false),
      FOLLOW_RESUME_DELAY_MS,
    );
  }, []);

  const handleRecenter = useCallback(() => {
    if (overrideTimerRef.current) {
      clearTimeout(overrideTimerRef.current);
      overrideTimerRef.current = null;
    }
    setUserOverride(false);
  }, []);

  // Clear any pending timer on unmount.
  useEffect(() => {
    return () => {
      if (overrideTimerRef.current) {
        clearTimeout(overrideTimerRef.current);
        overrideTimerRef.current = null;
      }
    };
  }, []);

  // Reset override when ride leaves follow states (e.g. completed/cancelled).
  useEffect(() => {
    if (!isRideActive && userOverride) setUserOverride(false);
  }, [isRideActive, userOverride]);

  const cameraProfile = useMemo(() => {
    if (!isRideActive || !animatedDriver) return null;
    const driverCoord: [number, number] = [
      animatedDriver.longitude,
      animatedDriver.latitude,
    ];
    const heading = Number.isFinite(animatedDriver.heading)
      ? (animatedDriver.heading as number)
      : 0;

    switch (rideStatus) {
      case 'accepted': {
        // Driver just accepted — frame BOTH user (pickup) and driver.
        const userCoord = pickupLocation ? toCoord(pickupLocation) : driverCoord;
        return {
          centerCoordinate: midpointCoord(userCoord, driverCoord),
          zoomLevel: 14,
          pitch: 0,
          heading: 0,
          animationDuration: 1500,
          animationMode: 'flyTo' as const,
        };
      }
      case 'driver_en_route':
        return {
          centerCoordinate: driverCoord,
          zoomLevel: 15.5,
          pitch: 30,
          heading,
          animationDuration: 1000,
          animationMode: 'easeTo' as const,
        };
      case 'arrived_at_pickup':
        return {
          centerCoordinate: driverCoord,
          zoomLevel: 17.5,
          pitch: 50,
          heading,
          animationDuration: 800,
          animationMode: 'easeTo' as const,
        };
      case 'in_progress': {
        // If approaching drop-off, slightly tighten zoom/pitch so the
        // rider can see the final destination resolve into view.
        const driverGeo = {
          latitude: animatedDriver.latitude,
          longitude: animatedDriver.longitude,
        };
        const distToDrop = dropoffLocation
          ? haversineDistance(driverGeo, dropoffLocation)
          : Infinity;
        const nearDrop = distToDrop < 500;
        return {
          centerCoordinate: driverCoord,
          zoomLevel: nearDrop ? 17.5 : 17,
          pitch: nearDrop ? 50 : 45,
          heading,
          animationDuration: 800,
          animationMode: 'easeTo' as const,
        };
      }
      default:
        return null;
    }
    // animatedDriver intentionally tracked via lat/lng/heading primitives
    // below to avoid invalidating the memo on each parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isRideActive,
    rideStatus,
    animatedDriver?.latitude,
    animatedDriver?.longitude,
    animatedDriver?.heading,
    pickupLat,
    pickupLng,
    dropoffLat,
    dropoffLng,
  ]);

  // PR G — surface camera profile transitions so QA can see exactly
  // which zoom/pitch/bearing was applied for each rideStatus on the
  // client side. Fires only when the memo recomputes (i.e. status
  // changed or driver moved by enough to flip the profile branch).
  useEffect(() => {
    if (!cameraProfile) return;
    mapLogger.cameraProfile({
      rideStatus: rideStatus ?? null,
      zoom: cameraProfile.zoomLevel ?? 0,
      pitch: cameraProfile.pitch ?? 0,
      bearing: cameraProfile.heading ?? 0,
      mode: cameraProfile.animationMode ?? 'easeTo',
      followMode: !userOverride,
      app: 'client',
    });
  }, [cameraProfile, rideStatus, userOverride]);

  const showFollowOverlayFab = isRideActive && userOverride;

  if (!MapboxGL) {
    // On web, use WebMapView with mapbox-gl instead of native @rnmapbox/maps
    if (Platform.OS === 'web') {
      return (
        <WebMapView
          pickup={pickupLocation ? { latitude: pickupLocation.latitude, longitude: pickupLocation.longitude } : null}
          dropoff={dropoffLocation ? { latitude: dropoffLocation.latitude, longitude: dropoffLocation.longitude } : null}
          routeCoords={routeCoordinates?.map(c => [c.longitude, c.latitude] as [number, number])}
          driverRoute={driverToPickupRoute?.map(c => [c.longitude, c.latitude] as [number, number])}
          style={{ height, borderRadius: 12, overflow: 'hidden' } as any}
        />
      );
    }
    return (
      <View
        style={{
          height,
          backgroundColor: isDark ? darkColors.background.tertiary : colors.neutral[100],
          justifyContent: 'center',
          alignItems: 'center',
          borderRadius: 12,
        }}
      >
        <Text style={{ color: isDark ? darkColors.text.secondary : colors.neutral[500] }} accessibilityRole="alert">{t('map.unavailable')}</Text>
      </View>
    );
  }

  return (
    <View style={fullscreen ? { flex: 1 } : { height, borderRadius: 12, overflow: 'hidden' }} accessibilityLabel={t('map.ride_map')}>
      <MapboxGL.MapView
        ref={mapRef}
        style={{ flex: 1 }}
        styleURL={styleURL}
        attributionEnabled={false}
        logoEnabled={false}
        compassEnabled={false}
        scaleBarEnabled={false}
        zoomEnabled={true}
        scrollEnabled={true}
        pitchEnabled={true}
        rotateEnabled={true}
        // BUG-267 v3: pause the Uber follow while the user is exploring
        // the map. onTouchStart on the underlying View fires on any
        // touch (tap/pan/pinch begins). Combined with the 8s resume
        // timer in handleUserGesture, this prevents the camera from
        // fighting the user's finger.
        onTouchStart={isRideActive ? handleUserGesture : undefined}
        onDidFinishLoadingStyle={() => setStyleReady(true)}
        onLongPress={onLongPressMap ? async (feature: any) => {
          if (draggingRef.current) return;
          const coords = feature?.geometry?.coordinates;
          if (!Array.isArray(coords)) return;
          const [lng, lat] = coords;
          if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
          // A long-press ON a draggable marker is the start of a drag, not a
          // request to pick a new point there. Compared in screen space so
          // the tolerance is a thumb, whatever the zoom.
          if (onPickupDragEnd || onDropoffDragEnd) {
            const sx = feature?.properties?.screenPointX;
            const sy = feature?.properties?.screenPointY;
            if (Number.isFinite(sx) && Number.isFinite(sy)) {
              try {
                const targets = [pickupLocation, dropoffLocation].filter(
                  (c): c is GeoPoint => !!c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude),
                );
                const points = await Promise.all(targets.map(async (c) => {
                  const p = await mapRef.current?.getPointInView([c.longitude, c.latitude]);
                  return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
                    ? { x: p[0] as number, y: p[1] as number }
                    : null;
                }));
                if (draggingRef.current || isNearScreenPoint({ x: sx, y: sy }, points)) return;
              } catch {
                // A failed projection must not swallow the gesture.
              }
            }
          }
          void triggerHaptic('medium');
          onLongPressMap(lng, lat);
        } : undefined}
        onPress={showPlaces && onPlacePress ? async (feature: any) => {
          const x = feature?.properties?.screenPointX;
          const y = feature?.properties?.screenPointY;
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          try {
            // Query a finger-sized box, not the exact pixel. A place icon is
            // about 20 dp tall; asking for the single point under the touch
            // means most honest taps land beside it and silently do nothing,
            // which reads as a broken map.
            const half = PLACE_TAP_TOLERANCE_DP / 2;
            const hits = await mapRef.current?.queryRenderedFeaturesInRect(
              [y - half, x - half, y + half, x + half],
              undefined,
              [POI_LAYER_ID],
            );
            const hit = hits?.features?.[0];
            const name = poiNameFromFeature(hit);
            const coords = (hit?.geometry as { coordinates?: number[] } | undefined)?.coordinates;
            // An unnamed place is not a destination anyone can confirm.
            if (!name || !Array.isArray(coords)) return;
            const [lng, lat] = coords;
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
            void triggerSelection();
            onPlacePress(name, lng as number, lat as number);
          } catch {
            // A failed query just means no place was chosen.
          }
        } : undefined}
      >
        {/* Camera — fit to bounds, or flyTo accepted driver, or default to
            initialUserCenter (BUG-282) / Havana fallback.
            `defaultSettings` only applies on first mount. AsyncStorage
            cache reads asynchronously, so the first render is null →
            camera defaults to HAVANA_CENTER (São Paulo). Once the cache
            resolves, `initialUserCenter` becomes non-null and the `key`
            changes, forcing the Camera to remount with the user's actual
            position. After that, activeBounds takes over once pickup/
            dropoff/driver are known and bounds are computed. */}
        <MapboxGL.Camera
          ref={cameraRef}
          key={`cam-${
            initialUserCenter &&
            Number.isFinite(initialUserCenter[0]) &&
            Number.isFinite(initialUserCenter[1])
              ? `${initialUserCenter[0].toFixed(4)},${initialUserCenter[1].toFixed(4)}`
              : 'fallback'
          }`}
          defaultSettings={{
            centerCoordinate: initialUserCenter ?? HAVANA_CENTER,
            zoomLevel: 14,
          }}
          {...(isAcceptAnimating && acceptedDriverLocation
            ? {
                centerCoordinate: toCoord(acceptedDriverLocation),
                zoomLevel: 15,
                pitch: 45,
                animationDuration: 1500,
                animationMode: 'flyTo',
              }
            : cameraProfile && !userOverride
              ? cameraProfile
              : activeBounds
                ? {
                    bounds: {
                      ne: activeBounds.ne,
                      sw: activeBounds.sw,
                      // BUG-231: tighter padding so the route fills more of
                      // the viewport. Combined with bounds excluding driver
                      // position (which could be 8+ km away), the rider
                      // sees the pickup→dropoff trip clearly.
                      paddingTop: 60,
                      paddingRight: 60,
                      paddingBottom: 60,
                      paddingLeft: 60,
                    },
                    // BUG-231 v2: NO minZoomLevel — was blocking the user
                    // from zooming out. Only cap max so we don't fly to
                    // building-level when bounds are tiny.
                    maxZoomLevel: 16,
                    animationDuration: 500,
                  }
                : {})}
        />

        {/* The rider on their own map. Until now the app drew the rider's
            position on the DRIVER's map (via useRiderLocationSharing) but
            never here, so the passenger watched a map they weren't in.
            Renders nothing when location permission is denied. */}
        <MapboxGL.LocationPuck
          visible
          puckBearing="heading"
          puckBearingEnabled
          // Brand orange, not MAP_COLORS.driver: blue is what the vehicles
          // you're waiting for are painted in. You are not one of them.
          pulsing={{ isEnabled: true, color: MAP_COLORS.brand, radius: 'accuracy' }}
        />

        {/* Places, drawn from the data already inside the downloaded tiles.
            Icons only: the name appears on tap, so the map stays readable
            and we avoid map-layer text entirely. */}
        {showPlaces && styleReady && <PlacesLayer isDark={isDark} />}

        {show3dBuildings && styleReady && (
          <MapboxGL.FillExtrusionLayer
            id="tricigo-buildings"
            sourceID={POI_SOURCE_ID}
            sourceLayerID="building"
            minZoomLevel={15}
            filter={['==', ['get', 'extrude'], 'true'] as never}
            style={{
              fillExtrusionColor: isDark ? '#2a2a3e' : '#dcdcdc',
              fillExtrusionHeight: ['get', 'height'],
              fillExtrusionBase: ['get', 'min_height'],
              // Not data-driven for this property — a single value only.
              fillExtrusionOpacity: 0.6,
            }}
          />
        )}

        {/* Driver-to-pickup route (light blue dashed) */}
        {driverRouteGeoJSON && (
          <MapboxGL.ShapeSource id="driver-to-pickup-route" shape={driverRouteGeoJSON}>
            <MapboxGL.LineLayer
              id="driverRouteLine"
              style={{
                lineColor: ROUTE.driverTo.color,
                lineWidth: ROUTE.driverTo.width,
                lineDasharray: ROUTE.driverTo.dashArray,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </MapboxGL.ShapeSource>
        )}

        {/* Route polyline — shadow + main line + travelled progress.
            `lineMetrics` is what makes the progress layer's lineTrimOffset
            work. Without it the trim is ignored and that layer paints the
            WHOLE route green — wider and more opaque than the blue line
            beneath it, so 2% into a trip the rider would see a fully
            travelled route. The style validator gates on exactly this flag. */}
        {routeGeoJSON && (
          <MapboxGL.ShapeSource id="route" lineMetrics shape={routeGeoJSON}>
            <MapboxGL.LineLayer
              id="routeShadow"
              style={{
                lineColor: ROUTE.shadow.color,
                lineWidth: ROUTE.shadow.width,
                lineOpacity: ROUTE.shadow.opacity,
                lineBlur: ROUTE.shadow.blur,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
            <MapboxGL.LineLayer
              id="routeLine"
              style={{
                lineColor: ROUTE.main.color,
                lineWidth: ROUTE.main.width,
                lineOpacity: ROUTE.main.opacity,
                lineDasharray: DASH_SEQUENCE[dashStep],
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
            {routeProgress != null && routeProgress > 0 && (
              <MapboxGL.LineLayer
                id="routeProgress"
                style={{
                  lineColor: ROUTE.progress.color,
                  lineWidth: ROUTE.progress.width,
                  lineOpacity: ROUTE.progress.opacity,
                  // Hide everything ahead of the driver; what stays painted
                  // is the part already travelled.
                  lineTrimOffset: [Math.min(1, Math.max(0, routeProgress)), 1],
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
              />
            )}
          </MapboxGL.ShapeSource>
        )}

        {/* Pickup marker — premium 3D with pulsing ring */}
        {pickupLocation && (
          <MapboxGL.PointAnnotation
            id="pickup"
            coordinate={toCoord(pickupLocation)}
            draggable={!!onPickupDragEnd}
            onDragStart={onPickupDragEnd ? () => { draggingRef.current = true; } : undefined}
            onDragEnd={onPickupDragEnd ? (p: unknown) => handleMarkerDragEnd('pickup', p) : undefined}
          >
            <View style={{ width: MARKER.driver.ringSize, height: MARKER.driver.ringSize, alignItems: 'center', justifyContent: 'center' }}>
              {/* Pulsing ring */}
              <Animated.View
                style={{
                  position: 'absolute',
                  width: MARKER.pickup.size,
                  height: MARKER.pickup.size,
                  borderRadius: MARKER.pickup.size / 2,
                  backgroundColor: MAP_COLORS.pickup,
                  transform: [{ scale: pickupPulseAnim }],
                  opacity: pickupPulseOpacity,
                }}
              />
              {/* Main circle */}
              <View
                style={{
                  width: MARKER.pickup.size,
                  height: MARKER.pickup.size,
                  borderRadius: MARKER.pickup.size / 2,
                  backgroundColor: MAP_COLORS.pickup,
                  borderWidth: 3,
                  borderColor: 'white',
                  shadowColor: MAP_COLORS.pickup,
                  shadowOpacity: 0.35,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 3 },
                  elevation: 6,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <View style={{ width: MARKER.pickup.innerDot, height: MARKER.pickup.innerDot, borderRadius: 5, backgroundColor: 'white' }} />
              </View>
            </View>
          </MapboxGL.PointAnnotation>
        )}

        {/* BUG-281 — Dropoff marker uses the branded TriciGo pin asset
            (white silhouette tinted brand-orange). Anchored at y:1 so the
            pin's tip points to the actual coordinate.
         *
         *  BUG-307 — switched from PointAnnotation to MarkerView for the
         *  same reason BUG-274 fixed the driver marker: PointAnnotation
         *  takes a NATIVE SNAPSHOT of the React child at mount and never
         *  re-snapshots when transform animations update. The bounce-in
         *  scale (0.3 → 1) ran only on the JS side, so the rendered pin
         *  stayed at 30% size — visually invisible. BUG-285's "explicit
         *  width/height on wrapper" fix never addressed this; the snapshot
         *  was 44×44 but always at scale 0.3.
         *
         *  MarkerView renders the actual React tree, so the Animated.spring
         *  on dropoffScale animates visually too. The `key` derived from
         *  coordinates forces a remount when the destination changes (same
         *  trick as the driver MarkerView), so position updates land
         *  reliably on Android.
         *
         *  Dragging is opt-in through onPickupDragEnd / onDropoffDragEnd,
         *  which only the vehicle-selection map passes. There the dropoff is
         *  a draggable PointAnnotation (the only annotation with a drag API)
         *  and this MarkerView plays the bounce as a short-lived "ghost" —
         *  see the ghost-swap effect. Everywhere else (review, active ride)
         *  the pins stay fixed and this MarkerView is the only dropoff. */}
        {dropoffLocation &&
          Number.isFinite(dropoffLocation.latitude) &&
          Number.isFinite(dropoffLocation.longitude) &&
          (!onDropoffDragEnd || dropoffGhost) && (
          <MapboxGL.MarkerView
            id="dropoff"
            key={`dropoff-${dropoffLocation.latitude.toFixed(5)}-${dropoffLocation.longitude.toFixed(5)}`}
            coordinate={toCoord(dropoffLocation)}
            anchor={{ x: 0.5, y: 1 }}
          >
            <Animated.View
              style={{
                width: MARKER.dropoffPin.size,
                height: MARKER.dropoffPin.size,
                alignItems: 'center',
                justifyContent: 'center',
                transform: [{ scale: dropoffScale }],
                shadowColor: '#000',
                shadowOpacity: 0.3,
                shadowRadius: 4,
                shadowOffset: { width: 0, height: 2 },
                elevation: 6,
              }}
            >
              <Image
                source={require('../../assets/markers/dropoff-pin.png')}
                style={{ width: MARKER.dropoffPin.size, height: MARKER.dropoffPin.size, tintColor: MAP_COLORS.brand }}
                resizeMode="contain"
                accessibilityLabel={t('map.dropoff_marker')}
              />
            </Animated.View>
          </MapboxGL.MarkerView>
        )}

        {/* Draggable dropoff — static children only (Android renders a
            PointAnnotation's children to a bitmap at mount). Long-press the
            pin, move it, lift: onDragEnd carries the new [lng, lat]. */}
        {dropoffLocation &&
          Number.isFinite(dropoffLocation.latitude) &&
          Number.isFinite(dropoffLocation.longitude) &&
          onDropoffDragEnd && !dropoffGhost && (
          <MapboxGL.PointAnnotation
            id="dropoff-draggable"
            coordinate={toCoord(dropoffLocation)}
            anchor={{ x: 0.5, y: 1 }}
            draggable
            onDragStart={() => { draggingRef.current = true; }}
            onDragEnd={(p: unknown) => handleMarkerDragEnd('dropoff', p)}
          >
            <View
              style={{
                width: MARKER.dropoffPin.size,
                height: MARKER.dropoffPin.size,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Image
                source={require('../../assets/markers/dropoff-pin.png')}
                style={{ width: MARKER.dropoffPin.size, height: MARKER.dropoffPin.size, tintColor: MAP_COLORS.brand }}
                resizeMode="contain"
                accessibilityLabel={t('map.dropoff_marker')}
              />
            </View>
          </MapboxGL.PointAnnotation>
        )}

        {/* Waypoint markers — Cuban Modern StopMarker. Taller (36px)
         *  so it's legible over the map; the first "current" pulses
         *  via its internal animation to signal the next stop. */}
        {waypointLocations?.map((wp, idx) => {
          const status = waypointStatuses?.[idx] ?? 'pending';
          return (
            <MapboxGL.PointAnnotation
              key={`waypoint-${idx}`}
              id={`waypoint-${idx}`}
              coordinate={toCoord(wp)}
            >
              <StopMarker
                index={idx + 1}
                status={status}
                size={36}
                mode={isDark ? 'dark' : 'light'}
              />
            </MapboxGL.PointAnnotation>
          );
        })}

        {/* Hoisted vehicle icons — needed by BOTH the driver SymbolLayer below
            AND the nearby-vehicles SymbolLayer further down. Mounting once at
            the map root avoids "image not loaded" race when nearbyGeoJSON is
            empty but a driver marker is being rendered. */}
        <MapboxGL.Images images={vehicleMarkerImages} />

        {/* Driver marker — Uber/Bolt-style smooth animation.
            BUG-marker-position-lag (2026-05-24): switched from MarkerView
            (which forced re-mount on each coord change → 1-second teleports)
            to ShapeSource + SymbolLayer. The Mapbox-native source updates
            without re-mounting, and `useAnimatedCoordinate` interpolates
            the coord at ~30 FPS so the marker slides continuously between
            1-Hz GPS samples instead of jumping.
            Pulse ring preserved as a separate CircleLayer at the same
            coord (the layer's circleRadius animates via pulseRadiusPx).
            BUG-295 stale: triciclo PNG was re-exported pointing north in
            PR #186 → vehicleMarkerRotationOffset returns 0 for all stock
            vehicles. The expression remains for forward-compat in case a
            new non-standard asset enters the fleet. */}
        {renderedDriverCoord && (
          <>
            {/* Pulse ring (drawn first so it sits BELOW the icon) */}
            <MapboxGL.ShapeSource
              id="driver-pulse-src"
              shape={{
                type: 'Feature',
                geometry: {
                  type: 'Point',
                  coordinates: [renderedDriverCoord.longitude, renderedDriverCoord.latitude],
                },
                properties: {},
              }}
            >
              <MapboxGL.CircleLayer
                id="driver-pulse-circle"
                style={{
                  circleRadius: pulseRadiusPx,
                  circleColor: MAP_COLORS.driver,
                  circleOpacity: 0.15 * driverMarkerOpacity,
                  circlePitchAlignment: 'map',
                }}
              />
            </MapboxGL.ShapeSource>

            {/* Vehicle icon (rotates with smoothed heading) */}
            <MapboxGL.ShapeSource
              id="driver-marker-src"
              onPress={() => {
                if (!animatedDriver) return;
                void triggerSelection();
                cameraRef.current?.setCamera({
                  centerCoordinate: [animatedDriver.longitude, animatedDriver.latitude],
                  zoomLevel: 16,
                  animationDuration: 600,
                  animationMode: 'flyTo',
                });
              }}
              shape={{
                type: 'Feature',
                geometry: {
                  type: 'Point',
                  coordinates: [renderedDriverCoord.longitude, renderedDriverCoord.latitude],
                },
                properties: {
                  icon: vehicleType ? `marker-${vehicleType}` : 'marker-auto',
                  heading:
                    (vehicleType && NON_ROTATING_MARKERS.has(vehicleType))
                      ? 0
                      : ((animatedDriver?.heading ?? 0) + vehicleMarkerRotationOffset(vehicleType)) % 360,
                },
              }}
            >
              <MapboxGL.SymbolLayer
                id="driver-marker-icon"
                style={{
                  iconImage: ['get', 'icon'],
                  // 0.85 = comparable to MARKER.driver.size = 45 (PR #185 1.5×
                  // sizing). Calibrate on-device against nearby vehicles
                  // (iconSize 0.55) — active driver should pop slightly larger.
                  iconSize: 0.85,
                  iconAllowOverlap: true,
                  iconAnchor: 'center',
                  iconRotate: ['get', 'heading'],
                  iconOpacity: driverMarkerOpacity,
                  // BUG-marker-bearing-doubling (2026-05-24): without these,
                  // iconRotate is interpreted in VIEWPORT space (Mapbox
                  // default). When the camera bearing follows the driver
                  // heading (Uber 3D mode, cameraProfile above), both
                  // rotations compound → the marker visually ends up offset
                  // by ~heading° from the actual direction of travel. Anchor
                  // to 'map' so iconRotate represents the compass bearing.
                  iconRotationAlignment: 'map',
                  // Pitch-align to map so the icon lays flat on the road
                  // surface in 3D pitch=45 mode (Waze / Google Maps style).
                  iconPitchAlignment: 'map',
                }}
              />
            </MapboxGL.ShapeSource>
          </>
        )}

        {animatedDriver && renderedDriverCoord && driverEtaLabel && (
          <MapboxGL.MarkerView
            id="driver-eta-bubble"
            coordinate={[renderedDriverCoord.longitude, renderedDriverCoord.latitude]}
            // Anchor stays inside [0,1] — MarkerView console.warns on every
            // render otherwise, which at this coordinate's ~30 FPS means a
            // warning per frame for the whole ride. The lift above the
            // vehicle icon comes from marginBottom instead.
            anchor={{ x: 0.5, y: 1 }}
            allowOverlap
          >
            <View
              accessibilityLabel={t('map.driver_eta', { eta: driverEtaLabel })}
              style={{
                marginBottom: MARKER.driver.size * 0.7,
                backgroundColor: isDark ? darkColors.card : '#ffffff',
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 8,
                shadowColor: '#000',
                shadowOpacity: 0.18,
                shadowRadius: 5,
                shadowOffset: { width: 0, height: 2 },
                elevation: 4,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: '600', color: isDark ? darkColors.text.primary : colors.neutral[800] }}>
                {driverEtaLabel}
              </Text>
            </View>
          </MapboxGL.MarkerView>
        )}

        {/* Nearby vehicles — GPU-rendered SymbolLayer for performance */}
        {/* BUG-218 v2: 0.55 = comfortable size on default zoom (was 0.9
            which dominated; 0.5 was too small to spot). */}
        {nearbyGeoJSON && (
          <>
            <MapboxGL.ShapeSource
              id="nearby-vehicles"
              shape={nearbyGeoJSON}
              onPress={(e: { features: Array<{ properties?: { id?: unknown; opacity?: unknown } }> }) => {
                const f = e.features?.[0];
                const id = f?.properties?.id;
                if (typeof id !== 'string' || !id) return;
                // A vehicle mid-fade-out is still on screen and still
                // tappable, but it's already gone from the live list — so
                // the callout would resolve to nothing. Ignore the tap
                // rather than buzz and open an empty bubble.
                const opacity = f?.properties?.opacity;
                if (typeof opacity === 'number' && opacity < 0.6) return;
                void triggerSelection();
                // Tapping the open one closes it, so the bubble isn't a
                // one-way door on a map with no other dismiss target.
                setTappedVehicleId((prev) => (prev === id ? null : id));
              }}
            >
              <MapboxGL.SymbolLayer
                id="nearby-icons"
                style={{
                  iconImage: ['get', 'icon'],
                  iconSize: 0.55,
                  iconOpacity: ['get', 'opacity'],
                  iconAllowOverlap: true,
                  iconAnchor: 'center',
                  // Cargo box marker (mensajería) has no front — keep
                  // rotation 0. Everything else uses the raw heading.
                  // BUG-marker-bearing-doubling (2026-05-24): removed the
                  // legacy "triciclo + 180" compensation — the PNG is
                  // NORTH-convention since BUG-295 (PR #186), so the offset
                  // was leaving every nearby triciclo facing backwards.
                  iconRotate: [
                    'case',
                    ['==', ['get', 'icon'], 'marker-mensajeria'], 0,
                    ['get', 'heading'],
                  ],
                  // BUG-marker-bearing-doubling (2026-05-24): match the
                  // focused-driver SymbolLayer above — anchor rotation to
                  // map space so icons stay aligned with the street when
                  // the camera bearing rotates with the driver heading.
                  iconRotationAlignment: 'map',
                  iconPitchAlignment: 'map',
                }}
              />
            </MapboxGL.ShapeSource>
          </>
        )}

        {tappedVehicle && (
          <MapboxGL.MarkerView
            id="vehicle-callout"
            coordinate={tappedVehicle.coordinate}
            // Inside [0,1] — see the note on the driver bubble above.
            anchor={{ x: 0.5, y: 1 }}
          >
            <Pressable
              onPress={() => setTappedVehicleId(null)}
              accessibilityRole="button"
              accessibilityLabel={t('map.dismiss_callout', { defaultValue: 'Cerrar' })}
              style={{
                marginBottom: 20,
                backgroundColor: isDark ? darkColors.card : '#ffffff',
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                shadowColor: '#000',
                shadowOpacity: 0.18,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 2 },
                elevation: 4,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '600', color: isDark ? darkColors.text.primary : colors.neutral[800] }}>
                {tappedVehicle.label}
              </Text>
            </Pressable>
          </MapboxGL.MarkerView>
        )}

        {/* Searching driver avatar markers (Presence-based) */}
        {searchingDrivers && searchingDrivers.length > 0 && (
          <SearchingDriverMarkers
            drivers={searchingDrivers}
            acceptedDriverId={acceptedDriverId ?? null}
          />
        )}
      </MapboxGL.MapView>

      {/* Style-load veil: the style swap (first load, theme toggle) takes a
          beat while the RN chrome flips instantly — covering the map with
          the theme background reads as one transition, not a piecemeal
          repaint of half the screen. */}
      {!styleReady && (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: isDark ? '#0f1116' : '#f4f4f5' }}
        />
      )}

      {/* BUG-267 v3 — Recenter FAB. Visible only while the user has paused
          the Uber-style auto-follow (after pan/zoom during an active ride).
          Tapping it re-engages the follow camera instantly. */}
      {showFollowOverlayFab && (
        <TouchableOpacity
          onPress={handleRecenter}
          accessibilityLabel={t('home.recenter_fab', { defaultValue: 'Recentrar mapa' })}
          accessibilityRole="button"
          activeOpacity={0.85}
          style={{
            position: 'absolute',
            right: 14,
            bottom: 14,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: isDark ? darkColors.card : '#ffffff',
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.18,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 3 },
            elevation: 4,
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="navigate" size={20} color="#FF4D00" />
        </TouchableOpacity>
      )}
    </View>
  );
}

export const RideMapView = React.memo(React.forwardRef(RideMapViewInner));
