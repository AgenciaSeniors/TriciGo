import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { Platform, View, useColorScheme } from 'react-native';
import { logger } from '@tricigo/utils';
import { darkColors } from '@tricigo/theme';

// Only import mapbox-gl on web
let mapboxgl: typeof import('mapbox-gl') | null = null;
if (Platform.OS === 'web') {
  try {
    mapboxgl = require('mapbox-gl');
  } catch {
    logger.warn('[WebMapView] mapbox-gl not available');
  }
}

// Inject mapbox-gl CSS via CDN link (more reliable than require() with Metro)
function ensureMapboxCSS() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('mapbox-gl-css')) return;
  const link = document.createElement('link');
  link.id = 'mapbox-gl-css';
  link.rel = 'stylesheet';
  link.href = 'https://api.mapbox.com/mapbox-gl-js/v3.20.0/mapbox-gl.css';
  document.head.appendChild(link);
}

interface WebMapViewProps {
  center?: [number, number]; // [lng, lat]
  zoom?: number;
  pickup?: { latitude: number; longitude: number } | null;
  dropoff?: { latitude: number; longitude: number } | null;
  routeCoords?: [number, number][]; // [[lng, lat], ...]
  style?: Record<string, unknown>;
  interactive?: boolean;
  onMapClick?: (lngLat: { lng: number; lat: number }) => void;
  onCenterChanged?: (center: { lng: number; lat: number }) => void;
  showCenterPin?: boolean;
}

const HAVANA_CENTER: [number, number] = [-82.38, 23.13];
const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
const MAP_STYLE = 'mapbox://styles/mapbox/streets-v12';

export interface WebMapViewRef {
  flyTo: (lng: number, lat: number, zoom?: number) => void;
  getCenter: () => { lng: number; lat: number } | null;
}

export const WebMapView = forwardRef<WebMapViewRef, WebMapViewProps>(function WebMapView({
  center = HAVANA_CENTER,
  zoom = 14,
  pickup,
  dropoff,
  routeCoords,
  style: containerStyle,
  interactive = true,
  onMapClick,
  onCenterChanged,
  showCenterPin = false,
}: WebMapViewProps, ref) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const animFrameRef = useRef<number | null>(null);

  // Initialize map
  useEffect(() => {
    if (!mapboxgl || !mapContainerRef.current || !MAPBOX_TOKEN) return;

    // Ensure CSS is loaded before creating map
    ensureMapboxCSS();

    mapboxgl.accessToken = MAPBOX_TOKEN;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center,
      zoom,
      interactive,
      attributionControl: false,
    });

    // Force resize after map loads to fix container dimension issues
    map.on('load', () => {
      map.resize();
    });
    // Also resize after a frame to catch late layout
    requestAnimationFrame(() => {
      if (mapRef.current) mapRef.current.resize();
    });

    mapRef.current = map;

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Expose imperative methods (flyTo, getCenter)
  useImperativeHandle(ref, () => ({
    flyTo: (lng: number, lat: number, zoom = 16) => {
      mapRef.current?.flyTo({ center: [lng, lat], zoom, duration: 1000 });
    },
    getCenter: () => {
      if (!mapRef.current) return null;
      const c = mapRef.current.getCenter();
      return { lng: c.lng, lat: c.lat };
    },
  }));

  // Map click handler
  useEffect(() => {
    if (!mapRef.current || !onMapClick) return;
    const map = mapRef.current;
    const handler = (e: mapboxgl.MapMouseEvent) => {
      onMapClick({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    };
    map.on('click', handler);
    return () => { map.off('click', handler); };
  }, [onMapClick]);

  // Map center changed handler (on moveend)
  useEffect(() => {
    if (!mapRef.current || !onCenterChanged) return;
    const map = mapRef.current;
    const handler = () => {
      const c = map.getCenter();
      onCenterChanged({ lng: c.lng, lat: c.lat });
    };
    map.on('moveend', handler);
    return () => { map.off('moveend', handler); };
  }, [onCenterChanged]);

  // Update markers
  useEffect(() => {
    if (!mapboxgl || !mapRef.current) return;
    const map = mapRef.current;

    // Remove old markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    // Pickup marker (orange)
    if (pickup) {
      const el = document.createElement('div');
      el.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#FF6B00;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4);';
      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([pickup.longitude, pickup.latitude])
        .addTo(map);
      markersRef.current.push(marker);
    }

    // Dropoff marker (green)
    if (dropoff) {
      const el = document.createElement('div');
      el.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#22c55e;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4);';
      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([dropoff.longitude, dropoff.latitude])
        .addTo(map);
      markersRef.current.push(marker);
    }

    // Fit bounds if both markers
    if (pickup && dropoff) {
      const bounds = new mapboxgl.LngLatBounds()
        .extend([pickup.longitude, pickup.latitude])
        .extend([dropoff.longitude, dropoff.latitude]);
      map.fitBounds(bounds, { padding: 60, duration: 500 });
    }
  }, [pickup, dropoff]);

  // Update route line
  useEffect(() => {
    if (!mapRef.current || !routeCoords?.length) return;
    const map = mapRef.current;

    function addRoute() {
      // Remove existing route safely
      try {
        if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
        if (map.getLayer('route-line-animated')) map.removeLayer('route-line-animated');
        if (map.getLayer('route-line')) map.removeLayer('route-line');
        if (map.getSource('route')) map.removeSource('route');
      } catch { /* ignore removal errors */ }

      // routeCoords are [lat, lng] from fetchRoute — convert to [lng, lat] for Mapbox GL
      const coords = routeCoords!.map(([lat, lng]) => [lng, lat] as [number, number]);

      map.addSource('route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: coords,
          },
        },
      });

      // Base route line (thicker, semi-transparent)
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#FF6B00',
          'line-width': 6,
          'line-opacity': 0.3,
        },
      });

      // Animated route overlay (dashed, animated)
      map.addLayer({
        id: 'route-line-animated',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#FF6B00',
          'line-width': 4,
          'line-opacity': 0.9,
          'line-dasharray': [0, 4, 3],
        },
      });

      // Animate the dash offset
      let dashStep = 0;
      const dashArraySeq = [
        [0, 4, 3],
        [0.5, 4, 2.5],
        [1, 4, 2],
        [1.5, 4, 1.5],
        [2, 4, 1],
        [2.5, 4, 0.5],
        [3, 4, 0],
        [0, 0.5, 3, 3.5],
        [0, 1, 3, 3],
        [0, 1.5, 3, 2.5],
        [0, 2, 3, 2],
        [0, 2.5, 3, 1.5],
        [0, 3, 3, 1],
        [0, 3.5, 3, 0.5],
      ];

      function animateDash() {
        if (!map.getLayer('route-line-animated')) return;
        dashStep = (dashStep + 1) % dashArraySeq.length;
        map.setPaintProperty('route-line-animated', 'line-dasharray', dashArraySeq[dashStep]);
        animFrameRef.current = requestAnimationFrame(animateDash);
      }
      animFrameRef.current = requestAnimationFrame(animateDash);
    }

    if (map.isStyleLoaded()) {
      addRoute();
    } else {
      map.on('load', addRoute);
    }

    return () => {
      map.off('load', addRoute);
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [routeCoords]);

  if (Platform.OS !== 'web' || !mapboxgl) {
    return <View style={[{ flex: 1, backgroundColor: isDark ? darkColors.background.secondary : '#e5e5e5' }, containerStyle as any]} />;
  }

  return (
    <View style={[{ flex: 1, position: 'relative' }, containerStyle as any]}>
      <div
        ref={mapContainerRef}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      {showCenterPin && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -100%)',
            pointerEvents: 'none',
            zIndex: 10,
          }}
        >
          <div
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: '#FF6B00',
              border: '3px solid white',
              boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            }}
          />
          <div
            style={{
              width: 2,
              height: 12,
              background: '#FF6B00',
              margin: '0 auto',
              borderRadius: 1,
            }}
          />
        </div>
      )}
    </View>
  );
});
