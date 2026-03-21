import React, { useEffect, useRef } from 'react';
import { Platform, View } from 'react-native';

// Only import mapbox-gl on web
let mapboxgl: typeof import('mapbox-gl') | null = null;
if (Platform.OS === 'web') {
  try {
    mapboxgl = require('mapbox-gl');
    // Import CSS
    require('mapbox-gl/dist/mapbox-gl.css');
  } catch {
    console.warn('[WebMapView] mapbox-gl not available');
  }
}

interface WebMapViewProps {
  center?: [number, number]; // [lng, lat]
  zoom?: number;
  pickup?: { latitude: number; longitude: number } | null;
  dropoff?: { latitude: number; longitude: number } | null;
  routeCoords?: [number, number][]; // [[lng, lat], ...]
  style?: Record<string, unknown>;
  interactive?: boolean;
}

const HAVANA_CENTER: [number, number] = [-82.38, 23.13];
const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
const MAP_STYLE = 'mapbox://styles/mapbox/dark-v11';

export function WebMapView({
  center = HAVANA_CENTER,
  zoom = 13,
  pickup,
  dropoff,
  routeCoords,
  style: containerStyle,
  interactive = true,
}: WebMapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);

  // Initialize map
  useEffect(() => {
    if (!mapboxgl || !mapContainerRef.current || !MAPBOX_TOKEN) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center,
      zoom,
      interactive,
      attributionControl: false,
    });

    mapRef.current = map;

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

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
      // Remove existing route
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
            coordinates: routeCoords!,
          },
        },
      });

      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#FF6B00',
          'line-width': 4,
          'line-opacity': 0.8,
        },
      });
    }

    if (map.isStyleLoaded()) {
      addRoute();
    } else {
      map.on('load', addRoute);
    }
  }, [routeCoords]);

  if (Platform.OS !== 'web' || !mapboxgl) {
    return <View style={[{ flex: 1, backgroundColor: '#1a1a2e' }, containerStyle as any]} />;
  }

  return (
    <View style={[{ flex: 1 }, containerStyle as any]}>
      <div
        ref={mapContainerRef}
        style={{ width: '100%', height: '100%', borderRadius: 'inherit' }}
      />
    </View>
  );
}
