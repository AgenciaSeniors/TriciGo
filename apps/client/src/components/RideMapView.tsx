import React, { useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { View, Text, Animated, Platform, useColorScheme, Image, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, darkColors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { MAP_STYLE_LIGHT, MAP_COLORS, MARKER, ROUTE, haversineDistance, snapDriverToRoute, smoothHeading, vehicleMarkerRotationOffset, useAnimatedCoordinate } from '@tricigo/utils';
import { StopMarker } from '@tricigo/ui';
import { getMapFallbackCoordLngLat } from '@/config/demo';
import type { ViewportPoi } from '@tricigo/utils';
import { useAnimatedPosition } from '@/hooks/useAnimatedPosition';
import { WebMapView } from './WebMapView';
import { PoiMapLayers } from './PoiMapLayers';
import { SearchingDriverMarkers } from './SearchingDriverMarkers';
import type { SearchingDriverPresence } from '@tricigo/types';

let _MapboxGL: any = undefined;
function getMapboxGL(): any {
  if (_MapboxGL !== undefined) return _MapboxGL;
  try { _MapboxGL = require('@rnmapbox/maps').default; } catch { _MapboxGL = null; }
  return _MapboxGL;
}

// Ensure Mapbox access token is set synchronously before any MapView
// mounts. Guards against the _layout race where token gets applied too
// late on cold start.
let _mapboxTokenApplied = false;
function ensureMapboxToken() {
  if (_mapboxTokenApplied || Platform.OS === 'web') return;
  const M = getMapboxGL();
  if (!M) return;
  try {
    const token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
    M.setAccessToken(token);
    // BUG-216: setWellKnownTileServer removed (deprecated, was log noise)
    if (typeof M.setTelemetryEnabled === 'function') M.setTelemetryEnabled(false);
    _mapboxTokenApplied = true;
  } catch {
    // _layout useEffect retry will pick it up
  }
}
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
  /** Callback when pickup pin is dragged to a new location */
  onPickupDrag?: (location: GeoPoint) => void;
  /** Callback when dropoff pin is dragged to a new location */
  onDropoffDrag?: (location: GeoPoint) => void;
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
  /** POIs to display on the map (fetched by useViewportPois) */
  pois?: ViewportPoi[];
  /** Called when the map camera changes — use to update viewport POIs */
  onCameraChanged?: (bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number }, zoom: number) => void;
  /**
   * Called when the user taps an unclustered POI marker on the map.
   * Parent should open a bottom sheet showing the POI name + category +
   * an "Ir aquí" button that wires the coords as pickup or dropoff
   * depending on the current ride state.
   */
  onPoiPress?: (poi: { id: number; name: string; tricigo_category: string | null; lat: number; lng: number; address: string | null }) => void;
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

// BUG-296: POI rendering moved to the shared <PoiMapLayers> component.
// The old POI_COLORS rainbow map + poisToGeoJSON (emoji-based) are gone —
// the new system maps every POI to one of 9 restrained visual groups
// (see packages/utils/src/poiCategories.ts).

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

/** Convert GeoPoint to Mapbox [lng, lat] with validation */
function toCoord(p: GeoPoint): [number, number] {
  const lng = Number.isFinite(p?.longitude) ? p.longitude : -82.3666;
  const lat = Number.isFinite(p?.latitude) ? p.latitude : 23.1136;
  return [lng, lat];
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
  onPickupDrag,
  onDropoffDrag,
  searchingDrivers,
  acceptedDriverId,
  isAcceptAnimating,
  acceptedDriverLocation,
  driverToPickupRoute,
  vehicleType,
  height = 200,
  pois,
  onCameraChanged,
  onPoiPress,
  fullscreen,
  initialUserCenter,
  rideStatus,
}: RideMapViewProps) {
  ensureMapboxToken();
  const MapboxGL = getMapboxGL();
  const { t } = useTranslation('rider');
  const colorScheme = useColorScheme();

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
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ant-march animation — 60fps via requestAnimationFrame + setState throttled
  const [dashStep, setDashStep] = useState(0);
  const dashStepRef = useRef(0);
  const lastFrameRef = useRef(0);
  useEffect(() => {
    if (!routeCoordinates || routeCoordinates.length < 2) return;
    let rafId: number;
    const animate = (timestamp: number) => {
      // Advance one frame every ~30ms (~33fps — fast and fluid)
      if (timestamp - lastFrameRef.current > 30) {
        lastFrameRef.current = timestamp;
        dashStepRef.current = (dashStepRef.current + 1) % DASH_SEQUENCE.length;
        setDashStep(dashStepRef.current);
      }
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [routeCoordinates]);
  const isDark = colorScheme === 'dark';
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pickupPulseAnim = useRef(new Animated.Value(1)).current;
  const pickupPulseOpacity = useRef(new Animated.Value(0.6)).current;
  const dropoffScale = useRef(new Animated.Value(0.3)).current;

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
    const next = smoothHeading(rawTarget, lastSmoothedHeadingRef.current);
    lastSmoothedHeadingRef.current = next;
    setSmoothedDriverHeading(next);
  }, [
    driverLocation?.latitude,
    driverLocation?.longitude,
    (driverLocation as { heading?: number | null } | null)?.heading,
    snappedDriver?.bearing,
    driverHeading,
  ]);

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
      heading: smoothedDriverHeading,
    };
  }, [
    driverLocation?.latitude,
    driverLocation?.longitude,
    snappedDriver?.latitude,
    snappedDriver?.longitude,
    smoothedDriverHeading,
  ]);
  // DEBUG-271: log every time the marker coordinate changes so we can
  // see in the rider's Metro log whether the prop chain is delivering
  // fresh positions to MarkerView.
  const lastLoggedCoordRef = useRef<string>('');
  if (animatedDriver) {
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

  // Build nearby vehicles GeoJSON FeatureCollection
  const nearbyGeoJSON = useMemo(() => {
    if (!nearbyVehicles || nearbyVehicles.length === 0) return null;
    return {
      type: 'FeatureCollection' as const,
      features: nearbyVehicles.map((v) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [v.longitude, v.latitude],
        },
        properties: {
          id: v.driver_profile_id,
          icon: `marker-${v.vehicle_type || 'auto'}`,
        },
      })),
    };
  }, [nearbyVehicles]);

  // BUG-296: POI GeoJSON now built inside <PoiMapLayers> — no local memo.

  // Handle camera change — notify parent with viewport bounds + zoom
  const handleCameraChanged = useCallback((event: any) => {
    if (!onCameraChanged) return;
    try {
      const { properties, geometry } = event;
      const zoom = properties?.zoomLevel ?? 13;
      const visibleBounds = properties?.visibleBounds;
      if (visibleBounds && visibleBounds.length === 2) {
        // visibleBounds = [[neLng, neLat], [swLng, swLat]]
        const [ne, sw] = visibleBounds;
        onCameraChanged({
          minLng: sw[0], minLat: sw[1],
          maxLng: ne[0], maxLat: ne[1],
        }, zoom);
      }
    } catch {}
  }, [onCameraChanged]);

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
    <View style={fullscreen ? { flex: 1 } : { height, borderRadius: 12, overflow: 'hidden' }} accessibilityLabel={t('map.ride_map', { defaultValue: 'Ride map' })}>
      <MapboxGL.MapView
        style={{ flex: 1 }}
        styleURL={MAP_STYLE_LIGHT}
        attributionEnabled={false}
        logoEnabled={false}
        compassEnabled={false}
        scaleBarEnabled={false}
        zoomEnabled={true}
        scrollEnabled={true}
        pitchEnabled={true}
        rotateEnabled={true}
        // onMapIdle is the primary hook; it fires when the camera fully
        // settles. But on some Android builds (new arch + 10.3.0) the idle
        // event is delayed or never emitted on cold mount. onCameraChanged
        // is more chatty (every animation frame) but the upstream hook
        // (useViewportPois) debounces by 300 ms and skips if still inside
        // the previous bounds, so it's safe to attach both.
        onMapIdle={handleCameraChanged}
        onCameraChanged={handleCameraChanged}
        // BUG-267 v3: pause the Uber follow while the user is exploring
        // the map. onTouchStart on the underlying View fires on any
        // touch (tap/pan/pinch begins). Combined with the 8s resume
        // timer in handleUserGesture, this prevents the camera from
        // fighting the user's finger.
        onTouchStart={isRideActive ? handleUserGesture : undefined}
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

        {/* BUG-296: POIs rendered below routes and markers via the
            shared <PoiMapLayers> — Google-Maps-style categorical badges
            (9 visual groups, Ionicons glyphs) replacing the old
            colored-circle + emoji layers. */}
        <PoiMapLayers
          MapboxGL={MapboxGL}
          pois={pois}
          onPoiPress={onPoiPress}
          isDark={isDark}
        />

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

        {/* Route polyline — shadow + main line */}
        {routeGeoJSON && (
          <MapboxGL.ShapeSource id="route" shape={routeGeoJSON}>
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
          </MapboxGL.ShapeSource>
        )}

        {/* Pickup marker — premium 3D with pulsing ring */}
        {pickupLocation && (
          <MapboxGL.PointAnnotation
            id="pickup"
            coordinate={toCoord(pickupLocation)}
            draggable={!!onPickupDrag}
            onDragEnd={(e: any) => {
              if (onPickupDrag && e?.geometry?.coordinates) {
                const [lng, lat] = e.geometry.coordinates;
                onPickupDrag({ latitude: lat, longitude: lng });
              }
            }}
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
         *  Trade-off: MarkerView doesn't support `draggable` the way
         *  PointAnnotation does. Drag-to-correct-dropoff lives on the
         *  ConfirmLocation flow, where the user moves the map under a
         *  static pin instead — this view is the route-preview / vehicle
         *  picker, where the dropoff is already committed and shouldn't
         *  be dragged anyway. `onDropoffDrag` is therefore intentionally
         *  not wired up here. */}
        {dropoffLocation &&
          Number.isFinite(dropoffLocation.latitude) &&
          Number.isFinite(dropoffLocation.longitude) && (
          <MapboxGL.MarkerView
            id="dropoff"
            key={`dropoff-${dropoffLocation.latitude.toFixed(5)}-${dropoffLocation.longitude.toFixed(5)}`}
            coordinate={toCoord(dropoffLocation)}
            anchor={{ x: 0.5, y: 1 }}
          >
            <Animated.View
              style={{
                width: 44,
                height: 44,
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
                style={{ width: 44, height: 44, tintColor: MAP_COLORS.brand }}
                resizeMode="contain"
                accessibilityLabel="Destino"
              />
            </Animated.View>
          </MapboxGL.MarkerView>
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
                }}
              />
            </MapboxGL.ShapeSource>
          </>
        )}

        {/* Nearby vehicles — GPU-rendered SymbolLayer for performance */}
        {/* BUG-218 v2: 0.55 = comfortable size on default zoom (was 0.9
            which dominated; 0.5 was too small to spot). */}
        {nearbyGeoJSON && (
          <>
            <MapboxGL.ShapeSource id="nearby-vehicles" shape={nearbyGeoJSON}>
              <MapboxGL.SymbolLayer
                id="nearby-icons"
                style={{
                  iconImage: ['get', 'icon'],
                  iconSize: 0.55,
                  iconAllowOverlap: true,
                  iconAnchor: 'center',
                  // Cargo box marker (mensajería) has no front — keep rotation 0.
                  // BUG-295: triciclo asset drawn pointing south — add 180° to
                  // align the nose with direction of travel. All other markers
                  // (auto, moto, confort) rotate by their raw heading.
                  iconRotate: [
                    'case',
                    ['==', ['get', 'icon'], 'marker-mensajeria'], 0,
                    ['==', ['get', 'icon'], 'marker-triciclo'], ['%', ['+', ['get', 'heading'], 180], 360],
                    ['get', 'heading'],
                  ],
                }}
              />
            </MapboxGL.ShapeSource>
          </>
        )}

        {/* Searching driver avatar markers (Presence-based) */}
        {searchingDrivers && searchingDrivers.length > 0 && (
          <SearchingDriverMarkers
            drivers={searchingDrivers}
            acceptedDriverId={acceptedDriverId ?? null}
          />
        )}
      </MapboxGL.MapView>

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
            backgroundColor: '#ffffff',
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

export const RideMapView = React.memo(RideMapViewInner);
