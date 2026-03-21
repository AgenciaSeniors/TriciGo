import React, { useMemo, useEffect, useRef } from 'react';
import { View, Text, Animated } from 'react-native';
import { colors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';

let MapboxGL: any;
try {
  MapboxGL = require('@rnmapbox/maps').default;
} catch {
  MapboxGL = null;
}

interface GeoPoint {
  latitude: number;
  longitude: number;
}

interface RideMapViewProps {
  pickupLocation?: GeoPoint | null;
  dropoffLocation?: GeoPoint | null;
  driverLocation?: GeoPoint | null;
  routeCoordinates?: GeoPoint[] | null;
  heatmapData?: { latitude: number; longitude: number; intensity: number }[];
  height?: number;
}

const HAVANA_CENTER: [number, number] = [-82.3666, 23.1136]; // [lng, lat]

/** Compute bounding box from [lng, lat] coordinates */
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

export function RideMapView({
  pickupLocation,
  dropoffLocation,
  driverLocation,
  routeCoordinates,
  heatmapData,
  height = 200,
}: RideMapViewProps) {
  const { t } = useTranslation('driver');

  // Pulse animation for driver marker
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!driverLocation) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.3, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [driverLocation, pulseAnim]);

  // Build route GeoJSON
  const routeGeoJSON = useMemo(() => {
    if (!routeCoordinates || routeCoordinates.length < 2) return null;
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: routeCoordinates.map(toCoord),
      },
      properties: {},
    };
  }, [routeCoordinates]);

  // Build heatmap GeoJSON FeatureCollection
  const heatmapGeoJSON = useMemo(() => {
    if (!heatmapData || heatmapData.length === 0) return null;
    return {
      type: 'FeatureCollection' as const,
      features: heatmapData.map((point, i) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [point.longitude, point.latitude],
        },
        properties: { intensity: point.intensity, id: `heat-${i}` },
      })),
    };
  }, [heatmapData]);

  // Compute camera bounds
  const bounds = useMemo(() => {
    const allCoords: [number, number][] = [];
    if (routeCoordinates && routeCoordinates.length > 0) {
      routeCoordinates.forEach((c) => allCoords.push(toCoord(c)));
    } else {
      if (pickupLocation) allCoords.push(toCoord(pickupLocation));
      if (dropoffLocation) allCoords.push(toCoord(dropoffLocation));
    }
    if (driverLocation) allCoords.push(toCoord(driverLocation));
    return computeBounds(allCoords);
  }, [pickupLocation, dropoffLocation, driverLocation, routeCoordinates]);

  if (!MapboxGL) {
    return (
      <View
        style={{
          height,
          backgroundColor: colors.neutral[800],
          justifyContent: 'center',
          alignItems: 'center',
          borderRadius: 12,
        }}
        accessibilityRole="alert"
      >
        <Text style={{ color: colors.neutral[500] }}>{t('common.map_unavailable')}</Text>
      </View>
    );
  }

  return (
    <View style={{ height, borderRadius: 12, overflow: 'hidden' }} accessibilityLabel={t('a11y.ride_map', { ns: 'common' })} accessibilityRole="image">
      <MapboxGL.MapView
        style={{ flex: 1 }}
        accessible={false}
        accessibilityElementsHidden={true}
        importantForAccessibility="no-hide-descendants"
        styleURL="mapbox://styles/mapbox/dark-v11"
        attributionEnabled={false}
        logoEnabled={false}
        compassEnabled={false}
      >
        {/* Camera — fit to bounds or default to Havana */}
        <MapboxGL.Camera
          defaultSettings={{
            centerCoordinate: HAVANA_CENTER,
            zoomLevel: 13,
          }}
          bounds={
            bounds
              ? {
                  ne: bounds.ne,
                  sw: bounds.sw,
                  paddingTop: 50,
                  paddingRight: 50,
                  paddingBottom: 50,
                  paddingLeft: 50,
                }
              : undefined
          }
          animationDuration={500}
        />

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

        {/* Driver (own) location marker with pulse */}
        {driverLocation && (
          <MapboxGL.PointAnnotation
            id="driver"
            coordinate={toCoord(driverLocation)}
          >
            <Animated.View
              style={{
                width: 28,
                height: 28,
                alignItems: 'center',
                justifyContent: 'center',
                transform: [{ scale: pulseAnim }],
              }}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  backgroundColor: colors.info.DEFAULT,
                  borderWidth: 3,
                  borderColor: 'white',
                  shadowColor: colors.info.DEFAULT,
                  shadowOpacity: 0.5,
                  shadowRadius: 8,
                  elevation: 6,
                }}
              />
            </Animated.View>
          </MapboxGL.PointAnnotation>
        )}

        {/* Demand heatmap circles */}
        {heatmapGeoJSON && (
          <MapboxGL.ShapeSource id="heatmap" shape={heatmapGeoJSON}>
            <MapboxGL.CircleLayer
              id="heatmap-circles"
              style={{
                circleRadius: 40,
                circleColor: [
                  'interpolate',
                  ['linear'],
                  ['get', 'intensity'],
                  0.0,
                  'rgba(34, 197, 94, 0.15)',
                  0.4,
                  'rgba(234, 179, 8, 0.2)',
                  0.7,
                  'rgba(239, 68, 68, 0.25)',
                ],
                circleBlur: 0.5,
                circleStrokeWidth: 0,
              }}
            />
          </MapboxGL.ShapeSource>
        )}
      </MapboxGL.MapView>
    </View>
  );
}
