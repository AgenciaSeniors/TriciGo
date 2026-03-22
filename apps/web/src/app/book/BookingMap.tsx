'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useTranslation } from '@tricigo/i18n';
import { HAVANA_CENTER, HAVANA_PRESETS, findNearestPreset } from '@tricigo/utils';
import type { LocationPreset } from '@tricigo/utils';
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
  locationLoading: boolean;
  locationError: string | null;
  selectionStep: SelectionStep;
  pickupAddress: string | null;
  dropoffAddress: string | null;
  routeCoords: [number, number][] | null;
  routeLoading: boolean;
  nearbyVehicles?: NearbyVehicle[];
  selectedServiceType?: ServiceTypeSlug;
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

function createVehicleMarkerEl(vehicleType: string, heading: number | null): HTMLDivElement {
  const el = document.createElement('div');
  const imgSrc = VEHICLE_IMAGES[vehicleType] ?? VEHICLE_IMAGES.auto;
  const rotation = heading ?? 0;
  el.innerHTML = `
    <div style="
      width:40px;height:40px;
      filter:drop-shadow(0 2px 4px rgba(0,0,0,0.4));
      transform:rotate(${rotation}deg);
      transition:transform 0.5s ease-out;
    ">
      <img src="${imgSrc}" alt="${vehicleType}" width="40" height="40" style="width:40px;height:40px;object-fit:contain;" />
    </div>`;
  return el;
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
`;

/* ── Main component ── */
export default function BookingMap({
  pickup,
  dropoff,
  userLocation,
  onSetPickup,
  onSetDropoff,
  onRequestLocation,
  locationLoading,
  locationError,
  selectionStep,
  pickupAddress,
  dropoffAddress,
  routeCoords,
  routeLoading,
  nearbyVehicles = [],
  selectedServiceType,
}: BookingMapProps) {
  const { t } = useTranslation('web');
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const pickupMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const dropoffMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const userLocMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const vehicleMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const presetMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const [mapReady, setMapReady] = useState(false);

  /* ── Initialize map ── */
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [HAVANA_CENTER.longitude, HAVANA_CENTER.latitude],
      zoom: 13,
      attributionControl: false,
      maxBounds: [[-83.5, 22.0], [-81.0, 23.8]], // Cuba bounds
    });

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

      // Add preset location markers
      HAVANA_PRESETS.forEach((p) => {
        const el = document.createElement('div');
        el.style.cssText = 'width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.2);cursor:pointer;transition:all 0.2s;';
        el.addEventListener('mouseenter', () => { el.style.transform = 'scale(1.5)'; el.style.background = 'rgba(255,255,255,0.7)'; });
        el.addEventListener('mouseleave', () => { el.style.transform = 'scale(1)'; el.style.background = 'rgba(255,255,255,0.4)'; });

        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat([p.longitude, p.latitude])
          .setPopup(new mapboxgl.Popup({ offset: 10, closeButton: false }).setText(p.label))
          .addTo(map);

        presetMarkersRef.current.push(marker);
      });
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /* ── Map click handler ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const handleClick = (e: mapboxgl.MapMouseEvent) => {
      if (selectionStep === 'done') return;
      const { lat, lng } = e.lngLat;
      const preset = findNearestPreset({ latitude: lat, longitude: lng }) ?? {
        label: t('book.map_custom_location'),
        address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
        latitude: lat,
        longitude: lng,
      };
      if (selectionStep === 'pickup') onSetPickup(preset);
      else onSetDropoff(preset);
    };

    map.on('click', handleClick);
    return () => { map.off('click', handleClick); };
  }, [mapReady, selectionStep, onSetPickup, onSetDropoff, t]);

  /* ── Pickup marker ── */
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    if (pickupMarkerRef.current) { pickupMarkerRef.current.remove(); pickupMarkerRef.current = null; }
    if (!pickup) return;

    pickupMarkerRef.current = new mapboxgl.Marker({ element: createPickupMarkerEl(), anchor: 'center' })
      .setLngLat([pickup.longitude, pickup.latitude])
      .addTo(mapRef.current);
  }, [pickup, mapReady]);

  /* ── Dropoff marker ── */
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    if (dropoffMarkerRef.current) { dropoffMarkerRef.current.remove(); dropoffMarkerRef.current = null; }
    if (!dropoff) return;

    dropoffMarkerRef.current = new mapboxgl.Marker({ element: createDropoffMarkerEl(), anchor: 'bottom' })
      .setLngLat([dropoff.longitude, dropoff.latitude])
      .addTo(mapRef.current);
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

  /* ── Nearby vehicle markers ── */
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    // Remove old vehicle markers
    vehicleMarkersRef.current.forEach((m) => m.remove());
    vehicleMarkersRef.current = [];

    nearbyVehicles.forEach((v) => {
      const marker = new mapboxgl.Marker({
        element: createVehicleMarkerEl(v.vehicle_type, v.heading),
        anchor: 'center',
      })
        .setLngLat([v.longitude, v.latitude])
        .addTo(mapRef.current!);
      vehicleMarkersRef.current.push(marker);
    });
  }, [nearbyVehicles, mapReady]);

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
            {t('book.route_loading')}
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
        {locationLoading ? t('book.map_locating') : t('book.map_use_my_location')}
      </button>

      {/* Nearby vehicles count */}
      {nearbyVehicles.length > 0 && (
        <p style={{
          fontSize: '0.8rem', fontWeight: 600, color: '#22c55e',
          textAlign: 'center', margin: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem',
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
          {t('book.nearby_vehicles', { count: nearbyVehicles.length })}
        </p>
      )}

      {/* Location error */}
      {locationError && (
        <p style={{ fontSize: '0.8rem', color: '#ef4444', textAlign: 'center', margin: 0 }}>
          {locationError === 'denied' ? t('book.map_location_denied') : t('book.map_location_unavailable')}
        </p>
      )}

      {/* Quick-select preset buttons */}
      <div>
        <p style={{
          fontSize: '0.75rem', fontWeight: 600, color: '#666',
          textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem',
        }}>
          {t('book.map_preset_buttons_label')}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          {HAVANA_PRESETS.map((p) => {
            const isPickup = pickup?.label === p.label;
            const isDropoff = dropoff?.label === p.label;
            const isSelected = isPickup || isDropoff;
            return (
              <button
                key={p.label}
                type="button"
                disabled={selectionStep === 'done'}
                onClick={() => handlePresetClick(p)}
                style={{
                  padding: '0.5rem 0.625rem',
                  borderRadius: '0.5rem',
                  border: isSelected ? '2px solid var(--primary)' : '1px solid #ddd',
                  background: isSelected ? '#FFF5F0' : 'white',
                  cursor: selectionStep === 'done' ? 'not-allowed' : 'pointer',
                  fontSize: '0.75rem',
                  fontWeight: isSelected ? 600 : 400,
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                  opacity: selectionStep === 'done' && !isSelected ? 0.5 : 1,
                }}
              >
                {isPickup && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />}
                {isDropoff && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />}
                {p.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
