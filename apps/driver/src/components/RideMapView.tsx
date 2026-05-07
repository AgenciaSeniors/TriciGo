import React, { useState, useMemo, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { View, Text, Animated, Pressable, StyleSheet, Platform, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { MAP_STYLE_LIGHT, MAP_COLORS, MARKER, ROUTE } from '@tricigo/utils';
import type { NearbyVehicle, DemandHotspot, PopularLocation } from '@tricigo/types';
import { HotspotPulseMarker } from './HotspotPulseMarker';
import { PopularLocationPin } from './PopularLocationPin';
import { getMapFallbackCoordLngLat } from '../config/demo';

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

// Demo-aware map fallback: returns São Paulo when EXPO_PUBLIC_DEMO_MODE=true,
// Havana otherwise. Same pattern as apps/client/src/components/RideMapView.tsx.
const HAVANA_CENTER: [number, number] = getMapFallbackCoordLngLat();
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
          // lockZoom (active trip) prevents zoom-out below level 14 so the
          // driver never loses position context, even after panning. This
          // is independent of followMode — locking applies even when the
          // user is gesturing within the allowed range. Idle home leaves
          // zoom unrestricted.
          {...(lockZoom ? { minZoomLevel: 14 } : {})}
          {...(followMode && driverLocation
            ? {
                // Follow path: heading-up navigation mode (Uber driver style)
                centerCoordinate: toCoord(driverLocation),
                zoomLevel: 16.5,
                pitch: 45,
                heading: driverHeading ?? 0,
                animationDuration: 1000,
                animationMode: 'easeTo',
              }
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
        {driverLocation && (
          // BUG-218: use MarkerView (not PointAnnotation) for the driver
          // marker so the <Image> child renders reliably on Android.
          // PointAnnotation snapshots its child once on mount — if the image
          // hasn't loaded yet, the snapshot is empty and the user sees just
          // a dark/white circle without the vehicle icon.
          <MapboxGL.MarkerView id="driver" coordinate={toCoord(driverLocation)} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={styles.driverMarkerContainer}>
              <Animated.View
                style={[styles.driverRing, { transform: [{ scale: ringAnim }], opacity: ringOpacity }]}
              />
              <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                {/* BUG-268: rotation MUST live on a non-Animated View. When
                    Animated.View has a transform array mixing Animated.Value
                    (scale: pulseAnim) with a raw string (rotate: '90deg'),
                    React Native's native driver only updates the animated
                    entries and silently ignores the raw ones — the marker
                    stays at rotate(0deg) forever. Splitting into two nested
                    views isolates the dynamic rotate so it actually applies. */}
                <View
                  style={{
                    transform: [
                      // 0=N, 90=E, 180=S, 270=W. The marker images are drawn
                      // pointing up (north) so a direct deg rotation aligns
                      // the nose with the direction of travel.
                      { rotate: `${(vehicleType && NON_ROTATING_MARKERS.has(vehicleType)) ? 0 : (typeof driverHeading === 'number' && Number.isFinite(driverHeading) ? driverHeading : 0)}deg` },
                    ],
                  }}
                >
                  {vehicleType && vehicleMarkerImages[vehicleType] && !markerImageError ? (
                    <View style={styles.vehicleIconContainer}>
                      <Image
                        source={vehicleMarkerImages[vehicleType]}
                        style={styles.vehicleIcon}
                        resizeMode="contain"
                        accessibilityLabel={`${vehicleType} vehicle marker`}
                        onError={(e) => {
                          console.warn('[VehicleMarker] image failed', vehicleType, e?.nativeEvent);
                          setMarkerImageError(true);
                        }}
                        onLoad={() => console.log('[VehicleMarker] image loaded', vehicleType)}
                      />
                    </View>
                  ) : (
                    <View style={styles.driverDot} />
                  )}
                </View>
              </Animated.View>
            </View>
          </MapboxGL.MarkerView>
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
            <MapboxGL.Images
              images={{
                'marker-triciclo': vehicleMarkerImages.triciclo,
                'marker-moto': vehicleMarkerImages.moto,
                'marker-auto': vehicleMarkerImages.auto,
                'marker-confort': vehicleMarkerImages.confort,
                'marker-mensajeria': vehicleMarkerImages.mensajeria,
              }}
            />
            <MapboxGL.ShapeSource id="peers" shape={peersGeoJSON}>
              <MapboxGL.SymbolLayer
                id="peers-layer"
                style={{
                  iconImage: ['get', 'icon'],
                  iconSize: 0.45,
                  // Cargo box marker (mensajería) stays at 0deg — no inherent front.
                  iconRotate: ['case', ['==', ['get', 'icon'], 'marker-mensajeria'], 0, ['get', 'heading']],
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
