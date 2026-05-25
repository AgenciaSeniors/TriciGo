import React, { useState, useMemo, useEffect, useRef, useImperativeHandle, useCallback, forwardRef } from 'react';
import { View, Text, Animated, Pressable, StyleSheet, Platform, Image, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { MAP_STYLE_LIGHT, MAP_COLORS, MARKER, ROUTE, snapDriverToRoute, smoothHeading, vehicleMarkerRotationOffset, useAnimatedCoordinate } from '@tricigo/utils';
import type { NearbyVehicle, DemandHotspot, PopularLocation } from '@tricigo/types';
import { HotspotPulseMarker } from './HotspotPulseMarker';
import { PopularLocationPin } from './PopularLocationPin';
import { useMapboxReady } from '../hooks/useMapboxReady';
import { PoiMapLayers, useViewportPois, extractBoundsFromCameraEvent } from '@tricigo/ui';

// Native map (iOS/Android)
let MapboxGL: any;
try {
  MapboxGL = require('@rnmapbox/maps').default;
} catch {
  MapboxGL = null;
}

// Ensure Mapbox access token is set SYNCHRONOUSLY before any MapView
// is instantiated. This runs once per process (guarded by module-scoped
// flag). Release builds on Android race between _layout's setAccessToken
// and the first MapView mount — calling it here guarantees the token is
// in place before React returns the MapView element to the native bridge.
let _mapboxTokenApplied = false;
function ensureMapboxToken() {
  if (_mapboxTokenApplied || Platform.OS === 'web' || !MapboxGL) return;
  try {
    const token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
    if (!token) return; // can't apply without a token; caller will retry
    MapboxGL.setAccessToken(token);
    // BUG-216: removed setWellKnownTileServer call — deprecated in
    // @rnmapbox/maps newer versions. The tile server is auto-detected
    // from the access token (Mapbox tokens always use Mapbox tiles).
    // The call was logging "[error] setWellKnownTileServer is deprecated"
    // on every dev-client open — pure noise, no functional impact.
    if (typeof MapboxGL.setTelemetryEnabled === 'function') {
      MapboxGL.setTelemetryEnabled(false);
    }
    _mapboxTokenApplied = true;
  } catch {
    // If it fails, _layout.tsx useEffect retry will pick it up
  }
}
ensureMapboxToken();

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
  /**
   * BUG-267 v3 — current ride status. When present and in
   * {accepted, driver_en_route, arrived_at_pickup, in_progress} the
   * camera uses a per-status cinematic profile (zoom/pitch optimized
   * for the phase of the trip) instead of the legacy fixed
   * zoom-16.5/pitch-45. Only consulted when `followMode` is true.
   */
  rideStatus?: string | null;
  /**
   * When true, prevents zoom-out beyond level 14 regardless of follow mode.
   * Set during active trips so the driver never loses position context, even
   * after panning. Independent of followMode so the user can still pan/zoom
   * within the locked range.
   */
  lockZoom?: boolean;
  /** Bottom padding offset to shift controls above bottom sheet */
  bottomOffset?: number;
  /** Additional style for the map container */
  containerStyle?: object;
  /** Other online drivers to render as peer markers (top-down vehicle icons). */
  nearbyDrivers?: NearbyVehicle[];
  /** Demand hotspots with pulse animation (top 8). */
  demandHotspots?: DemandHotspot[];
  /**
   * Popular pickup/dropoff clusters (90-day historical aggregate).
   * Rendered as static pins differentiated from the live demand
   * hotspots — see PopularLocationPin. Off by default; the home
   * screen exposes a toggle.
   */
  popularLocations?: PopularLocation[];
}

const vehicleMarkerImages: Record<string, any> = {
  triciclo: require('../../assets/vehicles/markers/triciclo.png'),
  moto: require('../../assets/vehicles/markers/moto.png'),
  // BUG-218: "auto" service is the Cuban classic almendrón, NOT the modern
  // comfort sedan. The previous auto.png was a generic modern car which
  // looked identical to confort.png on the map. auto_clasico.png is the
  // 1950s vintage car that visually identifies the standard auto service.
  auto: require('../../assets/vehicles/markers/auto_clasico.png'),
  confort: require('../../assets/vehicles/markers/confort.png'),
  mensajeria: require('../../assets/vehicles/markers/mensajeria.png'),
};

// Cargo box marker has no inherent "front" direction — keep rotation 0
// instead of spinning a square around its center as the bearing changes.
const NON_ROTATING_MARKERS = new Set<string>(['mensajeria']);

// Mapbox `centerCoordinate` uses [lng, lat]. The driver app is Cuba-only,
// so the fallback when GPS is unavailable is always La Habana.
const HAVANA_CENTER: [number, number] = [-82.3666, 23.1136];
const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
const STYLE_DARK_NAV = 'mapbox://styles/mapbox/navigation-night-v1';
const STYLE_STREETS = MAP_STYLE_LIGHT;

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
  lockZoom,
  bottomOffset = 0,
  containerStyle,
  nearbyDrivers,
  demandHotspots,
  popularLocations,
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
        border: 2.5px solid ${MAP_COLORS.driverSelf};
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
        background: ${MAP_COLORS.driverSelf};
        border: 3px solid white;
        box-shadow: 0 0 12px rgba(255,77,0,0.6);
      }
    `;
    // Also inject pickup/dropoff keyframes
    if (!document.getElementById('tricigo-map-keyframes')) {
      const kfStyle = document.createElement('style');
      kfStyle.id = 'tricigo-map-keyframes';
      kfStyle.textContent = `
        @keyframes pulse-pickup { 0%{transform:scale(1);opacity:0.6} 100%{transform:scale(2.5);opacity:0} }
        @keyframes drop-in { 0%{transform:scale(0.3);opacity:0} 60%{transform:scale(1.05)} 100%{transform:scale(1);opacity:1} }
        @media (prefers-reduced-motion: reduce) {
          .tricigo-pulse-pickup { animation: none !important; }
        }
      `;
      document.head.appendChild(kfStyle);
    }
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
      el.innerHTML = `<div style="position:relative;width:${MARKER.driver.ringSize}px;height:${MARKER.driver.ringSize}px;display:flex;align-items:center;justify-content:center;"><div class="tricigo-pulse-pickup" style="position:absolute;width:${MARKER.pickup.size}px;height:${MARKER.pickup.size}px;border-radius:50%;background:${MAP_COLORS.pickup};animation:pulse-pickup 2s ease-out infinite;"></div><div style="width:${MARKER.pickup.size}px;height:${MARKER.pickup.size}px;border-radius:50%;background:${MAP_COLORS.pickup};border:3px solid white;box-shadow:${MARKER.pickup.shadow};display:flex;align-items:center;justify-content:center;position:relative;z-index:1;"><div style="width:${MARKER.pickup.innerDot}px;height:${MARKER.pickup.innerDot}px;border-radius:50%;background:white;"></div></div></div>`;
      pickupMarkerRef.current = new (mapboxgl as any).Marker({ element: el })
        .setLngLat([pickupLocation.longitude, pickupLocation.latitude])
        .addTo(map);
    }

    if (dropoffLocation) {
      // BUG-281: branded TriciGo pin via CSS-only teardrop in brand orange.
      // The Expo Web variant of the driver app doesn't ship a public/ folder,
      // so we draw the pin shape with CSS (gradient fill + white inner dot)
      // instead of loading the PNG. The look matches the native MarkerView
      // pin closely enough that QA from web preview is still meaningful.
      const el = document.createElement('div');
      el.style.animation = 'drop-in 0.4s ease-out';
      el.innerHTML = `
        <div style="position:relative;width:32px;height:42px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));">
          <div style="position:absolute;top:0;left:0;width:32px;height:32px;background:${MAP_COLORS.brand};border:3px solid white;border-radius:50%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;">
            <div style="width:11px;height:11px;border-radius:50%;background:white;"></div>
          </div>
          <div style="position:absolute;top:25px;left:8px;width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-top:14px solid ${MAP_COLORS.brand};"></div>
        </div>`;
      dropoffMarkerRef.current = new (mapboxgl as any).Marker({ element: el, anchor: 'bottom' })
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
      el.innerHTML = `<div style="width:28px;height:28px;border-radius:50%;background:${MAP_COLORS.driver};border:3px solid white;box-shadow:${MARKER.driver.shadow};"></div>`;
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
        if (map.getLayer('route-line')) map.removeLayer('route-line');
        if (map.getLayer('route-shadow')) map.removeLayer('route-shadow');
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
        id: 'route-shadow',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ROUTE.shadow.color, 'line-width': ROUTE.shadow.width, 'line-opacity': ROUTE.shadow.opacity, 'line-blur': ROUTE.shadow.blur },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ROUTE.main.color, 'line-width': ROUTE.main.width, 'line-opacity': ROUTE.main.opacity },
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
            backgroundColor: MAP_COLORS.driverSelf,
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

/**
 * Reusable stylized map placeholder. PR E (2026-05-12) — extracts the
 * grid + glow + "LA HABANA" watermark already used by the no-Mapbox /
 * token-not-applied fallbacks, so the *same* placeholder can also be
 * rendered as a transient overlay above the live MapView until its
 * style finishes streaming on first install. Before this fix, that
 * gap showed up as a pure-black rectangle because navigation-night-v1's
 * default background renders dark before any tiles arrive.
 *
 * `absolute` mode (default) fills the parent — used as an overlay on
 * top of <MapboxGL.MapView>. Pass `height` to render as a standalone
 * block (legacy fallback paths).
 */
function MapFallbackGrid({ height, absolute = false }: { height?: number; absolute?: boolean }) {
  const containerStyle = absolute
    ? [webFallbackStyles.container, StyleSheet.absoluteFillObject as object]
    : [webFallbackStyles.container, { height }];
  return (
    <View style={containerStyle} pointerEvents="none">
      <View style={webFallbackStyles.gradientBase} />
      <View style={webFallbackStyles.gradientOverlay} />
      <View style={webFallbackStyles.gridContainer}>
        {[0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((pos, i) => (
          <View key={`h${i}`} style={[webFallbackStyles.gridLineH, { top: `${pos * 100}%` as any }]} />
        ))}
        {[0.12, 0.28, 0.42, 0.58, 0.72, 0.88].map((pos, i) => (
          <View key={`v${i}`} style={[webFallbackStyles.gridLineV, { left: `${pos * 100}%` as any }]} />
        ))}
        <View style={webFallbackStyles.diagonalLine} />
      </View>
      <View style={webFallbackStyles.cityWatermark}>
        <Text style={webFallbackStyles.cityText}>LA HABANA</Text>
      </View>
      <View style={webFallbackStyles.glowOrange} />
      <View style={webFallbackStyles.glowOrange2} />
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
    lockZoom,
    nearbyDrivers,
    demandHotspots,
    popularLocations,
    rideStatus,
  }: RideMapViewProps,
  ref: React.Ref<RideMapViewRef>,
) {
  // Synchronous re-check: if Mapbox token wasn't applied at module load
  // (e.g. native bridge wasn't ready), apply it NOW before we return any
  // MapView element. Idempotent — guarded by module-scoped flag.
  ensureMapboxToken();

  // BUG-209 v2: the module-scoped flag _mapboxTokenApplied does NOT
  // trigger React re-renders when it flips. Previous version returned
  // a "LA HABANA" grid placeholder when the flag was false at first
  // render and stayed stuck on it forever (until the user killed the
  // app and reopened — that re-mounted the component, picking up the
  // now-applied flag).
  //
  // Now: track the flag in React state, and run a retry loop that
  // polls every 250ms up to 2.5s. If the token is still not applied
  // after 10 attempts, give up and let MapView render anyway — at
  // worst a gray tile shows briefly until the next region change
  // triggers a re-fetch (matches the client app behaviour, which
  // never had this guard and works fine).
  const [tokenApplied, setTokenApplied] = useState(_mapboxTokenApplied);
  useEffect(() => {
    if (tokenApplied || Platform.OS === 'web') return;
    let attempts = 0;
    const interval = setInterval(() => {
      ensureMapboxToken();
      if (_mapboxTokenApplied) {
        setTokenApplied(true);
        clearInterval(interval);
      } else if (++attempts >= 10) {
        // Exhausted: stop blocking the MapView render. Better a gray
        // tile that auto-recovers than a permanently stuck placeholder.
        setTokenApplied(true);
        clearInterval(interval);
      }
    }, 250);
    return () => clearInterval(interval);
  }, [tokenApplied]);

  // BUG-006 v2 (gray map cold-start fix): wait for NetInfo + DNS prewarm
  // to api.mapbox.com BEFORE mounting the native MapView. This supersedes
  // the `setTimeout(0) + fetch()` fire-and-forget in _layout.tsx which
  // couldn't guarantee timing. `mapInstanceKey` is used to force a full
  // re-mount of the MapView when `onDidFailLoadingMap` fires (SDK retries
  // internally only 2x; re-mount gives it a fresh budget with DNS now
  // resolved).
  const { ready: mapboxReady, error: mapboxNetError, retry: retryMapboxReady } = useMapboxReady();
  const [mapInstanceKey, setMapInstanceKey] = useState(0);

  const { t } = useTranslation('driver');
  const cameraRef = useRef<any>(null);

  // POI rendering — display-only on the driver app (no `onPoiPress` since
  // tapping a POI during a trip would distract from the route). Seeds from
  // current driverLocation so POIs appear immediately on cold mount.
  const poiSeedCenter = driverLocation
    ? { latitude: driverLocation.latitude, longitude: driverLocation.longitude }
    : null;
  const { pois: viewportPois, onCameraChanged: poiOnCameraChanged } = useViewportPois(poiSeedCenter);

  // BUG-poi-viewport-visibility (PR D, 2026-05-25): use shared
  // extractor so events without visibleBounds (common on @rnmapbox v10.3
  // new arch mid-pan) still trigger a POI refetch via centre+zoom
  // synthesis instead of silently no-op'ing.
  const handlePoiCameraChanged = useCallback((event: unknown) => {
    const result = extractBoundsFromCameraEvent(event);
    if (!result) return;
    poiOnCameraChanged(result.bounds, result.zoom);
  }, [poiOnCameraChanged]);
  const [markerImageError, setMarkerImageError] = useState(false);
  // PR E (2026-05-12) — track whether MapboxGL has finished streaming
  // the style URL. On first install, fetching the style + glyphs from
  // api.mapbox.com can take 1–3s; until then the native MapView paints
  // its dark background and the user sees a pure-black rectangle. We
  // render <MapFallbackGrid /> on top until onDidFinishLoadingStyle fires.
  const [styleLoaded, setStyleLoaded] = useState(false);

  // BUG-006 v2: auto-retry handler. When Mapbox SDK reports it failed to
  // load (style/tile fetch ERR_NAME_NOT_RESOLVED or similar), bump the
  // MapView key to force a complete re-mount + re-run the DNS prewarm.
  // Without this the SDK gave up after 2 internal retries and stayed gray
  // until the user manually killed the app.
  const handleMapLoadFailure = useCallback((reason: string) => {
    console.warn('[RideMapView]', reason, '— forcing MapView re-mount + DNS prewarm retry');
    setStyleLoaded(false);
    setMapInstanceKey((n) => n + 1);
    retryMapboxReady();
  }, [retryMapboxReady]);

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

  // BUG-marker-position-lag: pulse ring listeners. The driver marker now
  // renders via ShapeSource+SymbolLayer (no React children), so the
  // Animated.View pulse rings can't be nested inside the marker. We mirror
  // the two animated scales into React state so CircleLayer styles can
  // consume the numeric radius. Native driver still drives the timing —
  // we just sample the value on every JS tick.
  const [innerPulseRadiusPx, setInnerPulseRadiusPx] = useState<number>(MARKER.driver.ringSize / 2);
  const [outerPulseRadiusPx, setOuterPulseRadiusPx] = useState<number>(MARKER.driver.ringSize / 2);
  const [outerPulseOpacityVal, setOuterPulseOpacityVal] = useState<number>(0.6);
  useEffect(() => {
    const baseRadius = MARKER.driver.ringSize / 2;
    const innerId = pulseAnim.addListener(({ value }) => setInnerPulseRadiusPx(baseRadius * value));
    const outerId = ringAnim.addListener(({ value }) => setOuterPulseRadiusPx(baseRadius * value));
    const opacityId = ringOpacity.addListener(({ value }) => setOuterPulseOpacityVal(value));
    return () => {
      pulseAnim.removeListener(innerId);
      ringAnim.removeListener(outerId);
      ringOpacity.removeListener(opacityId);
    };
  }, [pulseAnim, ringAnim, ringOpacity]);

  // Pickup pulse ring animation (native only) — BUG-218: reduced peak scale
  // from 2.5 (80px halo) to 1.5 (48px) so the pickup doesn't dominate the map.
  const pickupPulseAnim = useRef(new Animated.Value(1)).current;
  const pickupPulseOpacity = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    if (!pickupLocation) return;
    const anim = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(pickupPulseAnim, { toValue: 1.5, duration: 1800, useNativeDriver: true }),
          Animated.timing(pickupPulseAnim, { toValue: 1, duration: 0, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(pickupPulseOpacity, { toValue: 0, duration: 1800, useNativeDriver: true }),
          Animated.timing(pickupPulseOpacity, { toValue: 0.4, duration: 0, useNativeDriver: true }),
        ]),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [pickupLocation, pickupPulseAnim, pickupPulseOpacity]);

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

  // Build peer drivers GeoJSON (top-down vehicle icons for everyone else)
  const peersGeoJSON = useMemo(() => {
    if (!nearbyDrivers || nearbyDrivers.length === 0) return null;
    return {
      type: 'FeatureCollection' as const,
      features: nearbyDrivers.map((v) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [v.longitude, v.latitude],
        },
        properties: {
          id: v.driver_profile_id,
          icon: `marker-${v.vehicle_type || 'auto'}`,
          heading: v.heading ?? 0,
        },
      })),
    };
  }, [nearbyDrivers]);

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

  // Compute camera bounds — only when overview mode (followMode=false).
  // Skipping during followMode avoids the per-GPS-update recompute that
  // forced re-renders (and the now-removed fitBounds) every second
  // during in-progress trips. Pre-trip phases (accepted, arrived_at_*)
  // typically have followMode=false → bounds still compute as before.
  const bounds = useMemo(() => {
    if (followMode) return null;
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
  }, [pickupLocation, dropoffLocation, driverLocation, routeCoordinates, followMode]);

  // BUG-218: force imperative fitBounds whenever bounds change. Mapbox's
  // declarative <Camera bounds=...> prop sometimes doesn't re-fit on hot
  // reload because the underlying native MapView is already mounted.
  useEffect(() => {
    if (!bounds || followMode) return;
    const camera = cameraRef.current;
    if (!camera) return;
    try {
      camera.fitBounds(bounds.ne, bounds.sw, [80, 60, 360, 60], 600);
    } catch {
      // some Mapbox versions name the method differently — best-effort
    }
  }, [bounds, followMode]);

  // BUG-293 (Round 3): snap driver position to the route polyline.
  // Returns the projected point + the segment's bearing when the GPS is
  // within 30m of the polyline. Falls back to null when the driver
  // genuinely departed the route — caller then renders raw GPS.
  // Display-side only; ride_location_events keeps the raw lat/lng.
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
  }, [driverLocation?.latitude, driverLocation?.longitude, routeCoordinates]);

  // Effective driver position + bearing (snapped if on-route, raw if off-route).
  const effectiveDriverCoord: [number, number] | null = driverLocation
    ? [
        snappedDriver?.longitude ?? driverLocation.longitude,
        snappedDriver?.latitude ?? driverLocation.latitude,
      ]
    : null;

  // BUG-marker-position-lag (2026-05-24): smooth interpolation between
  // discrete GPS samples so the driver's own marker glides Uber-style
  // instead of teleporting every ~200-1000 ms (GPS callback rate varies
  // by speed; throttle on upload is 1Hz but local rendering can be faster).
  const renderedDriverCoord = useAnimatedCoordinate(
    effectiveDriverCoord
      ? { latitude: effectiveDriverCoord[1], longitude: effectiveDriverCoord[0] }
      : null,
    1000,
  );

  // BUG-298: smooth the effective bearing with EMA to dampen the discrete
  // jumps that happen when `snapDriverToRoute` switches polyline segments
  // along a curve. Without this, the marker rotation "ticks" 5-15° on each
  // segment change in a smooth curve. The same EMA also bridges the gap
  // when snap goes from active → null (driver deviates) so the icon doesn't
  // flip instantly to raw GPS heading.
  //
  // Also: the CAMERA now reads `effectiveDriverHeading` instead of the
  // raw `driverHeading`, so the marker icon and the street geometry below
  // it always rotate in sync (BUG-298 root cause: camera was on raw GPS
  // heading, marker was on snapped polyline bearing — divergence in curves).
  //
  // Implementation: useState + useEffect rather than useMemo with a ref
  // mutation. Mutating a ref inside useMemo is an anti-pattern — in
  // StrictMode (Expo dev default) useMemo runs twice per render, which
  // would apply the EMA twice and over-smooth. useEffect runs once per
  // commit, after the render, so the ref + state always stay coherent.
  // Trade-off: 1 extra render per GPS update (1Hz), which is negligible.
  const lastSmoothedHeadingRef = useRef<number | null>(null);
  const [effectiveDriverHeading, setEffectiveDriverHeading] = useState<number>(0);

  useEffect(() => {
    const target =
      snappedDriver?.bearing ??
      (typeof driverHeading === 'number' && Number.isFinite(driverHeading)
        ? driverHeading
        : null);
    if (target == null) return;
    const next = smoothHeading(target, lastSmoothedHeadingRef.current);
    lastSmoothedHeadingRef.current = next;
    setEffectiveDriverHeading(next);
  }, [snappedDriver?.bearing, driverHeading]);

  // Default center: driver location > Havana
  const defaultCenter: [number, number] = driverLocation
    ? toCoord(driverLocation)
    : HAVANA_CENTER;

  // BUG-267 v3 + Round 5 — Uber-style cinematic camera profile per ride
  // status. Active only while followMode is true AND we have a driver fix.
  // The legacy fixed zoom-16.5/pitch-45 is preserved as the fallback (when
  // rideStatus is null/unknown, e.g. idle online sessions).
  //
  // Round 5 update — PITCH MIXTO confirmed by user:
  //   Info phases (parado / llegada) → pitch BAJO + zoom alto top-down:
  //     accepted (pickup glance):       z=15.5  pitch=10  flyTo 1500
  //     arrived_at_pickup:              z=18    pitch=0   easeTo 800
  //     arrived_at_destination:         z=17.5  pitch=0   easeTo 800
  //   Nav phases (manejando) → 3D inmersivo:
  //     driver_en_route:                z=16.5  pitch=45  easeTo 1000
  //     in_progress:                    z=17.5  pitch=45  easeTo 800
  //
  // Rationale: info phases need legible street names (top-down), nav
  // phases benefit from 3D perspective (Waze/GMaps style). Earlier
  // values (z=14-17.5, pitch 0-50) were inconsistent — high pitch on
  // arrived_at_pickup made street names unreadable, low zoom on accepted
  // hid the pickup detail. Closer + status-appropriate pitch = more
  // Uber-like.
  const tripCameraProfile = useMemo(() => {
    if (!followMode || !driverLocation) return null;
    const driverCoord = toCoord(driverLocation);
    // BUG-298: camera bearing must match the marker bearing. Previously this
    // was `driverHeading` (raw GPS+EMA from useDriverLocation), while the
    // marker was rotated by `effectiveDriverHeading` (snap-to-route bearing).
    // The two values diverge in curves, making the icon appear "rotated wrong"
    // relative to the street pinted below. Unifying both to the snapped+EMA
    // heading keeps the icon visually aligned with the route polyline.
    const heading = effectiveDriverHeading;

    switch (rideStatus) {
      case 'accepted':
        // Info phase: close enough to see pickup neighbourhood, mild tilt
        // for spatial context, north-up so the rider thumbnail and the
        // pickup pin both stay aligned.
        return {
          centerCoordinate: driverCoord,
          zoomLevel: 15.5,
          pitch: 10,
          heading: 0,
          animationDuration: 1500,
          animationMode: 'flyTo' as const,
        };
      case 'driver_en_route':
        // Nav phase: 3D perspective, heading-up navigation. Closer zoom
        // (16.5) than the previous 15.5 so individual streets are visible.
        // animationDuration 800ms (was 1000ms) so each ease-to completes
        // BEFORE the next GPS update fires (1000ms watch interval) —
        // avoiding the race where in-flight animations get interrupted.
        return {
          centerCoordinate: driverCoord,
          zoomLevel: 16.5,
          pitch: 45,
          heading,
          animationDuration: 800,
          animationMode: 'easeTo' as const,
        };
      case 'arrived_at_pickup':
        // Info phase: top-down + tightest zoom so the driver can spot the
        // rider on the sidewalk. Pitch=0 keeps street labels legible.
        return {
          centerCoordinate: driverCoord,
          zoomLevel: 18,
          pitch: 0,
          heading: 0,
          animationDuration: 800,
          animationMode: 'easeTo' as const,
        };
      case 'in_progress':
        // Nav phase: same family as driver_en_route, slightly tighter
        // zoom (17.5) for the dense city driving leg with rider on board.
        return {
          centerCoordinate: driverCoord,
          zoomLevel: 17.5,
          pitch: 45,
          heading,
          animationDuration: 800,
          animationMode: 'easeTo' as const,
        };
      case 'arrived_at_destination':
        // Info phase (NEW — was falling through to default with random
        // values). Top-down zoom on the drop-off so the driver verifies
        // they're at the right building before tapping "Finalizar viaje".
        return {
          centerCoordinate: driverCoord,
          zoomLevel: 17.5,
          pitch: 0,
          heading: 0,
          animationDuration: 800,
          animationMode: 'easeTo' as const,
        };
      default:
        // No status (idle online with manual follow toggle) — legacy profile.
        return {
          centerCoordinate: driverCoord,
          zoomLevel: 16.5,
          pitch: 45,
          heading,
          animationDuration: 1000,
          animationMode: 'easeTo' as const,
        };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    followMode,
    driverLocation?.latitude,
    driverLocation?.longitude,
    // BUG-298: camera now reads `effectiveDriverHeading` (snapped+smoothed)
    // instead of raw `driverHeading`. Keep both in deps so the camera
    // re-evaluates when either the snap bearing or the raw GPS heading
    // changes (the latter still feeds the smoothing when snap is null).
    driverHeading,
    effectiveDriverHeading,
    rideStatus,
  ]);

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
          nearbyDrivers={nearbyDrivers}
          demandHotspots={demandHotspots}
          popularLocations={popularLocations}
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
  // BUG-006 v2 gate: wait for NetInfo + DNS prewarm before instantiating
  // the native MapView. Without this the SDK can race with cold-start DNS
  // resolution and render permanently gray. The MapFallbackGrid is the
  // same placeholder used by BUG-209 — visually consistent. If `mapboxNetError`
  // is set (e.g. no network), show a retry button overlaid.
  if (!mapboxReady) {
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
        <View style={webFallbackStyles.glowOrange} pointerEvents="none" />
        <View style={webFallbackStyles.glowOrange2} pointerEvents="none" />
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' }} pointerEvents="box-none">
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: '#fff', marginTop: 12, fontSize: 14 }}>
            {mapboxNetError === 'no_network' ? 'Sin conexión' : 'Preparando mapa…'}
          </Text>
          {mapboxNetError === 'no_network' && (
            <Pressable
              onPress={retryMapboxReady}
              style={{ marginTop: 16, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 8 }}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>Reintentar</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  // BUG-209 (6) v2: while the token-retry effect (above) is still trying,
  // show the stylized grid placeholder so the user sees SOMETHING instead
  // of a flash of gray Mapbox tile. The state-driven gate ensures we
  // automatically swap to the real MapView the moment the token applies
  // (or after the 2.5s retry budget is exhausted) — no app restart needed.
  if (!tokenApplied) {
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
        <View style={webFallbackStyles.glowOrange} pointerEvents="none" />
        <View style={webFallbackStyles.glowOrange2} pointerEvents="none" />
      </View>
    );
  }

  const mapStyle = darkStyle ? STYLE_DARK_NAV : STYLE_STREETS;

  return (
    <View style={{ height, borderRadius: 0, overflow: 'hidden', position: 'relative' }}
      accessibilityLabel={t('a11y.ride_map', { ns: 'common' })}
      accessibilityRole="image"
    >
      <MapboxGL.MapView
        // BUG-006 v2: `key` change forces full re-mount of the native
        // MapView. `handleMapLoadFailure` bumps this key when the SDK
        // gives up after its 2 internal retries — gives Mapbox a fresh
        // budget with DNS now resolved by our prewarm hook.
        key={mapInstanceKey}
        style={{ flex: 1 }}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        styleURL={mapStyle}
        attributionEnabled={false}
        logoEnabled={false}
        compassEnabled={false}
        onDidFinishLoadingStyle={() => setStyleLoaded(true)}
        onDidFailLoadingMap={() => {
          // First-install network race or DNS not yet resolved. BUG-006 v2:
          // bump key + retry prewarm so the SDK gets another shot instead
          // of staying gray forever until app restart.
          handleMapLoadFailure('onDidFailLoadingMap — Mapbox style/tile fetch failed');
        }}
        onMapLoadingError={(e: any) => {
          // BUG-006 v2: also handle the generic load error (different
          // event in some SDK versions). Same auto-recovery path.
          handleMapLoadFailure(`onMapLoadingError — ${String(e?.nativeEvent?.error ?? e?.message ?? e)}`);
        }}
        // BUG-291 v2: onRegionWillChange is deprecated in @rnmapbox/maps v10
        // AND fires with isUserInteraction=true on programmatic camera moves
        // (every GPS update triggers a follow-camera animation that the
        // library mis-tags as a user gesture). That flipped followMode off
        // within a second of accepting a ride, freezing the camera for the
        // rest of the trip. onTouchStart is the same pattern the client app
        // uses and only fires on real finger contact.
        onTouchStart={followMode ? () => onUserInteraction?.() : undefined}
        // POI viewport sync (PR 2 of POI parity program): onMapIdle is the
        // primary trigger; onCameraChanged is chatty but the hook debounces
        // and skips if still in the previous bbox.
        onMapIdle={handlePoiCameraChanged}
        onCameraChanged={handlePoiCameraChanged}
      >
        <MapboxGL.Camera
          ref={cameraRef}
          defaultSettings={{ centerCoordinate: defaultCenter, zoomLevel: 14 }}
          // lockZoom (active trip) prevents zoom-out below level 14 so the
          // driver never loses position context, even after panning. This
          // is independent of followMode — locking applies even when the
          // user is gesturing within the allowed range. Idle home leaves
          // zoom unrestricted.
          {...(lockZoom ? { minZoomLevel: 14 } : {})}
          {...(tripCameraProfile
            ? tripCameraProfile
            : !driverLocation && bounds
              ? {
                  // Initial fit while driverLocation is loading. Once we have
                  // a driverLocation, we never go back to bounds — that was
                  // the cause of the zoom-out oscillation: each Lockito coord
                  // update triggered Mapbox to re-evaluate the camera with
                  // bounds whenever followMode flipped to false transiently,
                  // forcing a 16.5 → 12.8 zoom each time.
                  bounds: {
                    ne: bounds.ne,
                    sw: bounds.sw,
                    paddingTop: 80,
                    paddingRight: 60,
                    paddingBottom: 360,
                    paddingLeft: 60,
                  },
                  animationDuration: 600,
                }
              : {} // followMode=false WITH driverLocation: leave camera where the user left it
          )}
        />
        {routeGeoJSON && (
          <MapboxGL.ShapeSource id="route" shape={routeGeoJSON}>
            <MapboxGL.LineLayer
              id="routeShadow"
              style={{ lineColor: ROUTE.shadow.color, lineWidth: ROUTE.shadow.width, lineOpacity: ROUTE.shadow.opacity, lineBlur: ROUTE.shadow.blur, lineCap: 'round', lineJoin: 'round' }}
            />
            <MapboxGL.LineLayer
              id="routeLine"
              style={{ lineColor: ROUTE.main.color, lineWidth: ROUTE.main.width, lineOpacity: ROUTE.main.opacity, lineCap: 'round', lineJoin: 'round' }}
            />
          </MapboxGL.ShapeSource>
        )}
        {dropoffLocation && (
          // BUG-218: MarkerView (not PointAnnotation) so coordinate updates
          // are picked up. Anchor at bottom-center so the pin tip lands on
          // the GPS point.
          // BUG-281: branded TriciGo pin (transparent silhouette tinted to
          // brand orange) replaces the previous red circle + tail combo.
          <MapboxGL.MarkerView id="dropoff" coordinate={toCoord(dropoffLocation)} anchor={{ x: 0.5, y: 1 }}>
            {/* BUG-285 — wrapper needs explicit width/height so MarkerView
                doesn't lay it out as 0×0 (which made the dropoff pin
                disappear during the trip even though the route polyline
                rendered correctly). */}
            <View
              style={{
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
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
            </View>
          </MapboxGL.MarkerView>
        )}
        {riderLocation && (
          <MapboxGL.PointAnnotation id="rider" coordinate={toCoord(riderLocation)}>
            <View style={styles.riderMarker} accessibilityLabel="Rider location" />
          </MapboxGL.PointAnnotation>
        )}
        {/* POI categorical badges (PR 2 of POI parity program). Display-only
            on the driver app — no `onPoiPress` so taps don't distract the
            driver during a trip. Mounted BEFORE the driver/pickup/dropoff
            markers so POIs sit underneath in z-order. */}
        <PoiMapLayers MapboxGL={MapboxGL} pois={viewportPois} />

        {/* Hoisted vehicle icons — needed by BOTH the driver SymbolLayer below
            AND the peers SymbolLayer further down. Mounting once at the map
            root ensures the icon is available as soon as the driver marker
            renders (peers GeoJSON may be empty at the moment of first
            render). */}
        <MapboxGL.Images
          images={{
            'marker-triciclo': vehicleMarkerImages.triciclo,
            'marker-moto': vehicleMarkerImages.moto,
            'marker-auto': vehicleMarkerImages.auto,
            'marker-confort': vehicleMarkerImages.confort,
            'marker-mensajeria': vehicleMarkerImages.mensajeria,
          }}
        />

        {driverLocation && renderedDriverCoord && (
          // BUG-marker-position-lag (2026-05-24): switched from MarkerView
          // (which forced re-mount on coord change → 1s teleports) to
          // ShapeSource + SymbolLayer + CircleLayer. The Mapbox-native
          // source updates without re-mount, and useAnimatedCoordinate
          // interpolates the coord at ~30 FPS so the marker slides
          // continuously between GPS samples — Uber/Bolt style.
          //
          // BUG-293 preserved: `effectiveDriverCoord` / `effectiveDriverHeading`
          // still prefer the route-polyline snap when available, so the marker
          // stays on-road and aligned with the visible street geometry.
          <>
            {/* Outer pulse ring (drawn first, sits below) */}
            <MapboxGL.ShapeSource
              id="driver-pulse-outer-src"
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
                id="driver-pulse-outer-circle"
                style={{
                  circleRadius: outerPulseRadiusPx,
                  circleColor: MAP_COLORS.driver,
                  circleOpacity: 0.18 * outerPulseOpacityVal,
                  circlePitchAlignment: 'map',
                }}
              />
            </MapboxGL.ShapeSource>

            {/* Inner pulse ring */}
            <MapboxGL.ShapeSource
              id="driver-pulse-inner-src"
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
                id="driver-pulse-inner-circle"
                style={{
                  circleRadius: innerPulseRadiusPx,
                  circleColor: MAP_COLORS.driver,
                  circleOpacity: 0.25,
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
                      : (effectiveDriverHeading + vehicleMarkerRotationOffset(vehicleType)) % 360,
                },
              }}
            >
              <MapboxGL.SymbolLayer
                id="driver-marker-icon"
                style={{
                  iconImage: ['get', 'icon'],
                  // 0.85 = comparable to MARKER.driver.size = 45 (PR #185 1.5×
                  // sizing). Tune on-device against nearby vehicles (iconSize
                  // 0.55) — active driver should pop slightly larger.
                  iconSize: 0.85,
                  iconAllowOverlap: true,
                  iconAnchor: 'center',
                  iconRotate: ['get', 'heading'],
                  // BUG-marker-bearing-doubling (2026-05-24): without these,
                  // the icon rotates in VIEWPORT space (Mapbox default for
                  // SymbolLayer). When the camera bearing also follows the
                  // driver heading (Uber 3D mode below), both rotations
                  // compound visually → the nose ends up offset by ~heading°
                  // from the actual direction of travel. Anchoring to 'map'
                  // makes iconRotate represent the compass bearing so the
                  // visual rotation cancels camera rotation correctly.
                  // The nearby vehicles SymbolLayer below already does this.
                  iconRotationAlignment: 'map',
                  // Pitch-align to map so the icon lays flat on the road
                  // surface in 3D pitch=45 mode (Waze / Google Maps style).
                  iconPitchAlignment: 'map',
                }}
              />
            </MapboxGL.ShapeSource>
          </>
        )}
        {/* BUG-218: pickup marker rendered AFTER driver so when both
            overlap (driver at pickup), the green pickup stays visible on
            top instead of being hidden under the auto/triciclo icon.
            MarkerView z-order on Android follows JSX order. */}
        {pickupLocation && (
          <MapboxGL.MarkerView id="pickup" coordinate={toCoord(pickupLocation)} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={{ width: MARKER.pickup.size, height: MARKER.pickup.size, alignItems: 'center', justifyContent: 'center' }}>
              <Animated.View
                style={{
                  position: 'absolute',
                  width: MARKER.pickup.size, height: MARKER.pickup.size,
                  borderRadius: MARKER.pickup.size / 2,
                  backgroundColor: MAP_COLORS.pickup,
                  transform: [{ scale: pickupPulseAnim }],
                  opacity: pickupPulseOpacity,
                }}
              />
              <View style={styles.pickupMarker}>
                <View style={styles.pickupInnerDot} />
              </View>
            </View>
          </MapboxGL.MarkerView>
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
        {/* Peer drivers — top-down vehicle icons rendered via SymbolLayer */}
        {peersGeoJSON && (
          <>
            <MapboxGL.ShapeSource id="peers" shape={peersGeoJSON}>
              <MapboxGL.SymbolLayer
                id="peers-layer"
                style={{
                  iconImage: ['get', 'icon'],
                  iconSize: 0.45,
                  // Cargo box marker (mensajería) stays at 0° — no inherent
                  // front. Everything else uses the raw heading. The triciclo
                  // PNG is NORTH-convention since BUG-295 (PR #186), so it
                  // doesn't need a per-vehicle compensation here.
                  iconRotate: [
                    'case',
                    ['==', ['get', 'icon'], 'marker-mensajeria'], 0,
                    ['get', 'heading'],
                  ],
                  iconAllowOverlap: true,
                  iconRotationAlignment: 'map',
                  iconPitchAlignment: 'map',
                }}
              />
            </MapboxGL.ShapeSource>
          </>
        )}
        {/* Demand hotspots — top 8 pulse markers */}
        {demandHotspots?.map((h) => (
          <MapboxGL.PointAnnotation
            key={`hotspot-${h.id}`}
            id={`hotspot-${h.id}`}
            coordinate={[h.lng, h.lat]}
          >
            <HotspotPulseMarker
              intensity={h.intensity}
              label={h.live_rides_count > 0 ? String(h.live_rides_count) : undefined}
            />
          </MapboxGL.PointAnnotation>
        ))}
        {/* Popular pickup/dropoff clusters — N5. Static pins, only
            rendered when the home screen toggles them on. Different
            visual contract from demand hotspots: these are stable
            historical clusters, not live signals. */}
        {popularLocations?.map((loc) => (
          <MapboxGL.PointAnnotation
            key={`popular-${loc.id}`}
            id={`popular-${loc.id}`}
            coordinate={[loc.longitude, loc.latitude]}
          >
            <PopularLocationPin type={loc.type} count={loc.ride_count} />
          </MapboxGL.PointAnnotation>
        ))}
      </MapboxGL.MapView>
      {/* PR E (2026-05-12) — first-install overlay until the Mapbox style
          streams in. Without this, navigation-night-v1 paints a solid
          near-black rectangle and the user sees a pure-black map on
          their very first cold start after installing the dev-client
          APK. Once `onDidFinishLoadingStyle` fires we drop the overlay
          and the real tiles take over. Subsequent launches hit the
          style cache, so styleLoaded flips true within ms and the
          overlay is effectively invisible. */}
      {!styleLoaded && <MapFallbackGrid absolute />}
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
            backgroundColor: MAP_COLORS.driverSelf,
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
    width: MARKER.pickup.size, height: MARKER.pickup.size, borderRadius: MARKER.pickup.size / 2,
    backgroundColor: MAP_COLORS.pickup, borderWidth: 3, borderColor: 'white',
    shadowColor: MAP_COLORS.pickup, shadowOpacity: 0.35, shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 }, elevation: 6,
    alignItems: 'center', justifyContent: 'center',
  },
  pickupInnerDot: {
    width: MARKER.pickup.innerDot, height: MARKER.pickup.innerDot,
    borderRadius: MARKER.pickup.innerDot / 2, backgroundColor: 'white',
  },
  dropoffMarker: {
    width: MARKER.dropoff.size, height: MARKER.dropoff.size, borderRadius: MARKER.dropoff.size / 2,
    backgroundColor: MAP_COLORS.dropoff, borderWidth: 3, borderColor: 'white',
    shadowColor: MAP_COLORS.dropoff, shadowOpacity: 0.35, shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 }, elevation: 6,
    alignItems: 'center', justifyContent: 'center',
  },
  dropoffInnerDot: {
    width: MARKER.dropoff.innerDot, height: MARKER.dropoff.innerDot,
    borderRadius: MARKER.dropoff.innerDot / 2, backgroundColor: 'white',
  },
  dropoffTail: {
    width: 0, height: 0,
    borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 8,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderTopColor: MAP_COLORS.dropoff, marginTop: -1,
  },
  riderMarker: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: MAP_COLORS.driver, borderWidth: 3, borderColor: 'white',
    shadowColor: MAP_COLORS.driver, shadowOpacity: 0.35, shadowRadius: 8, elevation: 6,
  },
  driverMarkerContainer: {
    width: 64, height: 64, alignItems: 'center', justifyContent: 'center',
  },
  driverRing: {
    position: 'absolute', width: 60, height: 60, borderRadius: 30,
    backgroundColor: 'rgba(255,77,0,0.15)',
  },
  driverDot: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: MAP_COLORS.driverSelf, borderWidth: 3, borderColor: 'white',
    shadowColor: MAP_COLORS.driverSelf, shadowOpacity: 0.6, shadowRadius: 8, elevation: 6,
  },
  vehicleIconContainer: {
    // BUG-218: transparent — show only the vehicle icon (no white circle, no
    // orange border). A drop shadow keeps the icon legible on light streets.
    width: MARKER.driver.size, height: MARKER.driver.size,
    backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center',
  },
  vehicleIcon: {
    width: MARKER.driver.size, height: MARKER.driver.size,
    // Native shadow so the icon contrasts against any tile color
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 }, elevation: 6,
  },
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
    fontFamily: 'Inter', fontSize: 48, fontWeight: '800',
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
