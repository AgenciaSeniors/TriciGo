import React, { useState, useMemo, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { View, Text, Animated, Pressable, StyleSheet, Platform, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';

// Native map (iOS/Android)
let MapboxGL: any;
try {
  MapboxGL = require('@rnmapbox/maps').default;
} catch {
  MapboxGL = null;
}

// Web map (browser) — conditional import
let mapboxgl: any = null;
if (Platform.OS === 'web') {
  try {
    mapboxgl = require('mapbox-gl');
    require('mapbox-gl/dist/mapbox-gl.css');
  } catch {
    // fallback to grid if mapbox-gl not available on web
  }
}

interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface RideMapViewRef {
  /** Animate camera to a given coordinate */
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  /** Re-center on driver location */
  recenterOnDriver: () => void;
}

interface RideMapViewProps {
  pickupLocation?: GeoPoint | null;
  dropoffLocation?: GeoPoint | null;
  driverLocation?: GeoPoint | null;
  /** Real-time rider location during pickup phase (from useRiderLocation hook) */
  riderLocation?: GeoPoint | null;
  routeCoordinates?: GeoPoint[] | null;
  heatmapData?: { latitude: number; longitude: number; intensity: number }[];
  /** Active surge zones with GeoJSON boundaries for polygon overlay */
  surgeZones?: { multiplier: number; zone_name: string | null; boundary: { type: 'Polygon'; coordinates: number[][][] } }[];
  height?: number;
  /** When true, use dark navigation style (no active ride / idle) */
  darkStyle?: boolean;
  /** Called when user taps the recenter button */
  onRecenter?: () => void;
  /** Vehicle type for the driver marker icon */
  vehicleType?: 'triciclo' | 'moto' | 'auto' | 'confort' | string;
  /** When true, camera follows driver position with heading rotation */
  followMode?: boolean;
  /** Heading in degrees for camera rotation (from GPS compass) */
  driverHeading?: number | null;
  /** Callback when user interacts with map (disables follow mode) */
  onUserInteraction?: () => void;
}

const vehicleMarkerImages: Record<string, any> = {
  triciclo: require('../../assets/vehicles/markers/triciclo.png'),
  moto: require('../../assets/vehicles/markers/moto.png'),
  auto: require('../../assets/vehicles/markers/auto.png'),
  confort: require('../../assets/vehicles/markers/confort.png'),
};

const HAVANA_CENTER: [number, number] = [-82.3666, 23.1136]; // [lng, lat]
const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
const STYLE_DARK_NAV = 'mapbox://styles/mapbox/navigation-night-v1';
const STYLE_STREETS = 'mapbox://styles/mapbox/streets-v12';

/** Compute bounding box from [lng, lat] coordinates */
function computeBounds(coords: [number, number][]): {
  ne: [number, number];
  sw: [number, number];
} | null {
  if (coords.length === 0) return null;
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
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

// ── Web Mapbox GL component ─────────────────────────────────────────────────────
function WebMapboxView({
  driverLocation,
  pickupLocation,
  dropoffLocation,
  riderLocation,
  routeCoordinates,
  heatmapData,
  surgeZones,
  height = 200,
  darkStyle = false,
  onRecenter,
  vehicleType,
  followMode,
  driverHeading,
  onUserInteraction,
}: RideMapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const driverMarkerRef = useRef<any>(null);
  const riderMarkerRef = useRef<any>(null);
  const pickupMarkerRef = useRef<any>(null);
  const dropoffMarkerRef = useRef<any>(null);

  const MAP_STYLE = darkStyle ? STYLE_DARK_NAV : STYLE_STREETS;

  const center: [number, number] = driverLocation
    ? [driverLocation.longitude, driverLocation.latitude]
    : HAVANA_CENTER;

  // Inject CSS animation for marker pulse
  useEffect(() => {
    const style = document.createElement('style');
    style.id = 'tricigo-marker-pulse';
    style.textContent = `
      @keyframes triMarkerPulse {
        0%, 100% { box-shadow: 0 0 20px rgba(255,77,0,0.5), 0 0 40px rgba(255,77,0,0.2); transform: scale(1); }
        50% { box-shadow: 0 0 30px rgba(255,77,0,0.7), 0 0 60px rgba(255,77,0,0.35); transform: scale(1.08); }
      }
      @keyframes triRingPulse {
        0% { transform: scale(1); opacity: 0.5; }
        100% { transform: scale(2.2); opacity: 0; }
      }
      .tri-marker-container {
        position: relative;
        width: 70px;
        height: 70px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .tri-marker-ring {
        position: absolute;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        border: 2px solid rgba(255,77,0,0.4);
        animation: triRingPulse 2s ease-out infinite;
      }
      .tri-marker-ring:nth-child(2) { animation-delay: 0.6s; }
      .tri-marker-ring:nth-child(3) { animation-delay: 1.2s; }
      .tri-marker-icon {
        width: 52px;
        height: 52px;
        border-radius: 50%;
        background: rgba(13,13,26,0.92);
        border: 2.5px solid #FF4D00;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: triMarkerPulse 2.5s ease-in-out infinite;
        position: relative;
        z-index: 2;
      }
      .tri-marker-icon img {
        width: 32px;
        height: 32px;
        object-fit: contain;
      }
      .tri-marker-fallback {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: #FF4D00;
        border: 3px solid white;
        box-shadow: 0 0 12px rgba(255,77,0,0.6);
      }
    `;
    if (!document.getElementById('tricigo-marker-pulse')) {
      document.head.appendChild(style);
    }
    return () => {
      const existing = document.getElementById('tricigo-marker-pulse');
      if (existing) document.head.removeChild(existing);
    };
  }, []);

  // Initialize map
  useEffect(() => {
    if (!mapboxgl || !mapContainerRef.current || !MAPBOX_TOKEN) return;
    (mapboxgl as any).accessToken = MAPBOX_TOKEN;

    const map = new (mapboxgl as any).Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center,
      zoom: 15,
      attributionControl: false,
      interactive: true,
    });

    // Disable rotation unless follow mode is active
    if (!followMode) {
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
    }

    mapRef.current = map;

    return () => {
      driverMarkerRef.current?.remove();
      riderMarkerRef.current?.remove();
      pickupMarkerRef.current?.remove();
      dropoffMarkerRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Driver marker
  useEffect(() => {
    if (!mapboxgl || !mapRef.current) return;
    driverMarkerRef.current?.remove();

    const pos = driverLocation
      ? [driverLocation.longitude, driverLocation.latitude]
      : HAVANA_CENTER;

    const el = document.createElement('div');
    el.className = 'tri-marker-container';

    // Resolve vehicle image URL from Expo asset
    let imgSrc = '';
    if (vehicleType && vehicleMarkerImages[vehicleType]) {
      const asset = vehicleMarkerImages[vehicleType];
      // Expo web: require() returns a number (asset ID) or { uri: string }
      if (typeof asset === 'number') {
        // For Expo web, we need to resolve the asset URI
        try {
          const { Asset } = require('expo-asset');
          const resolved = Asset.fromModule(asset);
          imgSrc = resolved.uri || resolved.localUri || '';
        } catch {
          imgSrc = '';
        }
      } else if (asset?.uri) {
        imgSrc = asset.uri;
      }
    }

    el.innerHTML = `
      <div class="tri-marker-ring"></div>
      <div class="tri-marker-ring"></div>
      <div class="tri-marker-ring"></div>
      <div class="tri-marker-icon">
        ${imgSrc
          ? `<img src="${imgSrc}" alt="vehicle" onerror="this.parentElement.innerHTML='<div class=\\'tri-marker-fallback\\'></div>'" />`
          : '<div class="tri-marker-fallback"></div>'
        }
      </div>
    `;

    const marker = new (mapboxgl as any).Marker({ element: el, anchor: 'center' })
      .setLngLat(pos as [number, number])
      .addTo(mapRef.current);

    driverMarkerRef.current = marker;
  }, [driverLocation, vehicleType]);

  // Pickup & Dropoff markers
  useEffect(() => {
    if (!mapboxgl || !mapRef.current) return;
    const map = mapRef.current;

    pickupMarkerRef.current?.remove();
    dropoffMarkerRef.current?.remove();

    if (pickupLocation) {
      const el = document.createElement('div');
      el.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#22c55e;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4), 0 0 12px rgba(34,197,94,0.4);';
      pickupMarkerRef.current = new (mapboxgl as any).Marker({ element: el })
        .setLngLat([pickupLocation.longitude, pickupLocation.latitude])
        .addTo(map);
    }

    if (dropoffLocation) {
      const el = document.createElement('div');
      el.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#ef4444;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4), 0 0 12px rgba(239,68,68,0.4);';
      dropoffMarkerRef.current = new (mapboxgl as any).Marker({ element: el })
        .setLngLat([dropoffLocation.longitude, dropoffLocation.latitude])
        .addTo(map);
    }

    // Fit bounds if both exist
    if (pickupLocation && dropoffLocation) {
      const bounds = new (mapboxgl as any).LngLatBounds()
        .extend([pickupLocation.longitude, pickupLocation.latitude])
        .extend([dropoffLocation.longitude, dropoffLocation.latitude]);
      if (driverLocation) {
        bounds.extend([driverLocation.longitude, driverLocation.latitude]);
      }
      map.fitBounds(bounds, { padding: 60, duration: 500 });
    }
  }, [pickupLocation, dropoffLocation, driverLocation]);

  // Rider real-time marker (shown during pickup phase)
  useEffect(() => {
    if (!mapboxgl || !mapRef.current) return;
    const map = mapRef.current;

    riderMarkerRef.current?.remove();

    if (riderLocation) {
      const el = document.createElement('div');
      el.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#3b82f6;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4), 0 0 12px rgba(59,130,246,0.4);';
      el.title = 'Rider';
      riderMarkerRef.current = new (mapboxgl as any).Marker({ element: el })
        .setLngLat([riderLocation.longitude, riderLocation.latitude])
        .addTo(map);
    }
  }, [riderLocation]);

  // Route polyline
  useEffect(() => {
    if (!mapRef.current || !routeCoordinates?.length) return;
    const map = mapRef.current;

    function addRoute() {
      if (map.getSource('route')) {
        map.removeLayer('route-line');
        map.removeSource('route');
      }
      map.addSource('route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: routeCoordinates!.map((c: GeoPoint) => [c.longitude, c.latitude]),
          },
        },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#FF4D00', 'line-width': 4, 'line-opacity': 0.85 },
      });
    }

    if (map.isStyleLoaded()) addRoute();
    else map.on('load', addRoute);
  }, [routeCoordinates]);

  // Heatmap layer
  useEffect(() => {
    if (!mapRef.current || !heatmapData?.length) return;
    const map = mapRef.current;

    function addHeatmap() {
      if (map.getSource('heatmap')) {
        map.removeLayer('heatmap-layer');
        map.removeSource('heatmap');
      }
      map.addSource('heatmap', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: heatmapData!.map((p) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
            properties: { intensity: p.intensity },
          })),
        },
      });
      map.addLayer({
        id: 'heatmap-layer',
        type: 'heatmap',
        source: 'heatmap',
        paint: {
          'heatmap-weight': ['get', 'intensity'],
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(0,0,0,0)',
            0.3, 'rgba(255,77,0,0.25)',
            0.6, 'rgba(255,77,0,0.45)',
            1, 'rgba(255,140,92,0.65)',
          ],
          'heatmap-radius': 40,
          'heatmap-opacity': 0.6,
        },
      });
    }

    if (map.isStyleLoaded()) addHeatmap();
    else map.on('load', addHeatmap);
  }, [heatmapData]);

  // Surge zones polygon layer (web)
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;

    function addSurgeLayer() {
      // Clean up previous
      if (map.getSource('surge-zones')) {
        if (map.getLayer('surge-fill')) map.removeLayer('surge-fill');
        if (map.getLayer('surge-stroke')) map.removeLayer('surge-stroke');
        map.removeSource('surge-zones');
      }
      if (!surgeZones?.length) return;

      map.addSource('surge-zones', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: surgeZones.map((zone, i) => ({
            type: 'Feature',
            geometry: zone.boundary,
            properties: {
              multiplier: zone.multiplier,
              name: zone.zone_name ?? `${zone.multiplier}x`,
              fillColor:
                zone.multiplier >= 2.0
                  ? 'rgba(239,68,68,0.20)'
                  : zone.multiplier >= 1.5
                    ? 'rgba(255,77,0,0.18)'
                    : 'rgba(234,179,8,0.15)',
              strokeColor:
                zone.multiplier >= 2.0
                  ? 'rgba(239,68,68,0.6)'
                  : zone.multiplier >= 1.5
                    ? 'rgba(255,77,0,0.5)'
                    : 'rgba(234,179,8,0.4)',
            },
          })),
        },
      });
      map.addLayer({
        id: 'surge-fill',
        type: 'fill',
        source: 'surge-zones',
        paint: {
          'fill-color': ['get', 'fillColor'],
          'fill-opacity': 1,
        },
      });
      map.addLayer({
        id: 'surge-stroke',
        type: 'line',
        source: 'surge-zones',
        paint: {
          'line-color': ['get', 'strokeColor'],
          'line-width': 1.5,
          'line-dasharray': [3, 2],
        },
      });
    }

    if (map.isStyleLoaded()) addSurgeLayer();
    else map.on('load', addSurgeLayer);
  }, [surgeZones]);

  // Follow mode for web map
  useEffect(() => {
    if (!followMode || !driverLocation || !mapRef.current) return;
    mapRef.current.easeTo({
      center: [driverLocation.longitude, driverLocation.latitude],
      zoom: 16.5,
      pitch: 45,
      bearing: driverHeading ?? 0,
      duration: 1000,
    });
  }, [driverLocation?.latitude, driverLocation?.longitude, driverHeading, followMode]);

  return (
    <View style={{ flex: 1, height, position: 'relative' }}>
      <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
      {/* Recenter button — prominent orange when follow mode is off */}
      {!followMode && driverLocation && (
        <Pressable
          onPress={() => {
            if (mapRef.current && driverLocation) {
              mapRef.current.flyTo({ center: [driverLocation.longitude, driverLocation.latitude], zoom: 15 });
            }
            onRecenter?.();
          }}
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: '#FF4D00',
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.3,
            shadowRadius: 4,
            elevation: 4,
          }}
          accessibilityRole="button"
          accessibilityLabel="Recenter"
        >
          <Ionicons name="navigate" size={20} color="#fff" />
        </Pressable>
      )}
    </View>
  );
}

// ── Main component ──────────────────────────────────────────────────────────────
function RideMapViewInner(
  {
    pickupLocation,
    dropoffLocation,
    driverLocation,
    riderLocation,
    routeCoordinates,
    heatmapData,
    surgeZones,
    height = 200,
    darkStyle = false,
    onRecenter,
    vehicleType,
    followMode,
    driverHeading,
    onUserInteraction,
  }: RideMapViewProps,
  ref: React.Ref<RideMapViewRef>,
) {
  const { t } = useTranslation('driver');
  const cameraRef = useRef<any>(null);
  const [markerImageError, setMarkerImageError] = useState(false);

  // Pulse animation for driver marker (native only)
  const useNative = Platform.OS !== 'web';
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!driverLocation) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.4, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [driverLocation, pulseAnim]);

  // Outer pulse ring animation (native only)
  const ringAnim = useRef(new Animated.Value(1)).current;
  const ringOpacity = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    if (!driverLocation) return;
    const anim = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(ringAnim, { toValue: 2, duration: 1800, useNativeDriver: true }),
          Animated.timing(ringAnim, { toValue: 1, duration: 0, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(ringOpacity, { toValue: 0, duration: 1800, useNativeDriver: true }),
          Animated.timing(ringOpacity, { toValue: 0.6, duration: 0, useNativeDriver: true }),
        ]),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [driverLocation, ringAnim, ringOpacity]);

  // Build route GeoJSON
  const routeGeoJSON = useMemo(() => {
    if (!routeCoordinates || routeCoordinates.length < 2) return null;
    return {
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: routeCoordinates.map(toCoord) },
      properties: {},
    };
  }, [routeCoordinates]);

  // Build heatmap GeoJSON
  const heatmapGeoJSON = useMemo(() => {
    if (!heatmapData || heatmapData.length === 0) return null;
    return {
      type: 'FeatureCollection' as const,
      features: heatmapData.map((point, i) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [point.longitude, point.latitude] },
        properties: { intensity: point.intensity, id: `heat-${i}` },
      })),
    };
  }, [heatmapData]);

  // Build surge zones GeoJSON for polygon overlay
  const surgeGeoJSON = useMemo(() => {
    if (!surgeZones || surgeZones.length === 0) return null;
    return {
      type: 'FeatureCollection' as const,
      features: surgeZones.map((zone, i) => ({
        type: 'Feature' as const,
        geometry: zone.boundary,
        properties: {
          id: `surge-${i}`,
          multiplier: zone.multiplier,
          name: zone.zone_name ?? `${zone.multiplier}x`,
          // Color by multiplier intensity
          fillColor:
            zone.multiplier >= 2.0
              ? 'rgba(239,68,68,0.20)'   // red
              : zone.multiplier >= 1.5
                ? 'rgba(255,77,0,0.18)'   // orange
                : 'rgba(234,179,8,0.15)', // yellow
          strokeColor:
            zone.multiplier >= 2.0
              ? 'rgba(239,68,68,0.6)'
              : zone.multiplier >= 1.5
                ? 'rgba(255,77,0,0.5)'
                : 'rgba(234,179,8,0.4)',
        },
      })),
    };
  }, [surgeZones]);

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
    if (allCoords.length < 2) return null;
    return computeBounds(allCoords);
  }, [pickupLocation, dropoffLocation, driverLocation, routeCoordinates]);

  // Default center: driver location > Havana
  const defaultCenter: [number, number] = driverLocation
    ? toCoord(driverLocation)
    : HAVANA_CENTER;

  // Expose imperative API for parent (camera control)
  useImperativeHandle(ref, () => ({
    flyTo(lat: number, lng: number, zoom = 14) {
      cameraRef.current?.flyTo([lng, lat], zoom);
    },
    recenterOnDriver() {
      if (driverLocation) {
        cameraRef.current?.flyTo(toCoord(driverLocation), 15);
      }
    },
  }), [driverLocation]);

  // ── Web: Use real Mapbox GL if available ─────────────────────────────────────
  if (!MapboxGL) {
    if (mapboxgl && Platform.OS === 'web' && MAPBOX_TOKEN) {
      return (
        <WebMapboxView
          driverLocation={driverLocation}
          pickupLocation={pickupLocation}
          dropoffLocation={dropoffLocation}
          riderLocation={riderLocation}
          routeCoordinates={routeCoordinates}
          heatmapData={heatmapData}
          surgeZones={surgeZones}
          height={height}
          darkStyle={darkStyle}
          onRecenter={onRecenter}
          vehicleType={vehicleType}
          followMode={followMode}
          driverHeading={driverHeading}
          onUserInteraction={onUserInteraction}
        />
      );
    }

    // Last resort: stylized dark grid fallback (no Mapbox token / offline)
    return (
      <View style={[webFallbackStyles.container, { height }]}>
        <View style={webFallbackStyles.gradientBase} />
        <View style={webFallbackStyles.gradientOverlay} />
        <View style={webFallbackStyles.gridContainer} pointerEvents="none">
          {[0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((pos, i) => (
            <View key={`h${i}`} style={[webFallbackStyles.gridLineH, { top: `${pos * 100}%` as any }]} />
          ))}
          {[0.12, 0.28, 0.42, 0.58, 0.72, 0.88].map((pos, i) => (
            <View key={`v${i}`} style={[webFallbackStyles.gridLineV, { left: `${pos * 100}%` as any }]} />
          ))}
          <View style={webFallbackStyles.diagonalLine} />
        </View>
        <View style={webFallbackStyles.cityWatermark} pointerEvents="none">
          <Text style={webFallbackStyles.cityText}>LA HABANA</Text>
        </View>
        <View style={webFallbackStyles.glowOrange} pointerEvents="none" />
        <View style={webFallbackStyles.glowOrange2} pointerEvents="none" />
        {onRecenter && (
          <Pressable
            style={({ pressed }) => [styles.recenterBtn, pressed && { opacity: 0.7 }]}
            onPress={onRecenter}
            accessibilityLabel="Centrar en mi posición"
            accessibilityRole="button"
          >
            <Ionicons name="locate" size={20} color="#fff" />
          </Pressable>
        )}
      </View>
    );
  }

  // ── Native: Use @rnmapbox/maps ──────────────────────────────────────────────
  const mapStyle = darkStyle ? STYLE_DARK_NAV : STYLE_STREETS;

  return (
    <View style={{ height, borderRadius: 0, overflow: 'hidden', position: 'relative' }}
      accessibilityLabel={t('a11y.ride_map', { ns: 'common' })}
      accessibilityRole="image"
    >
      <MapboxGL.MapView
        style={{ flex: 1 }}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        styleURL={mapStyle}
        attributionEnabled={false}
        logoEnabled={false}
        compassEnabled={false}
        onRegionWillChange={(feature: any) => {
          if (feature?.properties?.isUserInteraction && followMode) {
            onUserInteraction?.();
          }
        }}
      >
        <MapboxGL.Camera
          ref={cameraRef}
          defaultSettings={{ centerCoordinate: defaultCenter, zoomLevel: 14 }}
          {...(followMode && driverLocation
            ? {
                centerCoordinate: toCoord(driverLocation),
                zoomLevel: 16.5,
                pitch: 45,
                heading: driverHeading ?? 0,
                animationDuration: 1000,
                animationMode: 'easeTo',
              }
            : bounds
              ? {
                  bounds: {
                    ne: bounds.ne,
                    sw: bounds.sw,
                    paddingTop: 60,
                    paddingRight: 60,
                    paddingBottom: 120,
                    paddingLeft: 60,
                  },
                  animationDuration: 600,
                }
              : {}
          )}
        />
        {routeGeoJSON && (
          <MapboxGL.ShapeSource id="route" shape={routeGeoJSON}>
            <MapboxGL.LineLayer
              id="routeLine"
              style={{ lineColor: colors.brand.orange, lineWidth: 4, lineCap: 'round', lineJoin: 'round' }}
            />
          </MapboxGL.ShapeSource>
        )}
        {pickupLocation && (
          <MapboxGL.PointAnnotation id="pickup" coordinate={toCoord(pickupLocation)}>
            <View style={styles.pickupMarker} />
          </MapboxGL.PointAnnotation>
        )}
        {dropoffLocation && (
          <MapboxGL.PointAnnotation id="dropoff" coordinate={toCoord(dropoffLocation)}>
            <View style={styles.dropoffMarker} />
          </MapboxGL.PointAnnotation>
        )}
        {riderLocation && (
          <MapboxGL.PointAnnotation id="rider" coordinate={toCoord(riderLocation)}>
            <View style={styles.riderMarker} accessibilityLabel="Rider location" />
          </MapboxGL.PointAnnotation>
        )}
        {driverLocation && (
          <MapboxGL.PointAnnotation id="driver" coordinate={toCoord(driverLocation)}>
            <View style={styles.driverMarkerContainer}>
              <Animated.View
                style={[styles.driverRing, { transform: [{ scale: ringAnim }], opacity: ringOpacity }]}
              />
              <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                {vehicleType && vehicleMarkerImages[vehicleType] ? (
                  <View style={styles.vehicleIconContainer}>
                    <Image source={vehicleMarkerImages[vehicleType]} style={styles.vehicleIcon} resizeMode="contain" />
                  </View>
                ) : (
                  <View style={styles.driverDot} />
                )}
              </Animated.View>
            </View>
          </MapboxGL.PointAnnotation>
        )}
        {surgeGeoJSON && (
          <MapboxGL.ShapeSource id="surge-zones" shape={surgeGeoJSON}>
            <MapboxGL.FillLayer
              id="surge-fill"
              style={{
                fillColor: ['get', 'fillColor'],
                fillOpacity: 1,
              }}
            />
            <MapboxGL.LineLayer
              id="surge-stroke"
              style={{
                lineColor: ['get', 'strokeColor'],
                lineWidth: 1.5,
                lineDasharray: [3, 2],
              }}
            />
          </MapboxGL.ShapeSource>
        )}
        {heatmapGeoJSON && (
          <MapboxGL.ShapeSource id="heatmap" shape={heatmapGeoJSON}>
            <MapboxGL.CircleLayer
              id="heatmap-circles"
              style={{
                circleRadius: 45,
                circleColor: [
                  'interpolate', ['linear'], ['get', 'intensity'],
                  0.0, 'rgba(34, 197, 94, 0.12)',
                  0.4, 'rgba(234, 179, 8, 0.18)',
                  0.7, 'rgba(255, 77, 0, 0.22)',
                ],
                circleBlur: 0.6,
                circleStrokeWidth: 0,
              }}
            />
          </MapboxGL.ShapeSource>
        )}
      </MapboxGL.MapView>
      {!followMode && driverLocation && (
        <Pressable
          onPress={onRecenter}
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: '#FF4D00',
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.3,
            shadowRadius: 4,
            elevation: 4,
          }}
          accessibilityRole="button"
          accessibilityLabel={t('map.recenter', { defaultValue: 'Recentrar' })}
        >
          <Ionicons name="navigate" size={20} color="#fff" />
        </Pressable>
      )}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  pickupMarker: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: colors.success.DEFAULT, borderWidth: 3, borderColor: 'white',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 4, elevation: 4,
  },
  dropoffMarker: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: colors.error.DEFAULT, borderWidth: 3, borderColor: 'white',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 4, elevation: 4,
  },
  riderMarker: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: '#3b82f6', borderWidth: 3, borderColor: 'white',
    shadowColor: '#3b82f6', shadowOpacity: 0.5, shadowRadius: 6, elevation: 4,
  },
  driverMarkerContainer: {
    width: 60, height: 60, alignItems: 'center', justifyContent: 'center',
  },
  driverRing: {
    position: 'absolute', width: 50, height: 50, borderRadius: 25,
    backgroundColor: 'rgba(255,77,0,0.2)',
  },
  driverDot: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: colors.brand.orange, borderWidth: 3, borderColor: 'white',
    shadowColor: colors.brand.orange, shadowOpacity: 0.6, shadowRadius: 8, elevation: 6,
  },
  vehicleIconContainer: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(13,13,26,0.85)', alignItems: 'center', justifyContent: 'center',
    borderWidth: 2.5, borderColor: colors.brand.orange,
    shadowColor: colors.brand.orange, shadowOpacity: 0.7, shadowRadius: 10, elevation: 8,
  },
  vehicleIcon: { width: 28, height: 28 },
  recenterBtn: {
    position: 'absolute', bottom: 16, right: 16,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(30,30,30,0.85)', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6, elevation: 6,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
});

// ── Web fallback styles (last resort if mapbox-gl not available) ─────────────
const webFallbackStyles = StyleSheet.create({
  container: { position: 'relative', overflow: 'hidden', backgroundColor: '#0d0d1a' },
  gradientBase: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0d0d1a' },
  gradientOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#1a1a2e', opacity: 0.4 },
  gridContainer: { ...StyleSheet.absoluteFillObject },
  gridLineH: {
    position: 'absolute', left: 0, right: 0,
    height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.04)',
  },
  gridLineV: {
    position: 'absolute', top: 0, bottom: 0,
    width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.04)',
  },
  diagonalLine: {
    position: 'absolute', top: '20%' as any, left: '10%' as any, width: '80%' as any,
    height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.03)',
    transform: [{ rotate: '-25deg' }],
  },
  cityWatermark: {
    position: 'absolute', top: '40%' as any, left: 0, right: 0, alignItems: 'center',
  },
  cityText: {
    fontFamily: 'Montserrat', fontSize: 48, fontWeight: '800',
    color: 'rgba(255,255,255,0.035)', letterSpacing: 16,
  },
  glowOrange: {
    position: 'absolute', top: '25%' as any, right: '15%' as any,
    width: 120, height: 90, borderRadius: 50, backgroundColor: 'rgba(255,77,0,0.06)',
  },
  glowOrange2: {
    position: 'absolute', bottom: '35%' as any, left: '20%' as any,
    width: 80, height: 60, borderRadius: 30, backgroundColor: 'rgba(255,77,0,0.04)',
  },
});

export const RideMapView = forwardRef(RideMapViewInner);
