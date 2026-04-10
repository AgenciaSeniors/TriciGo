'use client';

import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { fetchRoute, MAP_STYLE_LIGHT, MAP_COLORS, MARKER, ROUTE } from '@tricigo/utils';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

export interface TrackingMapProps {
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  driverLat?: number;
  driverLng?: number;
  driverHeading?: number;
  vehicleType?: string;
  nearbyVehicles?: Array<{ latitude: number; longitude: number; heading?: number | null; vehicle_type?: string }>;
  className?: string;
  style?: React.CSSProperties;
}

/* ── Marker HTML builders ── */

function createPickupMarkerEl(): HTMLDivElement {
  const el = document.createElement('div');
  const s = MARKER.pickup.size;
  const d = MARKER.pickup.innerDot;
  el.innerHTML = `
    <div style="position:relative;width:${s}px;height:${s}px;">
      <div style="position:absolute;inset:0;border-radius:50%;background:${MAP_COLORS.pickup};opacity:0.3;animation:pulse-green 2s ease-out infinite;"></div>
      <div style="position:relative;width:${s}px;height:${s}px;border-radius:50%;background:${MAP_COLORS.pickup};border:3px solid white;box-shadow:${MARKER.pickup.shadow};display:flex;align-items:center;justify-content:center;">
        <div style="width:${d}px;height:${d}px;border-radius:50%;background:white;"></div>
      </div>
    </div>`;
  return el;
}

function createDropoffMarkerEl(): HTMLDivElement {
  const el = document.createElement('div');
  const s = MARKER.dropoff.size;
  const d = MARKER.dropoff.innerDot;
  const t = MARKER.dropoff.tailH;
  el.innerHTML = `
    <div style="position:relative;width:${s}px;height:${s + t}px;animation:drop-in 0.4s ease-out both;">
      <div style="width:${s}px;height:${s}px;border-radius:50%;background:${MAP_COLORS.dropoff};border:3px solid white;box-shadow:${MARKER.dropoff.shadow};position:relative;z-index:1;display:flex;align-items:center;justify-content:center;">
        <div style="width:${d}px;height:${d}px;border-radius:50%;background:white;"></div>
      </div>
      <div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-top:${t}px solid ${MAP_COLORS.dropoff};"></div>
    </div>`;
  return el;
}

function createDriverMarkerEl(vehicleType?: string): HTMLDivElement {
  const el = document.createElement('div');
  const s = MARKER.driver.size;
  const r = MARKER.driver.ringSize;
  const vehicleImg = vehicleType
    ? `<img src="/images/vehicles/markers/${vehicleType}@2x.png" style="width:28px;height:28px;object-fit:contain;" alt="" />`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L19 21L12 17L5 21L12 2Z"/></svg>`;
  el.innerHTML = `
    <div style="position:relative;width:${r}px;height:${r}px;display:flex;align-items:center;justify-content:center;">
      <div style="position:absolute;inset:0;border-radius:50%;background:${MAP_COLORS.driver};opacity:0.15;animation:pulse-driver 2s ease-out infinite;"></div>
      <div style="width:${s}px;height:${s}px;border-radius:50%;background:${MAP_COLORS.driverContainer};border:2px solid ${MAP_COLORS.driver};box-shadow:${MARKER.driver.shadow};display:flex;align-items:center;justify-content:center;overflow:hidden;">
        ${vehicleImg}
      </div>
    </div>`;
  return el;
}

const PULSE_STYLES = `
  @keyframes pulse-green {
    0% { transform: scale(1); opacity: 0.6; }
    70% { transform: scale(2.5); opacity: 0; }
    100% { transform: scale(1); opacity: 0; }
  }
  @keyframes pulse-driver {
    0% { transform: scale(1); opacity: 0.5; }
    70% { transform: scale(2); opacity: 0; }
    100% { transform: scale(1); opacity: 0; }
  }
  @keyframes drop-in {
    0% { transform: scale(0.3); opacity: 0; }
    60% { transform: scale(1.05); }
    100% { transform: scale(1); opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    @keyframes pulse-green { 0%, 100% { transform: scale(1); opacity: 0.3; } }
    @keyframes pulse-driver { 0%, 100% { transform: scale(1); opacity: 0.15; } }
    @keyframes drop-in { 0%, 100% { transform: scale(1); opacity: 1; } }
  }
`;

export default function TrackingMap({
  pickupLat,
  pickupLng,
  dropoffLat,
  dropoffLng,
  driverLat,
  driverLng,
  driverHeading,
  vehicleType,
  nearbyVehicles,
  className,
  style: styleProp,
}: TrackingMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const pickupMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const dropoffMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const driverMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const vehicleMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const [mapReady, setMapReady] = useState(false);

  // Validate coordinates to prevent Mapbox NaN crash
  // Must be real numbers, not NaN, not 0, and within plausible lat/lng ranges
  const isValidCoord = (v: number) => typeof v === 'number' && isFinite(v) && v !== 0;
  const hasValidCoords = isValidCoord(pickupLat) && isValidCoord(pickupLng) &&
    isValidCoord(dropoffLat) && isValidCoord(dropoffLng);

  /* ── Initialize map ── */
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current || !hasValidCoords) return;

    // Ensure container has dimensions before initializing Mapbox
    const container = mapContainerRef.current;
    const { clientWidth, clientHeight } = container;
    if (clientWidth === 0 || clientHeight === 0) return;

    let map: mapboxgl.Map;
    try {
      map = new mapboxgl.Map({
        container,
        style: MAP_STYLE_LIGHT,
        center: [pickupLng, pickupLat],
        zoom: 13,
        attributionControl: false,
      });
    } catch (err) {
      console.error('[TrackingMap] Mapbox init failed:', err);
      return;
    }

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      setMapReady(true);

      // Add route source (empty initially)
      map.addSource('route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Route shadow
      map.addLayer({
        id: 'route-shadow',
        type: 'line',
        source: 'route',
        paint: {
          'line-color': ROUTE.shadow.color,
          'line-width': ROUTE.shadow.width,
          'line-opacity': ROUTE.shadow.opacity,
          'line-blur': ROUTE.shadow.blur,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });

      // Route line — blue premium
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: {
          'line-color': ROUTE.main.color,
          'line-width': ROUTE.main.width,
          'line-opacity': ROUTE.main.opacity,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    });

    map.on('error', (e) => {
      console.error('[TrackingMap] Mapbox runtime error:', e.error?.message ?? e);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasValidCoords]);

  /* ── Pickup marker ── */
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    if (pickupMarkerRef.current) { pickupMarkerRef.current.remove(); pickupMarkerRef.current = null; }

    pickupMarkerRef.current = new mapboxgl.Marker({ element: createPickupMarkerEl(), anchor: 'center' })
      .setLngLat([pickupLng, pickupLat])
      .addTo(mapRef.current);
  }, [pickupLat, pickupLng, mapReady]);

  /* ── Dropoff marker ── */
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    if (dropoffMarkerRef.current) { dropoffMarkerRef.current.remove(); dropoffMarkerRef.current = null; }

    dropoffMarkerRef.current = new mapboxgl.Marker({ element: createDropoffMarkerEl(), anchor: 'bottom' })
      .setLngLat([dropoffLng, dropoffLat])
      .addTo(mapRef.current);
  }, [dropoffLat, dropoffLng, mapReady]);

  /* ── Driver marker (update position without re-creating) ── */
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;

    if (driverLat == null || driverLng == null) {
      if (driverMarkerRef.current) { driverMarkerRef.current.remove(); driverMarkerRef.current = null; }
      return;
    }

    if (driverMarkerRef.current) {
      // Just update position — no full re-render
      driverMarkerRef.current.setLngLat([driverLng, driverLat]);
      // Update rotation if heading provided
      if (driverHeading != null) {
        driverMarkerRef.current.setRotation(driverHeading);
      }
    } else {
      driverMarkerRef.current = new mapboxgl.Marker({
        element: createDriverMarkerEl(vehicleType),
        anchor: 'center',
        rotation: driverHeading ?? 0,
        rotationAlignment: 'map',
      })
        .setLngLat([driverLng, driverLat])
        .addTo(mapRef.current);
    }
  }, [driverLat, driverLng, driverHeading, mapReady]);

  /* ── Fetch and draw route ── */
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;

    let cancelled = false;

    (async () => {
      const result = await fetchRoute(
        { lat: pickupLat, lng: pickupLng },
        { lat: dropoffLat, lng: dropoffLng },
      );

      if (cancelled) return;
      const map = mapRef.current;
      if (!map) return;

      const source = map.getSource('route') as mapboxgl.GeoJSONSource | undefined;
      if (!source) return;

      if (result && result.coordinates.length > 1) {
        // coordinates are [lat, lng] from OSRM/Mapbox — convert to [lng, lat] for Mapbox GL
        const coords = result.coordinates.map(([lat, lng]) => [lng, lat] as [number, number]);
        source.setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: coords },
        });
      } else {
        // Fallback straight line
        source.setData({
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [pickupLng, pickupLat],
              [dropoffLng, dropoffLat],
            ],
          },
        });
      }
    })();

    return () => { cancelled = true; };
  }, [pickupLat, pickupLng, dropoffLat, dropoffLng, mapReady]);

  /* ── Fit bounds to show all markers ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    try {
      const bounds = new mapboxgl.LngLatBounds();
      bounds.extend([pickupLng, pickupLat]);
      bounds.extend([dropoffLng, dropoffLat]);
      if (driverLat != null && driverLng != null) {
        bounds.extend([driverLng, driverLat]);
      }
      map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 800 });
    } catch (err) {
      console.error('[TrackingMap] fitBounds failed:', err);
    }
  }, [pickupLat, pickupLng, dropoffLat, dropoffLng, driverLat, driverLng, mapReady]);

  if (!hasValidCoords) {
    return (
      <div style={{
        width: '100%', height: styleProp?.height ?? 300, borderRadius: styleProp?.borderRadius ?? '0.75rem', background: '#f0f0f0',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888',
        ...styleProp,
      }}>
        Cargando mapa...
      </div>
    );
  }

  // ── Nearby vehicle markers (green dots during search) ──
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    vehicleMarkersRef.current.forEach(m => m.remove());
    vehicleMarkersRef.current = [];

    if (!nearbyVehicles?.length) return;

    nearbyVehicles.forEach(v => {
      const el = document.createElement('div');
      el.style.cssText = 'width:12px;height:12px;background:#00C853;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.3);';
      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([v.longitude, v.latitude])
        .addTo(mapRef.current!);
      vehicleMarkersRef.current.push(marker);
    });
  }, [nearbyVehicles, mapReady]);

  return (
    <>
      <style>{PULSE_STYLES}</style>
      <div
        ref={mapContainerRef}
        style={{
          width: '100%',
          height: styleProp?.height ?? '100%',
          minHeight: 250,
          borderRadius: styleProp?.borderRadius ?? 0,
          overflow: 'hidden',
          ...styleProp,
        }}
        className={className ?? 'tracking-map-container'}
      />
    </>
  );
}
