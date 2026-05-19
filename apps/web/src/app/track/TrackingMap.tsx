'use client';

import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import {
  fetchRoute,
  fetchMultiStopRoute,
  distanceToPolyline,
  haversineDistance,
  MAP_STYLE_LIGHT,
  MAP_COLORS,
  MARKER,
  ROUTE,
} from '@tricigo/utils';

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
  /** Intermediate stops in visit order (pickup → waypoints → dropoff). */
  waypoints?: Array<{ latitude: number; longitude: number; sort_order?: number }>;
  /**
   * BUG-279-web: ride status. When 'in_progress' or 'arrived_at_destination'
   * the polyline is fetched LIVE from the driver's current position to the
   * dropoff (refetched when the driver deviates >50 m from the previous
   * polyline). Without this prop, the route stays glued to the original
   * pickup→dropoff path even if the driver takes a different street.
   */
  rideStatus?: string | null;
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
  // BUG-281 — branded TriciGo dropoff pin.
  // Loads /markers/dropoff-pin.png (white silhouette on transparent bg),
  // recolors to brand orange via CSS filter, adds a drop-shadow for depth.
  // The asset is already a location-pin shape so it sits naturally at the
  // GPS coordinate when the Mapbox marker is anchored 'bottom'.
  const el = document.createElement('div');
  el.innerHTML = `
    <div style="width:44px;height:44px;animation:drop-in 0.4s ease-out both;">
      <img
        src="/markers/dropoff-pin.png"
        alt="Destino"
        style="display:block;width:44px;height:44px;object-fit:contain;
          /* Tint the white silhouette to brand orange (#FF4D00).
             Generated via https://codepen.io/sosuke/pen/Pjoqqp */
          filter: brightness(0) saturate(100%) invert(46%) sepia(89%) saturate(2613%) hue-rotate(2deg) brightness(102%) contrast(105%) drop-shadow(0 2px 4px rgba(0,0,0,0.3));"
      />
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
  waypoints,
  rideStatus,
  className,
  style: styleProp,
}: TrackingMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const pickupMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const dropoffMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const driverMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const vehicleMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const waypointMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const [mapReady, setMapReady] = useState(false);

  // BUG-279-web: cache the current polyline so the live-route effect can
  // measure how far the driver has deviated from it.
  const currentRouteRef = useRef<Array<{ latitude: number; longitude: number }> | null>(null);
  const lastLiveFetchAtRef = useRef(0);
  const liveFetchInFlightRef = useRef(false);

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

  /* ── Driver marker — smooth glide between poll samples ──
     The share page polls the driver position every ~3 s. Teleporting
     the marker each poll looks jerky; instead we lerp position +
     heading over ANIM_MS so the car glides (Uber feel). Linear easing
     on purpose: a vehicle between two GPS fixes travels at ~constant
     speed — ease-out would fake a brake every 3 s. Each new sample
     restarts the glide from the marker's current mid-glide position,
     so movement chains seamlessly. */
  const driverAnimRef = useRef<number | null>(null);
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;

    if (driverLat == null || driverLng == null) {
      if (driverMarkerRef.current) { driverMarkerRef.current.remove(); driverMarkerRef.current = null; }
      return;
    }

    const targetLng = driverLng;
    const targetLat = driverLat;
    const targetRot = driverHeading ?? 0;

    // First sample — place the marker instantly, nothing to glide from.
    if (!driverMarkerRef.current) {
      driverMarkerRef.current = new mapboxgl.Marker({
        element: createDriverMarkerEl(vehicleType),
        anchor: 'center',
        rotation: targetRot,
        rotationAlignment: 'map',
      })
        .setLngLat([targetLng, targetLat])
        .addTo(mapRef.current);
      return;
    }

    const marker = driverMarkerRef.current;

    // Respect reduced-motion — snap instead of gliding.
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      marker.setLngLat([targetLng, targetLat]);
      if (driverHeading != null) marker.setRotation(targetRot);
      return;
    }

    const start = marker.getLngLat();
    const fromLng = start.lng;
    const fromLat = start.lat;
    const fromRot = marker.getRotation();
    // Shortest-path rotation delta (handles the 359°→1° wrap).
    let rotDelta = targetRot - fromRot;
    if (rotDelta > 180) rotDelta -= 360;
    if (rotDelta < -180) rotDelta += 360;

    const ANIM_MS = 2500;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ANIM_MS);
      marker.setLngLat([
        fromLng + (targetLng - fromLng) * t,
        fromLat + (targetLat - fromLat) * t,
      ]);
      if (driverHeading != null) marker.setRotation(fromRot + rotDelta * t);
      driverAnimRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    driverAnimRef.current = requestAnimationFrame(step);

    return () => {
      if (driverAnimRef.current != null) {
        cancelAnimationFrame(driverAnimRef.current);
        driverAnimRef.current = null;
      }
    };
  }, [driverLat, driverLng, driverHeading, mapReady]);

  /* ── Fetch and draw STATIC route (pickup → dropoff, used pre-trip) ── */
  // Stable dep key for waypoints so reference changes don't re-fetch.
  const waypointsKey = waypoints
    ?.map((w) => `${w.latitude},${w.longitude}`)
    .join('|') ?? '';

  // BUG-279-web: only the static route runs in the pre-trip phases. Once
  // the trip starts (in_progress / arrived_at_destination) the LIVE route
  // effect below takes over and the static effect is a no-op.
  const isLivePhase = rideStatus === 'in_progress' || rideStatus === 'arrived_at_destination';

  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    if (isLivePhase) return; // live effect handles the polyline now

    let cancelled = false;

    (async () => {
      const sortedStops = (waypoints ?? [])
        .filter((w) => typeof w.latitude === 'number' && typeof w.longitude === 'number')
        .slice()
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

      let result: { coordinates: [number, number][]; distance_m: number; duration_s: number } | null = null;
      if (sortedStops.length > 0) {
        // Multi-stop: pickup → waypoint[0] → ... → dropoff
        const points = [
          { lat: pickupLat, lng: pickupLng },
          ...sortedStops.map((w) => ({ lat: w.latitude, lng: w.longitude })),
          { lat: dropoffLat, lng: dropoffLng },
        ];
        result = await fetchMultiStopRoute(points);
      } else {
        result = await fetchRoute(
          { lat: pickupLat, lng: pickupLng },
          { lat: dropoffLat, lng: dropoffLng },
        );
      }

      if (cancelled) return;
      const map = mapRef.current;
      if (!map) return;

      const source = map.getSource('route') as mapboxgl.GeoJSONSource | undefined;
      if (!source) return;

      if (result && result.coordinates.length > 1) {
        // coordinates are [lat, lng] — convert to [lng, lat] for Mapbox GL
        const coords = result.coordinates.map(([lat, lng]) => [lng, lat] as [number, number]);
        currentRouteRef.current = result.coordinates.map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
        source.setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: coords },
        });
      } else {
        // Fallback: straight line through pickup → waypoints → dropoff
        const fallback: [number, number][] = [
          [pickupLng, pickupLat],
          ...sortedStops.map((w) => [w.longitude, w.latitude] as [number, number]),
          [dropoffLng, dropoffLat],
        ];
        currentRouteRef.current = null;
        source.setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: fallback },
        });
      }
    })();

    return () => { cancelled = true; };
  }, [pickupLat, pickupLng, dropoffLat, dropoffLng, mapReady, waypointsKey, isLivePhase]);

  /* ── BUG-279-web: LIVE route during in_progress/arrived_at_destination ──
     Refetches OSRM whenever the driver deviates >50 m from the cached
     polyline OR every 5 s minimum. Mirrors the mobile useLiveDriverRoute
     hook. The polyline now follows the driver's real path instead of
     staying glued to the original pickup→dropoff line. */
  useEffect(() => {
    if (!mapRef.current || !mapReady || !isLivePhase) return;
    if (typeof driverLat !== 'number' || typeof driverLng !== 'number') return;
    if (typeof dropoffLat !== 'number' || typeof dropoffLng !== 'number') return;

    // Skip when driver is essentially at the dropoff
    const distToDropoff = haversineDistance(
      { latitude: driverLat, longitude: driverLng },
      { latitude: dropoffLat, longitude: dropoffLng },
    );
    if (distToDropoff < 50) return;

    // In-flight guard
    if (liveFetchInFlightRef.current) return;

    const now = Date.now();
    const sinceLastFetch = now - lastLiveFetchAtRef.current;
    const isFirstLiveFetch = lastLiveFetchAtRef.current === 0;
    const cached = currentRouteRef.current;

    // Decide whether to fetch
    let shouldFetch = false;
    if (isFirstLiveFetch) {
      shouldFetch = true;
    } else if (cached && cached.length >= 2) {
      const offRouteM = distanceToPolyline({ latitude: driverLat, longitude: driverLng }, cached);
      if (offRouteM > 50 && sinceLastFetch >= 5_000) shouldFetch = true;
    } else if (sinceLastFetch >= 5_000) {
      shouldFetch = true;
    }
    if (!shouldFetch) return;

    let cancelled = false;
    liveFetchInFlightRef.current = true;

    (async () => {
      const result = await fetchRoute(
        { lat: driverLat, lng: driverLng },
        { lat: dropoffLat, lng: dropoffLng },
      );

      if (cancelled) {
        liveFetchInFlightRef.current = false;
        return;
      }
      lastLiveFetchAtRef.current = Date.now();
      liveFetchInFlightRef.current = false;

      const map = mapRef.current;
      if (!map) return;
      const source = map.getSource('route') as mapboxgl.GeoJSONSource | undefined;
      if (!source) return;

      if (result && result.coordinates.length > 1) {
        const coords = result.coordinates.map(([lat, lng]) => [lng, lat] as [number, number]);
        currentRouteRef.current = result.coordinates.map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
        source.setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: coords },
        });
      }
    })();

    return () => { cancelled = true; };
  }, [driverLat, driverLng, dropoffLat, dropoffLng, mapReady, isLivePhase]);

  /* ── Waypoint markers (orange rings with number) ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Remove previous
    for (const m of waypointMarkersRef.current) m.remove();
    waypointMarkersRef.current = [];

    const sortedStops = (waypoints ?? [])
      .filter((w) => typeof w.latitude === 'number' && typeof w.longitude === 'number')
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    sortedStops.forEach((w, idx) => {
      const el = document.createElement('div');
      el.innerHTML = `
        <div style="position:relative;width:24px;height:24px;">
          <div style="position:absolute;inset:0;border-radius:50%;background:#FF4D00;opacity:0.25;"></div>
          <div style="position:relative;width:24px;height:24px;border-radius:50%;background:white;border:3px solid #FF4D00;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.25);">
            <span style="font-size:11px;font-weight:700;color:#FF4D00;line-height:1;">${idx + 1}</span>
          </div>
        </div>`;
      const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([w.longitude, w.latitude])
        .addTo(map);
      waypointMarkersRef.current.push(marker);
    });
  }, [waypointsKey, mapReady]);

  /* ── Fit bounds to show all markers ──
     BUG-286-web: previous deps included `driverLat, driverLng`, so every
     driver position update (~1 Hz from the polling) re-ran fitBounds and
     the user saw the camera snap out repeatedly during the ride. The
     mobile equivalent of this bug was BUG-286 — same fix here: only
     fit on first mount (or on a NEW ride identity), driver position
     never triggers a refit. The driver marker still moves in real time
     because of the separate marker effect; the camera just stays where
     the user (or the previous fit) left it. */
  const hasFittedRef = useRef(false);
  const lastFitRideKeyRef = useRef('');
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const rideKey = `${pickupLat},${pickupLng}|${dropoffLat},${dropoffLng}`;
    if (hasFittedRef.current && rideKey === lastFitRideKeyRef.current) return;

    try {
      const bounds = new mapboxgl.LngLatBounds();
      bounds.extend([pickupLng, pickupLat]);
      bounds.extend([dropoffLng, dropoffLat]);
      if (driverLat != null && driverLng != null) {
        bounds.extend([driverLng, driverLat]);
      }
      for (const w of waypoints ?? []) {
        if (typeof w.latitude === 'number' && typeof w.longitude === 'number') {
          bounds.extend([w.longitude, w.latitude]);
        }
      }
      map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 800 });
      hasFittedRef.current = true;
      lastFitRideKeyRef.current = rideKey;
    } catch (err) {
      console.error('[TrackingMap] fitBounds failed:', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickupLat, pickupLng, dropoffLat, dropoffLng, mapReady, waypointsKey]);

  if (!hasValidCoords) {
    return (
      <div style={{
        width: '100%', height: styleProp?.height ?? 300, borderRadius: styleProp?.borderRadius ?? '0.75rem', background: 'var(--bg-light)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)',
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
