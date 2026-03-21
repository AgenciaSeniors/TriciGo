'use client';

import { useCallback, useEffect, useMemo } from 'react';
import L from 'leaflet';
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Polyline,
  Marker,
  useMapEvents,
  useMap,
  Tooltip,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useTranslation } from '@tricigo/i18n';
import { HAVANA_CENTER, HAVANA_PRESETS, findNearestPreset, formatCUP } from '@tricigo/utils';
import type { LocationPreset } from '@tricigo/utils';
import type { NearbyVehicle, ServiceTypeSlug } from '@tricigo/types';

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

/* ─── Custom Leaflet DivIcons (Uber-style) ─── */

const pickupIcon = L.divIcon({
  className: '',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  html: `<div style="
    width: 24px; height: 24px; border-radius: 50%;
    background: #22c55e; border: 3px solid white;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    display: flex; align-items: center; justify-content: center;
  "><div style="width: 8px; height: 8px; border-radius: 50%; background: white;"></div></div>`,
});

const dropoffIcon = L.divIcon({
  className: '',
  iconSize: [28, 36],
  iconAnchor: [14, 36],
  html: `<div style="
    width: 28px; height: 36px; position: relative;
    display: flex; align-items: flex-start; justify-content: center;
  ">
    <div style="
      width: 24px; height: 24px; border-radius: 50%;
      background: #FF4D00; border: 3px solid white;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      position: relative; z-index: 1;
    "></div>
    <div style="
      position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
      width: 0; height: 0;
      border-left: 7px solid transparent; border-right: 7px solid transparent;
      border-top: 12px solid #FF4D00;
    "></div>
  </div>`,
});

/* ─── Vehicle DivIcons by type ─── */
const VEHICLE_EMOJI: Record<string, string> = {
  triciclo: '\uD83D\uDEFA',
  moto: '\uD83C\uDFCD\uFE0F',
  auto: '\uD83D\uDE97',
};

function makeVehicleIcon(vehicleType: string, heading: number | null): L.DivIcon {
  const emoji = VEHICLE_EMOJI[vehicleType] ?? '\uD83D\uDE97';
  const rotation = heading ?? 0;
  return L.divIcon({
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    html: `<div style="
      width: 32px; height: 32px; border-radius: 50%;
      background: #FF4D00; border: 2px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      display: flex; align-items: center; justify-content: center;
      font-size: 16px;
      transform: rotate(${rotation}deg);
    ">${emoji}</div>`,
  });
}

/* ─── inner component: captures map clicks ─── */
function MapClickHandler({
  onMapClick,
}: {
  onMapClick: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/* ─── inner component: auto-fit bounds when both markers are set ─── */
function FitBounds({
  pickup,
  dropoff,
}: {
  pickup: LocationPreset | null;
  dropoff: LocationPreset | null;
}) {
  const map = useMap();

  useEffect(() => {
    if (!pickup || !dropoff) return;
    const bounds = L.latLngBounds(
      [pickup.latitude, pickup.longitude],
      [dropoff.latitude, dropoff.longitude],
    );
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
  }, [map, pickup, dropoff]);

  return null;
}

/* ─── main component ─── */
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

  const handleMapClick = useCallback(
    (lat: number, lng: number) => {
      if (selectionStep === 'done') return;

      const point = { latitude: lat, longitude: lng };
      const preset = findNearestPreset(point) ?? {
        label: t('book.map_custom_location'),
        address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
        latitude: lat,
        longitude: lng,
      };

      if (selectionStep === 'pickup') {
        onSetPickup(preset);
      } else {
        onSetDropoff(preset);
      }
    },
    [selectionStep, onSetPickup, onSetDropoff, t],
  );

  const handlePresetClick = useCallback(
    (preset: LocationPreset) => {
      if (selectionStep === 'pickup') {
        onSetPickup(preset);
      } else if (selectionStep === 'dropoff') {
        onSetDropoff(preset);
      }
    },
    [selectionStep, onSetPickup, onSetDropoff],
  );

  /* instruction text */
  const instructionKey =
    selectionStep === 'pickup'
      ? 'book.map_instruction_pickup'
      : selectionStep === 'dropoff'
        ? 'book.map_instruction_dropoff'
        : 'book.map_instruction_done';

  const instructionColor =
    selectionStep === 'pickup'
      ? '#22c55e'
      : selectionStep === 'dropoff'
        ? '#ef4444'
        : 'var(--primary)';

  /* Pickup tooltip text */
  const pickupTooltip = useMemo(() => {
    if (!pickup) return '';
    if (pickupAddress) return `${pickup.label}\n${pickupAddress}`;
    return pickup.label;
  }, [pickup, pickupAddress]);

  /* Dropoff tooltip text */
  const dropoffTooltip = useMemo(() => {
    if (!dropoff) return '';
    if (dropoffAddress) return `${dropoff.label}\n${dropoffAddress}`;
    return dropoff.label;
  }, [dropoff, dropoffAddress]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* pulsing animation for user location marker */}
      <style>{`
        @keyframes pulse-blue {
          0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.5); }
          70% { box-shadow: 0 0 0 12px rgba(59, 130, 246, 0); }
          100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
        }
        .booking-map-container .leaflet-interactive.user-loc {
          animation: pulse-blue 2s infinite;
        }
        .booking-map-container .leaflet-tooltip {
          font-size: 0.75rem;
          max-width: 200px;
          white-space: pre-line;
        }
      `}</style>

      {/* Instruction banner */}
      <div
        style={{
          padding: '0.625rem 0.75rem',
          borderRadius: '0.5rem',
          background: '#f8f8f8',
          border: `1px solid ${instructionColor}`,
          fontSize: '0.8rem',
          fontWeight: 500,
          color: '#333',
          textAlign: 'center',
        }}
      >
        {t(instructionKey)}
      </div>

      {/* Leaflet map */}
      <div
        className="booking-map-container"
        style={{ borderRadius: '0.75rem', overflow: 'hidden', border: '1px solid #333', position: 'relative', background: '#1a1a2e' }}
      >
        <MapContainer
          center={[HAVANA_CENTER.latitude, HAVANA_CENTER.longitude]}
          zoom={13}
          style={{ height: 420, width: '100%' }}
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; <a href="https://www.mapbox.com/">Mapbox</a>'
            url={`https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/{z}/{x}/{y}?access_token=${process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? ''}`}
            tileSize={512}
            zoomOffset={-1}
          />
          <MapClickHandler onMapClick={handleMapClick} />
          <FitBounds pickup={pickup} dropoff={dropoff} />

          {/* Pickup marker - green Uber-style */}
          {pickup && (
            <Marker
              position={[pickup.latitude, pickup.longitude]}
              icon={pickupIcon}
            >
              <Tooltip direction="top" offset={[0, -14]} permanent>
                {pickupTooltip}
              </Tooltip>
            </Marker>
          )}

          {/* Dropoff marker - orange pin Uber-style */}
          {dropoff && (
            <Marker
              position={[dropoff.latitude, dropoff.longitude]}
              icon={dropoffIcon}
            >
              <Tooltip direction="top" offset={[0, -38]} permanent>
                {dropoffTooltip}
              </Tooltip>
            </Marker>
          )}

          {/* User location - blue pulsing */}
          {userLocation && (
            <CircleMarker
              center={[userLocation.latitude, userLocation.longitude]}
              radius={8}
              pathOptions={{ color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.9, weight: 2 }}
              className="user-loc"
            />
          )}

          {/* Route: OSRM real route or dashed fallback */}
          {pickup && dropoff && routeCoords && (
            <>
              {/* Shadow */}
              <Polyline
                positions={routeCoords}
                pathOptions={{
                  color: '#000',
                  weight: 8,
                  opacity: 0.15,
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
              />
              {/* Main route line */}
              <Polyline
                positions={routeCoords}
                pathOptions={{
                  color: '#FF4D00',
                  weight: 5,
                  opacity: 0.85,
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
              />
            </>
          )}
          {/* Fallback dashed line when no route data */}
          {pickup && dropoff && !routeCoords && !routeLoading && (
            <Polyline
              positions={[
                [pickup.latitude, pickup.longitude],
                [dropoff.latitude, dropoff.longitude],
              ]}
              pathOptions={{ color: '#888', weight: 2, dashArray: '8 6' }}
            />
          )}

          {/* Preset location dots (small, grey, as reference points) */}
          {HAVANA_PRESETS.map((p) => {
            const isPickup = pickup?.label === p.label;
            const isDropoff = dropoff?.label === p.label;
            if (isPickup || isDropoff) return null;
            return (
              <CircleMarker
                key={p.label}
                center={[p.latitude, p.longitude]}
                radius={4}
                pathOptions={{ color: '#666', fillColor: '#888', fillOpacity: 0.8, weight: 1 }}
              >
                <Tooltip direction="top" offset={[0, -6]}>
                  {p.label}
                </Tooltip>
              </CircleMarker>
            );
          })}

          {/* Nearby vehicle markers */}
          {nearbyVehicles.map((v) => (
            <Marker
              key={v.driver_profile_id}
              position={[v.latitude, v.longitude]}
              icon={makeVehicleIcon(v.vehicle_type, v.heading)}
            >
              <Tooltip direction="top" offset={[0, -18]}>
                {v.vehicle_type === 'triciclo' ? t('book.vehicle_triciclo') :
                 v.vehicle_type === 'moto' ? t('book.vehicle_moto') :
                 t('book.vehicle_auto')}
                {v.custom_per_km_rate_cup
                  ? `\n${formatCUP(v.custom_per_km_rate_cup)}/km`
                  : ''}
              </Tooltip>
            </Marker>
          ))}
        </MapContainer>

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
              zIndex: 1000,
              borderRadius: '0.75rem',
              fontSize: '0.875rem',
              fontWeight: 600,
              color: 'var(--primary)',
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
          border: '1px solid #ddd',
          background: 'white',
          cursor: locationLoading || selectionStep === 'done' ? 'not-allowed' : 'pointer',
          fontSize: '0.85rem',
          fontWeight: 500,
          color: selectionStep === 'done' ? '#aaa' : '#333',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          opacity: selectionStep === 'done' ? 0.5 : 1,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#3b82f6',
            display: 'inline-block',
          }}
        />
        {locationLoading ? t('book.map_locating') : t('book.map_use_my_location')}
      </button>

      {/* Nearby vehicles count */}
      {nearbyVehicles.length > 0 && (
        <p
          style={{
            fontSize: '0.8rem',
            fontWeight: 600,
            color: 'var(--primary)',
            textAlign: 'center',
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.375rem',
          }}
        >
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: '#22c55e', display: 'inline-block',
          }} />
          {t('book.nearby_vehicles', { count: nearbyVehicles.length })}
        </p>
      )}

      {/* Location error */}
      {locationError && (
        <p style={{ fontSize: '0.8rem', color: 'var(--primary-dark)', textAlign: 'center', margin: 0 }}>
          {locationError === 'denied'
            ? t('book.map_location_denied')
            : t('book.map_location_unavailable')}
        </p>
      )}

      {/* Quick-select preset buttons */}
      <div>
        <p
          style={{
            fontSize: '0.75rem',
            fontWeight: 600,
            color: '#888',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: '0.5rem',
          }}
        >
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
                {isPickup && (
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
                )}
                {isDropoff && (
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
                )}
                {p.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
