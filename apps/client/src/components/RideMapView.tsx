import React, { useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { View, Text, Animated, Platform, useColorScheme, Image } from 'react-native';
import { colors, darkColors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { MAP_STYLE_LIGHT, MAP_COLORS, MARKER, ROUTE } from '@tricigo/utils';
import { StopMarker } from '@tricigo/ui';
import { getMapFallbackCoordLngLat } from '@/config/demo';
import type { ViewportPoi } from '@tricigo/utils';
import { useAnimatedPosition } from '@/hooks/useAnimatedPosition';
import { WebMapView } from './WebMapView';
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
};

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
  /** When true, map fills all available space via flex:1 instead of fixed height */
  fullscreen?: boolean;
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

/* ── POI category → color (matches web BookingMap) ── */
const POI_COLORS: Record<string, string> = {
  restaurant: '#E53935', cafe: '#E53935', bar: '#E53935', fast_food: '#E53935', bakery: '#E53935', nightclub: '#E53935',
  hotel: '#1E88E5', guest_house: '#1E88E5', hostel: '#1E88E5', apartment: '#1E88E5', motel: '#1E88E5',
  hospital: '#43A047', clinic: '#43A047', pharmacy: '#43A047', doctors: '#43A047', dentist: '#43A047',
  supermarket: '#FB8C00', convenience: '#FB8C00', marketplace: '#FB8C00', mobile_phone: '#FB8C00', hairdresser: '#FB8C00', car_repair: '#FB8C00',
  school: '#8E24AA', university: '#8E24AA', college: '#8E24AA', kindergarten: '#8E24AA',
  bank: '#546E7A', post_office: '#546E7A', police: '#546E7A', embassy: '#546E7A', townhall: '#546E7A', fire_station: '#546E7A',
  park: '#2E7D32', beach: '#2E7D32', attraction: '#2E7D32', museum: '#2E7D32', monument: '#2E7D32', theatre: '#2E7D32', cinema: '#2E7D32', library: '#2E7D32',
  fuel: '#FF6F00', bus_station: '#FF6F00', ferry_terminal: '#FF6F00', aerodrome: '#FF6F00',
};

function poisToGeoJSON(pois: ViewportPoi[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pois.map((p) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        name: p.name,
        category: p.category,
        subcategory: p.subcategory,
        color: POI_COLORS[p.subcategory] || '#78909C',
      },
    })),
  };
}

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
  fullscreen,
}: RideMapViewProps) {
  ensureMapboxToken();
  const MapboxGL = getMapboxGL();
  const { t } = useTranslation('rider');
  const colorScheme = useColorScheme();

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
  const animatedDriver = driverLocation
    ? {
        latitude: driverLocation.latitude,
        longitude: driverLocation.longitude,
        heading: driverHeading ?? (driverLocation as { heading?: number | null }).heading ?? 0,
      }
    : null;
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

  // POI GeoJSON for map layers
  const poiGeoJSON = useMemo(() => {
    if (!pois || pois.length === 0) return null;
    return poisToGeoJSON(pois);
  }, [pois]);

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
  const routeKey = useMemo(
    () => routeCoordinates?.map((c) => `${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}`).join('|') ?? '',
    [routeCoordinates],
  );
  const driverRouteKey = useMemo(
    () => driverToPickupRoute?.map((c) => `${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}`).join('|') ?? '',
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
    // Searching drivers ARE included so the user can see incoming offers
    searchingDrivers?.forEach((d) => allCoords.push(toCoord(d.location)));
    return computeBounds(allCoords);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickupLat, pickupLng, dropoffLat, dropoffLng, routeKey, isAcceptAnimating]);

  // BUG-229: only push bounds to Mapbox Camera when something MEANINGFUL
  // changes (new ride, new route). Once bounds are applied, hold them
  // stable so Camera doesn't snap on every re-render. The user can then
  // pan freely; tap "recenter" to refit.
  const [hasFitInitially, setHasFitInitially] = useState(false);
  const lastBoundsKey = useRef('');
  const boundsKey = bounds ? `${bounds.ne[0]},${bounds.ne[1]}|${bounds.sw[0]},${bounds.sw[1]}` : '';
  // Only consider bounds "active" the FIRST time they're available, OR if
  // the bounding box changes by more than ~10% (e.g. user picked a brand
  // new ride with very different coordinates).
  const activeBounds = useMemo(() => {
    if (!bounds) return null;
    if (!hasFitInitially) return bounds;
    // After initial fit, only re-apply if bounds shifted significantly.
    // Compare normalized key — if the same, return null (don't snap).
    if (boundsKey === lastBoundsKey.current) return null;
    return bounds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, hasFitInitially]);

  useEffect(() => {
    if (bounds && !hasFitInitially) {
      setHasFitInitially(true);
      lastBoundsKey.current = boundsKey;
    }
  }, [bounds, hasFitInitially, boundsKey]);

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
        onMapIdle={handleCameraChanged}
      >
        {/* Camera — fit to bounds, or flyTo accepted driver, or default to Havana */}
        <MapboxGL.Camera
          defaultSettings={{
            centerCoordinate: HAVANA_CENTER,
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

        {/* POI dots + labels (rendered below routes and markers) */}
        {poiGeoJSON && (
          <MapboxGL.ShapeSource id="pois" shape={poiGeoJSON} cluster clusterMaxZoomLevel={14} clusterRadius={40}>
            {/* Cluster circles — smaller */}
            <MapboxGL.CircleLayer
              id="poi-clusters"
              filter={['has', 'point_count']}
              style={{
                circleColor: ['step', ['get', 'point_count'], '#51bbd6', 50, '#f1f075', 200, '#f28cb1'],
                circleRadius: ['step', ['get', 'point_count'], 12, 50, 16, 200, 20],
                circleStrokeWidth: 1.5,
                circleStrokeColor: 'rgba(255,255,255,0.6)',
              }}
            />
            {/* Cluster count labels */}
            <MapboxGL.SymbolLayer
              id="poi-cluster-count"
              filter={['has', 'point_count']}
              style={{
                textField: ['get', 'point_count_abbreviated'],
                textSize: 10,
                textColor: '#333',
              }}
            />
            {/* Individual POI dots — smaller */}
            <MapboxGL.CircleLayer
              id="poi-unclustered"
              filter={['!', ['has', 'point_count']]}
              style={{
                circleColor: ['get', 'color'],
                circleRadius: ['interpolate', ['linear'], ['zoom'], 12, 2, 15, 4, 18, 7],
                circleStrokeWidth: 1,
                circleStrokeColor: 'rgba(255,255,255,0.9)',
              }}
            />
            {/* POI name labels — smaller */}
            <MapboxGL.SymbolLayer
              id="poi-labels"
              filter={['!', ['has', 'point_count']]}
              minZoomLevel={14}
              style={{
                textField: ['get', 'name'],
                textSize: ['interpolate', ['linear'], ['zoom'], 14, 8, 16, 10],
                textOffset: [0, 1.0],
                textAnchor: 'top',
                textMaxWidth: 7,
                textOptional: true,
                textAllowOverlap: false,
                textColor: '#555',
                textHaloColor: 'rgba(255,255,255,0.95)',
                textHaloWidth: 1,
              }}
            />
          </MapboxGL.ShapeSource>
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
            (white silhouette tinted brand-orange). The icon is already a
            location-pin shape, so we anchor at y:1 so the tip points to
            the actual coordinate. The bounce-in scale animation is preserved. */}
        {dropoffLocation && (
          <MapboxGL.PointAnnotation
            id="dropoff"
            coordinate={toCoord(dropoffLocation)}
            anchor={{ x: 0.5, y: 1 }}
            draggable={!!onDropoffDrag}
            onDragEnd={(e: any) => {
              if (onDropoffDrag && e?.geometry?.coordinates) {
                const [lng, lat] = e.geometry.coordinates;
                onDropoffDrag({ latitude: lat, longitude: lng });
              }
            }}
          >
            <Animated.View
              style={{
                alignItems: 'center',
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
                // Shadow on wrapper (Animated.View) — ImageStyle doesn't accept elevation.
                style={{ width: 44, height: 44, tintColor: MAP_COLORS.brand }}
                resizeMode="contain"
                accessibilityLabel="Destino"
              />
            </Animated.View>
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

        {/* Driver marker — premium vehicle in dark container + pulsing ring.
            BUG-268: switched from PointAnnotation to MarkerView.
            BUG-274: @rnmapbox/maps caches the native marker position once
            mounted; passing a new `coordinate` prop alone is NOT enough to
            move the marker visually on Android. Adding a `key` derived from
            the coordinate forces React to unmount + remount the MarkerView
            every time the position changes. With BUG-273's 1-Hz upload
            throttle, that's at most one remount per second — cheap. The
            user observed the marker only moved when switching apps (which
            re-mounted everything); this makes that the normal behavior. */}
        {animatedDriver && (
          <MapboxGL.MarkerView
            id="driver"
            key={`driver-${animatedDriver.latitude.toFixed(5)}-${animatedDriver.longitude.toFixed(5)}`}
            coordinate={[animatedDriver.longitude, animatedDriver.latitude]}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={{ width: MARKER.driver.ringSize, height: MARKER.driver.ringSize, alignItems: 'center', justifyContent: 'center', opacity: driverMarkerOpacity }}>
              {/* Pulsing glow ring */}
              <Animated.View
                style={{
                  position: 'absolute',
                  width: MARKER.driver.ringSize,
                  height: MARKER.driver.ringSize,
                  borderRadius: MARKER.driver.ringSize / 2,
                  backgroundColor: MAP_COLORS.driver,
                  opacity: 0.15,
                  transform: [{ scale: pulseAnim }],
                }}
              />
              {/* BUG-233: transparent container — show only the vehicle
                  icon (no dark circle, no border). Drop shadow keeps the
                  icon legible against light streets. */}
              <View
                style={{
                  width: MARKER.driver.size,
                  height: MARKER.driver.size,
                  backgroundColor: 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transform: [{ rotate: `${animatedDriver.heading ?? 0}deg` }],
                }}
              >
                {vehicleType && vehicleMarkerImages[`marker-${vehicleType}`] ? (
                  <Image
                    source={vehicleMarkerImages[`marker-${vehicleType}`]}
                    style={{
                      width: MARKER.driver.size,
                      height: MARKER.driver.size,
                      shadowColor: '#000',
                      shadowOpacity: 0.45,
                      shadowRadius: 4,
                      shadowOffset: { width: 0, height: 2 },
                      elevation: 6,
                    }}
                    resizeMode="contain"
                  />
                ) : (
                  <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: MAP_COLORS.driver }} />
                )}
              </View>
            </View>
          </MapboxGL.MarkerView>
        )}

        {/* Nearby vehicles — GPU-rendered SymbolLayer for performance */}
        {/* BUG-218 v2: 0.55 = comfortable size on default zoom (was 0.9
            which dominated; 0.5 was too small to spot). */}
        {nearbyGeoJSON && (
          <>
            <MapboxGL.Images images={vehicleMarkerImages} />
            <MapboxGL.ShapeSource id="nearby-vehicles" shape={nearbyGeoJSON}>
              <MapboxGL.SymbolLayer
                id="nearby-icons"
                style={{
                  iconImage: ['get', 'icon'],
                  iconSize: 0.55,
                  iconAllowOverlap: true,
                  iconAnchor: 'center',
                  iconRotate: ['get', 'heading'],
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
    </View>
  );
}

export const RideMapView = React.memo(RideMapViewInner);
