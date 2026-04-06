import React, { useRef, useEffect, useMemo, useState } from 'react';
import { View, Text, Animated, Platform, useColorScheme } from 'react-native';
import { colors, darkColors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { useAnimatedPosition } from '@/hooks/useAnimatedPosition';
import { WebMapView } from './WebMapView';
import { SearchingDriverMarkers } from './SearchingDriverMarkers';
import type { SearchingDriverPresence } from '@tricigo/types';

let MapboxGL: any;
try {
  MapboxGL = require('@rnmapbox/maps').default;
} catch {
  MapboxGL = null;
}

// Vehicle marker images (top-down view)
const vehicleMarkerImages: Record<string, any> = {
  'marker-triciclo': require('../../assets/vehicles/markers/triciclo.png'),
  'marker-moto': require('../../assets/vehicles/markers/moto.png'),
  'marker-auto': require('../../assets/vehicles/markers/auto.png'),
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
  routeCoordinates?: GeoPoint[] | null;
  waypointLocations?: GeoPoint[];
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
  height?: number;
}

const HAVANA_CENTER: [number, number] = [-82.3666, 23.1136]; // [lng, lat]

/** Compute bounding box from an array of [lng, lat] coordinates */
function computeBounds(coords: [number, number][]): {
  ne: [number, number];
  sw: [number, number];
} | null {
  if (coords.length === 0) return null;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { ne: [maxLng, maxLat], sw: [minLng, minLat] };
}

/** Convert GeoPoint to Mapbox [lng, lat] */
function toCoord(p: GeoPoint): [number, number] {
  return [p.longitude, p.latitude];
}

function RideMapViewInner({
  pickupLocation,
  dropoffLocation,
  driverLocation,
  routeCoordinates,
  waypointLocations,
  nearbyVehicles,
  driverMarkerOpacity = 1,
  onPickupDrag,
  onDropoffDrag,
  searchingDrivers,
  acceptedDriverId,
  isAcceptAnimating,
  acceptedDriverLocation,
  driverToPickupRoute,
  height = 200,
}: RideMapViewProps) {
  const { t } = useTranslation('rider');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Smooth driver position interpolation
  const animatedDriver = useAnimatedPosition(driverLocation ?? null);

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

  // Animated route drawing — progressively reveal route coordinates
  const [animatedRouteCoords, setAnimatedRouteCoords] = useState<GeoPoint[] | null>(null);
  const prevRouteKeyRef = useRef<string>('');

  useEffect(() => {
    if (!routeCoordinates || routeCoordinates.length < 2) {
      setAnimatedRouteCoords(null);
      prevRouteKeyRef.current = '';
      return;
    }

    const routeKey = `${routeCoordinates[0]?.latitude},${routeCoordinates[routeCoordinates.length - 1]?.latitude}`;
    if (routeKey === prevRouteKeyRef.current) return;
    prevRouteKeyRef.current = routeKey;

    const total = routeCoordinates.length;
    const batchSize = Math.max(1, Math.ceil(total / 15));
    let currentIndex = 0;

    const animate = () => {
      currentIndex = Math.min(currentIndex + batchSize, total);
      setAnimatedRouteCoords(routeCoordinates.slice(0, currentIndex));
      if (currentIndex < total) {
        requestAnimationFrame(animate);
      }
    };
    requestAnimationFrame(animate);
  }, [routeCoordinates]);

  // Build route GeoJSON from animated coordinates
  const routeGeoJSON = useMemo(() => {
    const coords = animatedRouteCoords;
    if (!coords || coords.length < 2) return null;
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: coords.map(toCoord),
      },
      properties: {},
    };
  }, [animatedRouteCoords]);

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

  // Compute camera bounds (includes searching driver positions)
  const bounds = useMemo(() => {
    // During accept animation, don't recompute bounds — let the Camera flyTo handle it
    if (isAcceptAnimating) return null;

    const allCoords: [number, number][] = [];
    if (routeCoordinates && routeCoordinates.length > 0) {
      routeCoordinates.forEach((c) => allCoords.push(toCoord(c)));
    } else {
      if (pickupLocation) allCoords.push(toCoord(pickupLocation));
      if (dropoffLocation) allCoords.push(toCoord(dropoffLocation));
    }
    if (animatedDriver) allCoords.push([animatedDriver.longitude, animatedDriver.latitude]);
    waypointLocations?.forEach((wp) => allCoords.push(toCoord(wp)));
    // Include searching driver positions so map fits them
    searchingDrivers?.forEach((d) => allCoords.push(toCoord(d.location)));
    // Include driver-to-pickup route in bounds
    driverToPickupRoute?.forEach((c) => allCoords.push(toCoord(c)));
    return computeBounds(allCoords);
  }, [pickupLocation, dropoffLocation, animatedDriver, routeCoordinates, waypointLocations, searchingDrivers, isAcceptAnimating, driverToPickupRoute]);

  if (!MapboxGL) {
    // On web, use WebMapView with mapbox-gl instead of native @rnmapbox/maps
    if (Platform.OS === 'web') {
      return (
        <WebMapView
          pickup={pickupLocation ? { latitude: pickupLocation[1], longitude: pickupLocation[0] } : null}
          dropoff={dropoffLocation ? { latitude: dropoffLocation[1], longitude: dropoffLocation[0] } : null}
          routeCoords={routeCoordinates as [number, number][] | undefined}
          driverRoute={driverToPickupRoute?.map(c => [c.latitude, c.longitude] as [number, number])}
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
    <View style={{ height, borderRadius: 12, overflow: 'hidden' }} accessibilityLabel={t('map.ride_map', { defaultValue: 'Ride map' })}>
      <MapboxGL.MapView
        style={{ flex: 1 }}
        styleURL="mapbox://styles/mapbox/streets-v12"
        attributionEnabled={false}
        logoEnabled={false}
        compassEnabled={false}
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
            : bounds
              ? {
                  bounds: {
                    ne: bounds.ne,
                    sw: bounds.sw,
                    paddingTop: 50,
                    paddingRight: 50,
                    paddingBottom: 50,
                    paddingLeft: 50,
                  },
                  animationDuration: 500,
                }
              : {})}
        />

        {/* Driver-to-pickup route (blue dashed) */}
        {driverRouteGeoJSON && (
          <MapboxGL.ShapeSource id="driver-to-pickup-route" shape={driverRouteGeoJSON}>
            <MapboxGL.LineLayer
              id="driverRouteLine"
              style={{
                lineColor: '#3b82f6',
                lineWidth: 3,
                lineDasharray: [6, 4],
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </MapboxGL.ShapeSource>
        )}

        {/* Route polyline */}
        {routeGeoJSON && (
          <MapboxGL.ShapeSource id="route" shape={routeGeoJSON}>
            <MapboxGL.LineLayer
              id="routeLine"
              style={{
                lineColor: colors.brand.orange,
                lineWidth: 4,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </MapboxGL.ShapeSource>
        )}

        {/* Pickup marker */}
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
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: colors.success.DEFAULT,
                borderWidth: 3,
                borderColor: 'white',
                shadowColor: '#000',
                shadowOpacity: 0.3,
                shadowRadius: 4,
                elevation: 4,
              }}
            />
          </MapboxGL.PointAnnotation>
        )}

        {/* Dropoff marker */}
        {dropoffLocation && (
          <MapboxGL.PointAnnotation
            id="dropoff"
            coordinate={toCoord(dropoffLocation)}
            draggable={!!onDropoffDrag}
            onDragEnd={(e: any) => {
              if (onDropoffDrag && e?.geometry?.coordinates) {
                const [lng, lat] = e.geometry.coordinates;
                onDropoffDrag({ latitude: lat, longitude: lng });
              }
            }}
          >
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: colors.error.DEFAULT,
                borderWidth: 3,
                borderColor: 'white',
                shadowColor: '#000',
                shadowOpacity: 0.3,
                shadowRadius: 4,
                elevation: 4,
              }}
            />
          </MapboxGL.PointAnnotation>
        )}

        {/* Waypoint markers */}
        {waypointLocations?.map((wp, idx) => (
          <MapboxGL.PointAnnotation
            key={`waypoint-${idx}`}
            id={`waypoint-${idx}`}
            coordinate={toCoord(wp)}
          >
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                backgroundColor: colors.brand.orange,
                borderWidth: 2,
                borderColor: 'white',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: 'white', fontSize: 10, fontWeight: 'bold' }}>
                {idx + 1}
              </Text>
            </View>
          </MapboxGL.PointAnnotation>
        ))}

        {/* Driver marker with smooth animation + pulsing */}
        {animatedDriver && (
          <MapboxGL.PointAnnotation
            id="driver"
            coordinate={[animatedDriver.longitude, animatedDriver.latitude]}
          >
            <Animated.View style={{ transform: [{ scale: pulseAnim }], opacity: driverMarkerOpacity }}>
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: colors.info.DEFAULT,
                  borderWidth: 3,
                  borderColor: colors.brand.white,
                  shadowColor: colors.info.DEFAULT,
                  shadowOpacity: 0.5,
                  shadowRadius: 8,
                  elevation: 4,
                }}
              />
            </Animated.View>
          </MapboxGL.PointAnnotation>
        )}

        {/* Nearby vehicles — GPU-rendered SymbolLayer for performance */}
        {nearbyGeoJSON && (
          <>
            <MapboxGL.Images images={vehicleMarkerImages} />
            <MapboxGL.ShapeSource id="nearby-vehicles" shape={nearbyGeoJSON}>
              <MapboxGL.SymbolLayer
                id="nearby-icons"
                style={{
                  iconImage: ['get', 'icon'],
                  iconSize: 0.5,
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
