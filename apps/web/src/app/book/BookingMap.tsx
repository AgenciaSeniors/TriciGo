'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useTranslation } from '@tricigo/i18n';
import { HAVANA_CENTER, CUBA_CENTER, CUBA_DEFAULT_ZOOM, HAVANA_PRESETS, findNearestPreset, reverseGeocode, fetchPoisInViewport } from '@tricigo/utils';
import type { LocationPreset, ViewportPoi } from '@tricigo/utils';
import type { NearbyVehicle, ServiceTypeSlug } from '@tricigo/types';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

type SelectionStep = 'pickup' | 'dropoff' | 'done';

export interface BookingMapProps {
  pickup: LocationPreset | null;
  dropoff: LocationPreset | null;
  userLocation: { latitude: number; longitude: number } | null;
  onSetPickup: (loc: LocationPreset) => void;
  onSetDropoff: (loc: LocationPreset) => void;
  onRequestLocation: () => void;
  onConfirmLocation: (loc: LocationPreset) => void;
  locationLoading: boolean;
  locationError: string | null;
  selectionStep: SelectionStep;
  pickupAddress: string | null;
  dropoffAddress: string | null;
  centerAddress: string | null;
  centerAddressLoading: boolean;
  flyToTarget: { latitude: number; longitude: number } | null;
  routeCoords: [number, number][] | null;
  routeLoading: boolean;
  nearbyVehicles?: NearbyVehicle[];
  selectedServiceType?: ServiceTypeSlug;
  initialCenter?: { latitude: number; longitude: number };
  onMapCenterChange?: (center: { latitude: number; longitude: number }) => void;
}

/* ── Marker HTML builders ── */

function createPickupMarkerEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = `
    <div style="position:relative;width:28px;height:28px;">
      <div style="
        position:absolute;inset:0;border-radius:50%;
        background:rgba(34,197,94,0.3);
        animation:pulse-green 2s ease-out infinite;
      "></div>
      <div style="
        position:relative;width:28px;height:28px;border-radius:50%;
        background:#22c55e;border:3px solid white;
        box-shadow:0 2px 8px rgba(0,0,0,0.4);
        display:flex;align-items:center;justify-content:center;
      "><div style="width:8px;height:8px;border-radius:50%;background:white;"></div></div>
    </div>`;
  return el;
}

function createDropoffMarkerEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = `
    <div style="position:relative;width:28px;height:40px;">
      <div style="
        width:28px;height:28px;border-radius:50%;
        background:#FF4D00;border:3px solid white;
        box-shadow:0 3px 10px rgba(255,77,0,0.4);
        position:relative;z-index:1;
      "></div>
      <div style="
        position:absolute;bottom:0;left:50%;transform:translateX(-50%);
        width:0;height:0;
        border-left:8px solid transparent;border-right:8px solid transparent;
        border-top:12px solid #FF4D00;
      "></div>
    </div>`;
  return el;
}

function createUserLocationEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = `
    <div style="position:relative;width:20px;height:20px;">
      <div style="
        position:absolute;inset:-6px;border-radius:50%;
        background:rgba(59,130,246,0.2);
        animation:pulse-blue 2s ease-out infinite;
      "></div>
      <div style="
        width:20px;height:20px;border-radius:50%;
        background:#3b82f6;border:3px solid white;
        box-shadow:0 2px 6px rgba(0,0,0,0.3);
      "></div>
    </div>`;
  return el;
}

const VEHICLE_IMAGES: Record<string, string> = {
  triciclo: '/images/vehicles/markers/triciclo@2x.png',
  moto: '/images/vehicles/markers/moto@2x.png',
  auto: '/images/vehicles/markers/auto@2x.png',
  confort: '/images/vehicles/markers/confort@2x.png',
};

function createVehicleMarkerEl(vehicleType: string, heading: number | null, etaSeconds?: number | null): HTMLDivElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    cursor: 'pointer',
    position: 'relative',
  });

  const imgSrc = VEHICLE_IMAGES[vehicleType] ?? VEHICLE_IMAGES.auto;
  const rotation = heading ?? 0;

  // Vehicle icon
  const icon = document.createElement('div');
  Object.assign(icon.style, {
    width: '40px',
    height: '40px',
    backgroundImage: `url(${imgSrc})`,
    backgroundSize: 'contain',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
    filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))',
    transform: `rotate(${rotation}deg)`,
    transition: 'transform 0.5s ease-out',
  });
  el.appendChild(icon);

  // ETA badge below icon
  if (etaSeconds != null && etaSeconds > 0) {
    const mins = Math.ceil(etaSeconds / 60);
    const badge = document.createElement('div');
    Object.assign(badge.style, {
      marginTop: '2px',
      padding: '1px 5px',
      borderRadius: '8px',
      background: '#1a1a2e',
      color: '#fff',
      fontSize: '10px',
      fontWeight: '700',
      whiteSpace: 'nowrap',
      textAlign: 'center',
      lineHeight: '14px',
      border: '1px solid rgba(255,255,255,0.3)',
      boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
    });
    badge.textContent = `${mins} min`;
    el.appendChild(badge);
  }

  return el;
}

/* ── POI category colors ── */
const POI_COLORS: Record<string, string> = {
  restaurant: '#E53935', cafe: '#E53935', bar: '#E53935', fast_food: '#E53935', bakery: '#E53935', nightclub: '#E53935',
  hotel: '#1E88E5', guest_house: '#1E88E5', hostel: '#1E88E5', apartment: '#1E88E5', chalet: '#1E88E5', motel: '#1E88E5',
  hospital: '#43A047', clinic: '#43A047', pharmacy: '#43A047', doctors: '#43A047', dentist: '#43A047',
  supermarket: '#FB8C00', convenience: '#FB8C00', marketplace: '#FB8C00', mobile_phone: '#FB8C00', hairdresser: '#FB8C00', car_repair: '#FB8C00',
  school: '#8E24AA', university: '#8E24AA', college: '#8E24AA', kindergarten: '#8E24AA',
  bank: '#546E7A', post_office: '#546E7A', police: '#546E7A', embassy: '#546E7A', townhall: '#546E7A', fire_station: '#546E7A', courthouse: '#546E7A',
  park: '#2E7D32', beach: '#2E7D32', attraction: '#2E7D32', museum: '#2E7D32', monument: '#2E7D32', theatre: '#2E7D32', cinema: '#2E7D32', library: '#2E7D32',
  fuel: '#FF6F00', bus_station: '#FF6F00', ferry_terminal: '#FF6F00', aerodrome: '#FF6F00',
};

function getPoiColor(subcategory: string): string {
  return POI_COLORS[subcategory] || '#78909C';
}

function poisToGeoJSON(pois: ViewportPoi[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pois.map(p => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        name: p.name,
        category: p.category,
        subcategory: p.subcategory,
        address: p.address || '',
        importance: p.importance,
        color: getPoiColor(p.subcategory),
      },
    })),
  };
}

/* ── CSS animations ── */
const PULSE_STYLES = `
  @keyframes pulse-green {
    0% { transform: scale(1); opacity: 0.6; }
    70% { transform: scale(2.5); opacity: 0; }
    100% { transform: scale(1); opacity: 0; }
  }
  @keyframes pulse-blue {
    0% { transform: scale(1); opacity: 0.5; }
    70% { transform: scale(3); opacity: 0; }
    100% { transform: scale(1); opacity: 0; }
  }
  @keyframes pin-bounce {
    0% { transform: translate(-50%, -100%); }
    40% { transform: translate(-50%, -115%); }
    60% { transform: translate(-50%, -100%); }
    80% { transform: translate(-50%, -105%); }
    100% { transform: translate(-50%, -100%); }
  }
  @keyframes pin-shadow-bounce {
    0% { transform: translateX(-50%) scale(1); opacity: 0.3; }
    40% { transform: translateX(-50%) scale(0.6); opacity: 0.15; }
    60% { transform: translateX(-50%) scale(1); opacity: 0.3; }
    80% { transform: translateX(-50%) scale(0.85); opacity: 0.25; }
    100% { transform: translateX(-50%) scale(1); opacity: 0.3; }
  }
`;

/* ── Main component ── */
export default function BookingMap({
  pickup,
  dropoff,
  userLocation,
  onSetPickup,
  onSetDropoff,
  onRequestLocation,
  onConfirmLocation,
  locationLoading,
  locationError,
  selectionStep,
  pickupAddress,
  dropoffAddress,
  centerAddress,
  centerAddressLoading,
  flyToTarget,
  routeCoords,
  routeLoading,
  nearbyVehicles = [],
  selectedServiceType,
  initialCenter,
  onMapCenterChange,
}: BookingMapProps) {
  const { t } = useTranslation('web');
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const pickupMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const dropoffMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const userLocMarkerRef = useRef<mapboxgl.Marker | null>(null);
  // vehicleMarkersRef removed — vehicles now use GeoJSON source + symbol layer
  const presetMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const poiAbortRef = useRef<AbortController | null>(null);
  const lastBoundsRef = useRef<{ minLng: number; minLat: number; maxLng: number; maxLat: number } | null>(null);
  const poiPopupRef = useRef<mapboxgl.Popup | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [bounceKey, setBounceKey] = useState(0);
  const [isMapMoving, setIsMapMoving] = useState(false);

  /* ── Initialize map ── */
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const center = initialCenter
      ? [initialCenter.longitude, initialCenter.latitude] as [number, number]
      : [CUBA_CENTER.longitude, CUBA_CENTER.latitude] as [number, number];
    const zoom = initialCenter ? 13 : CUBA_DEFAULT_ZOOM;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center,
      zoom,
      attributionControl: false,
      maxBounds: [[-85.5, 19.5], [-73.5, 23.8]], // All Cuba + padding
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      setMapReady(true);

      // ── POI source with clustering ──
      map.addSource('pois', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 50,
      });

      // Cluster circles
      map.addLayer({
        id: 'poi-clusters',
        type: 'circle',
        source: 'pois',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], '#51bbd6', 50, '#f1f075', 200, '#f28cb1'],
          'circle-radius': ['step', ['get', 'point_count'], 18, 50, 22, 200, 28],
          'circle-stroke-width': 2,
          'circle-stroke-color': 'rgba(255,255,255,0.6)',
        },
      });

      // Cluster count labels
      map.addLayer({
        id: 'poi-cluster-count',
        type: 'symbol',
        source: 'pois',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-size': 12,
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Bold'],
        },
        paint: { 'text-color': '#333' },
      });

      // Unclustered POI dots + labels
      map.addLayer({
        id: 'poi-unclustered',
        type: 'circle',
        source: 'pois',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 15, 7, 18, 10],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': 'rgba(255,255,255,0.9)',
        },
      });

      // POI name labels
      map.addLayer({
        id: 'poi-labels',
        type: 'symbol',
        source: 'pois',
        filter: ['!', ['has', 'point_count']],
        layout: {
          'text-field': ['get', 'name'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 13],
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-max-width': 8,
          'text-optional': true,
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#333',
          'text-halo-color': 'rgba(255,255,255,0.95)',
          'text-halo-width': 1.5,
        },
        minzoom: 13,
      });

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
          'line-color': '#000',
          'line-width': 8,
          'line-opacity': 0.15,
          'line-blur': 3,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });

      // Route line
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: {
          'line-color': '#FF4D00',
          'line-width': 5,
          'line-opacity': 0.9,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });

      // Preset location markers removed — always use reverse geocoding
    });

    map.on('moveend', () => {
      if (onMapCenterChange) {
        const center = map.getCenter();
        onMapCenterChange({ latitude: center.lat, longitude: center.lng });
      }
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /* ── Map move tracking for pin bounce ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const onMoveStart = () => setIsMapMoving(true);
    const onMoveEndBounce = () => {
      setIsMapMoving(false);
      setBounceKey(k => k + 1);
    };

    map.on('movestart', onMoveStart);
    map.on('moveend', onMoveEndBounce);
    return () => {
      map.off('movestart', onMoveStart);
      map.off('moveend', onMoveEndBounce);
    };
  }, [mapReady]);

  /* ── Fly to target (for "Use my location" button) ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !flyToTarget) return;
    map.flyTo({ center: [flyToTarget.longitude, flyToTarget.latitude], zoom: 16, duration: 1000 });
  }, [flyToTarget, mapReady]);

  /* ── Confirm location from center pin ── */
  const handleConfirmCenter = useCallback(() => {
    const map = mapRef.current;
    if (!map || selectionStep === 'done') return;
    const center = map.getCenter();
    const loc: LocationPreset = {
      label: centerAddress || `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`,
      address: centerAddress || `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`,
      latitude: center.lat,
      longitude: center.lng,
    };
    onConfirmLocation(loc);
  }, [selectionStep, centerAddress, onConfirmLocation]);

  /* ── Pickup marker ── */
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    if (pickupMarkerRef.current) { pickupMarkerRef.current.remove(); pickupMarkerRef.current = null; }
    if (!pickup) return;

    pickupMarkerRef.current = new mapboxgl.Marker({ element: createPickupMarkerEl(), anchor: 'center' })
      .setLngLat([pickup.longitude, pickup.latitude])
      .addTo(mapRef.current);

    // Fly to pickup location when selected from autocomplete
    mapRef.current.flyTo({ center: [pickup.longitude, pickup.latitude], zoom: 16, duration: 1000 });
  }, [pickup, mapReady]);

  /* ── Dropoff marker ── */
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    if (dropoffMarkerRef.current) { dropoffMarkerRef.current.remove(); dropoffMarkerRef.current = null; }
    if (!dropoff) return;

    dropoffMarkerRef.current = new mapboxgl.Marker({ element: createDropoffMarkerEl(), anchor: 'bottom' })
      .setLngLat([dropoff.longitude, dropoff.latitude])
      .addTo(mapRef.current);

    // Fly to dropoff location when selected from autocomplete
    mapRef.current.flyTo({ center: [dropoff.longitude, dropoff.latitude], zoom: 16, duration: 1000 });
  }, [dropoff, mapReady]);

  /* ── User location marker ── */
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    if (userLocMarkerRef.current) { userLocMarkerRef.current.remove(); userLocMarkerRef.current = null; }
    if (!userLocation) return;

    userLocMarkerRef.current = new mapboxgl.Marker({ element: createUserLocationEl(), anchor: 'center' })
      .setLngLat([userLocation.longitude, userLocation.latitude])
      .addTo(mapRef.current);
  }, [userLocation, mapReady]);

  /* ── Route line ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource('route') as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    if (routeCoords && routeCoords.length > 1) {
      // routeCoords are [lat, lng] from OSRM — convert to [lng, lat] for Mapbox
      const coords = routeCoords.map(([lat, lng]) => [lng, lat] as [number, number]);
      source.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords },
      });
    } else if (pickup && dropoff && !routeCoords) {
      // Fallback dashed line
      source.setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [pickup.longitude, pickup.latitude],
            [dropoff.longitude, dropoff.latitude],
          ],
        },
      });
    } else {
      source.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [routeCoords, pickup, dropoff, mapReady]);

  /* ── Fit bounds when both markers set ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !pickup || !dropoff) return;

    const bounds = new mapboxgl.LngLatBounds();
    bounds.extend([pickup.longitude, pickup.latitude]);
    bounds.extend([dropoff.longitude, dropoff.latitude]);
    map.fitBounds(bounds, { padding: 70, maxZoom: 15, duration: 800 });
  }, [pickup, dropoff, mapReady]);

  /* ── Nearby vehicle markers (GeoJSON source + symbol layer for rock-solid positioning) ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Initialize source + layer on first run
    if (!map.getSource('nearby-vehicles')) {
      map.addSource('nearby-vehicles', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Load vehicle images if not loaded
      const images: [string, string][] = [
        ['vehicle-triciclo', '/images/vehicles/markers/triciclo@2x.png'],
        ['vehicle-moto', '/images/vehicles/markers/moto@2x.png'],
        ['vehicle-auto', '/images/vehicles/markers/auto@2x.png'],
        ['vehicle-confort', '/images/vehicles/markers/confort@2x.png'],
      ];
      images.forEach(([name, url]) => {
        if (!map.hasImage(name)) {
          const img = new Image(80, 80);
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            if (!map.hasImage(name)) map.addImage(name, img);
          };
          img.src = url;
        }
      });

      // Vehicle icon layer
      map.addLayer({
        id: 'nearby-vehicles-layer',
        type: 'symbol',
        source: 'nearby-vehicles',
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.3, 14, 0.45, 18, 0.55],
          'icon-rotate': ['get', 'heading'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });
    }

    // Update data
    const features = nearbyVehicles.map((v) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [v.longitude, v.latitude] },
      properties: {
        id: v.driver_profile_id,
        icon: `vehicle-${v.vehicle_type === 'auto' ? 'auto' : v.vehicle_type}`,
        heading: v.heading ?? 0,
        vehicle_type: v.vehicle_type,
      },
    }));

    const src = map.getSource('nearby-vehicles') as mapboxgl.GeoJSONSource | undefined;
    if (src) {
      src.setData({ type: 'FeatureCollection', features });
    }
  }, [nearbyVehicles, mapReady]);

  /* ── POI viewport fetch ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let debounceTimer: ReturnType<typeof setTimeout>;

    const loadPois = () => {
      const zoom = map.getZoom();
      if (zoom < 10) {
        // Too zoomed out — clear POIs
        const src = map.getSource('pois') as mapboxgl.GeoJSONSource | undefined;
        if (src) src.setData({ type: 'FeatureCollection', features: [] });
        lastBoundsRef.current = null;
        return;
      }

      const mapBounds = map.getBounds();
      if (!mapBounds) return;
      const sw = mapBounds.getSouthWest();
      const ne = mapBounds.getNorthEast();

      // Pad bounds by 20% to avoid refetch on small pans
      const lngPad = (ne.lng - sw.lng) * 0.2;
      const latPad = (ne.lat - sw.lat) * 0.2;
      const bounds = {
        minLng: sw.lng - lngPad,
        minLat: sw.lat - latPad,
        maxLng: ne.lng + lngPad,
        maxLat: ne.lat + latPad,
      };

      // Skip if still within last fetched bounds at same zoom tier
      const last = lastBoundsRef.current;
      if (last && bounds.minLng >= last.minLng && bounds.minLat >= last.minLat
        && bounds.maxLng <= last.maxLng && bounds.maxLat <= last.maxLat) {
        return;
      }

      // Cancel previous request
      if (poiAbortRef.current) poiAbortRef.current.abort();
      const controller = new AbortController();
      poiAbortRef.current = controller;

      fetchPoisInViewport(bounds, zoom, controller.signal).then(pois => {
        if (controller.signal.aborted) return;
        const src = map.getSource('pois') as mapboxgl.GeoJSONSource | undefined;
        if (src) {
          src.setData(poisToGeoJSON(pois));
          lastBoundsRef.current = bounds;
        }
      });
    };

    const onMoveEnd = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadPois, 300);
    };

    map.on('moveend', onMoveEnd);
    // Initial load
    loadPois();

    return () => {
      map.off('moveend', onMoveEnd);
      clearTimeout(debounceTimer);
      if (poiAbortRef.current) poiAbortRef.current.abort();
    };
  }, [mapReady]);

  /* ── POI click handlers ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Click unclustered POI — show popup
    const onPoiClick = (e: mapboxgl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['poi-unclustered'] });
      if (!features.length) return;
      e.originalEvent.stopPropagation();
      const f = features[0];
      const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      const props = f.properties!;
      const subcategory = (props.subcategory || '').replace(/_/g, ' ');

      if (poiPopupRef.current) poiPopupRef.current.remove();
      poiPopupRef.current = new mapboxgl.Popup({ offset: 12, closeButton: true, maxWidth: '220px' })
        .setLngLat(coords)
        .setHTML(`
          <div style="font-family:system-ui;font-size:13px;">
            <strong style="display:block;margin-bottom:2px;">${props.name}</strong>
            ${subcategory ? `<span style="color:#888;font-size:11px;text-transform:capitalize;">${subcategory}</span><br/>` : ''}
            ${props.address ? `<span style="color:#666;font-size:11px;">${props.address}</span>` : ''}
          </div>
        `)
        .addTo(map);
    };

    // Click cluster — zoom in
    const onClusterClick = (e: mapboxgl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['poi-clusters'] });
      if (!features.length) return;
      e.originalEvent.stopPropagation();
      const clusterId = features[0].properties!.cluster_id;
      (map.getSource('pois') as mapboxgl.GeoJSONSource).getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err || zoom == null) return;
        const coords = (features[0].geometry as GeoJSON.Point).coordinates as [number, number];
        map.easeTo({ center: coords, zoom: zoom + 0.5 });
      });
    };

    // Cursor changes
    const onPoiEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const onPoiLeave = () => { map.getCanvas().style.cursor = ''; };

    map.on('click', 'poi-unclustered', onPoiClick);
    map.on('click', 'poi-clusters', onClusterClick);
    map.on('mouseenter', 'poi-unclustered', onPoiEnter);
    map.on('mouseleave', 'poi-unclustered', onPoiLeave);
    map.on('mouseenter', 'poi-clusters', onPoiEnter);
    map.on('mouseleave', 'poi-clusters', onPoiLeave);

    return () => {
      map.off('click', 'poi-unclustered', onPoiClick);
      map.off('click', 'poi-clusters', onClusterClick);
      map.off('mouseenter', 'poi-unclustered', onPoiEnter);
      map.off('mouseleave', 'poi-unclustered', onPoiLeave);
      map.off('mouseenter', 'poi-clusters', onPoiEnter);
      map.off('mouseleave', 'poi-clusters', onPoiLeave);
      if (poiPopupRef.current) { poiPopupRef.current.remove(); poiPopupRef.current = null; }
    };
  }, [mapReady]);

  /* ── Preset click handler ── */
  const handlePresetClick = useCallback(
    (preset: LocationPreset) => {
      if (selectionStep === 'pickup') onSetPickup(preset);
      else if (selectionStep === 'dropoff') onSetDropoff(preset);
    },
    [selectionStep, onSetPickup, onSetDropoff],
  );

  const instructionKey =
    selectionStep === 'pickup' ? 'book.map_instruction_pickup'
    : selectionStep === 'dropoff' ? 'book.map_instruction_dropoff'
    : 'book.map_instruction_done';

  const instructionColor =
    selectionStep === 'pickup' ? '#22c55e'
    : selectionStep === 'dropoff' ? '#ef4444'
    : 'var(--primary)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <style>{PULSE_STYLES}</style>

      {/* Instruction banner */}
      <div
        style={{
          padding: '0.625rem 0.75rem',
          borderRadius: '0.5rem',
          background: '#1a1a2e',
          border: `1px solid ${instructionColor}`,
          fontSize: '0.8rem',
          fontWeight: 500,
          color: '#e5e5e5',
          textAlign: 'center',
        }}
      >
        {t(instructionKey)}
      </div>

      {/* Mapbox GL map */}
      <div style={{ position: 'relative' }}>
        <div
          ref={mapContainerRef}
          style={{
            height: 420,
            width: '100%',
            borderRadius: '0.75rem',
            overflow: 'hidden',
          }}
        />

        {/* Center pin — fixed CSS element, not a Mapbox marker */}
        {selectionStep !== 'done' && (
          <>
            <div
              key={bounceKey}
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -100%)',
                zIndex: 5,
                pointerEvents: 'none',
                animation: !isMapMoving ? 'pin-bounce 0.5s ease-out' : undefined,
              }}
            >
              <div style={{
                width: 32,
                height: 44,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
              }}>
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: selectionStep === 'pickup' ? '#22c55e' : '#FF4D00',
                  border: '3px solid white',
                  boxShadow: `0 3px 10px ${selectionStep === 'pickup' ? 'rgba(34,197,94,0.5)' : 'rgba(255,77,0,0.5)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'white' }} />
                </div>
                <div style={{
                  width: 0,
                  height: 0,
                  borderLeft: '8px solid transparent',
                  borderRight: '8px solid transparent',
                  borderTop: `10px solid ${selectionStep === 'pickup' ? '#22c55e' : '#FF4D00'}`,
                  marginTop: -2,
                }} />
              </div>
            </div>
            {/* Pin shadow */}
            <div
              key={`shadow-${bounceKey}`}
              style={{
                position: 'absolute',
                top: 'calc(50% + 2px)',
                left: '50%',
                transform: 'translateX(-50%)',
                width: 14,
                height: 5,
                borderRadius: '50%',
                background: 'rgba(0,0,0,0.3)',
                zIndex: 4,
                pointerEvents: 'none',
                animation: !isMapMoving ? 'pin-shadow-bounce 0.5s ease-out' : undefined,
              }}
            />
          </>
        )}

        {/* Bottom address bar + confirm button */}
        {selectionStep !== 'done' && (
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              background: 'rgba(26,26,46,0.95)',
              backdropFilter: 'blur(8px)',
              padding: '0.75rem 1rem',
              borderRadius: '0 0 0.75rem 0.75rem',
              zIndex: 15,
            }}
          >
            <div style={{
              fontSize: '0.8rem',
              color: '#e5e5e5',
              marginBottom: '0.5rem',
              minHeight: '1.2em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {centerAddressLoading ? (
                <span style={{ color: '#888' }}>{t('book.detecting_address', { defaultValue: 'Detectando direcci\u00f3n...' })}</span>
              ) : centerAddress ? (
                centerAddress
              ) : (
                <span style={{ color: '#888' }}>{t('book.detecting_address', { defaultValue: 'Detectando direcci\u00f3n...' })}</span>
              )}
            </div>
            <button
              type="button"
              onClick={handleConfirmCenter}
              disabled={centerAddressLoading}
              style={{
                width: '100%',
                padding: '0.7rem',
                borderRadius: '0.5rem',
                border: 'none',
                background: selectionStep === 'pickup' ? '#22c55e' : '#FF4D00',
                color: 'white',
                fontSize: '0.9rem',
                fontWeight: 700,
                cursor: centerAddressLoading ? 'wait' : 'pointer',
                opacity: centerAddressLoading ? 0.7 : 1,
                transition: 'opacity 0.2s',
              }}
            >
              {selectionStep === 'pickup' ? t('book.confirm_pickup', { defaultValue: 'Confirmar recogida' }) : t('book.confirm_dropoff', { defaultValue: 'Confirmar destino' })}
            </button>
          </div>
        )}

        {/* Route loading overlay */}
        {routeLoading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(26,26,46,0.7)',
              zIndex: 10,
              borderRadius: '0.75rem',
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#FF4D00',
            }}
          >
            {t('book.route_loading', { defaultValue: 'Calculando ruta...' })}
          </div>
        )}
      </div>

      {/* Use my location button */}
      <button
        type="button"
        onClick={onRequestLocation}
        disabled={locationLoading || selectionStep === 'done'}
        style={{
          width: '100%',
          padding: '0.625rem',
          borderRadius: '0.5rem',
          border: '1px solid #333',
          background: '#1a1a2e',
          cursor: locationLoading || selectionStep === 'done' ? 'not-allowed' : 'pointer',
          fontSize: '0.85rem',
          fontWeight: 500,
          color: selectionStep === 'done' ? '#555' : '#e5e5e5',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          opacity: selectionStep === 'done' ? 0.5 : 1,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', display: 'inline-block' }} />
        {locationLoading ? t('book.map_locating', { defaultValue: 'Localizando...' }) : t('book.map_use_my_location', { defaultValue: 'Usar mi ubicaci\u00f3n' })}
      </button>

      {/* Nearby vehicles count */}
      {nearbyVehicles.length > 0 && (
        <p style={{
          fontSize: '0.8rem', fontWeight: 600, color: '#22c55e',
          textAlign: 'center', margin: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem',
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
          {t('book.nearby_vehicles', { count: nearbyVehicles.length, defaultValue: '{{count}} veh\u00edculos disponibles cerca' })}
        </p>
      )}

      {/* Location error */}
      {locationError && (
        <p style={{ fontSize: '0.8rem', color: '#ef4444', textAlign: 'center', margin: 0 }}>
          {locationError === 'denied' ? t('book.map_location_denied', { defaultValue: 'Permiso de ubicaci\u00f3n denegado' }) : t('book.map_location_unavailable', { defaultValue: 'Ubicaci\u00f3n no disponible' })}
        </p>
      )}

      {/* Preset buttons removed — user types address or clicks map */}
    </div>
  );
}
