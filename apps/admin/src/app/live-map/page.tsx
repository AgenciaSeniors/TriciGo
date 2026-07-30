'use client';

// ============================================================
// TriciGo Admin — /admin/live-map — Unified live operations map
//
// Single map with two toggleable layers:
//  - Conductores (drivers): every driver online + approved + located,
//    color-coded by state (idle / en route / in progress / on break).
//    Source: admin_get_online_fleet() RPC (enriched with vehicles.type).
//    Realtime on driver_profiles UPDATE + 30s polling. Rendered as the
//    top-down VEHICLE on a white badge whose ring carries the state
//    color (DriverVehicleMarker), falling back to a solid dot when the
//    vehicle type is unknown.
//  - Viajes (rides): active rides by status (searching / accepted /
//    driver_en_route / arrived_at_pickup / in_progress) at their pickup
//    location. Source: adminService.getRides() per status, 30s polling.
//    Rendered as HOLLOW rings + a list table below the map.
//
// This page replaces the former separate /admin/fleet page (PR-MAP-1):
// both maps were the same surface conceptually, so they were merged.
//
// Stack: react-leaflet (SSR-disabled). No new dependencies.
// ============================================================

import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { adminService, getSupabaseClient } from '@tricigo/api';
import type { Ride, OnlineFleetDriver, VehicleType } from '@tricigo/types';
import dynamic from 'next/dynamic';
import { markerSizeForZoom } from './markerSize';

// Dynamically import Leaflet components (no SSR)
const MapContainer = dynamic(
  () => import('react-leaflet').then((m) => m.MapContainer),
  { ssr: false },
);
const TileLayer = dynamic(
  () => import('react-leaflet').then((m) => m.TileLayer),
  { ssr: false },
);
const CircleMarkerDynamic = dynamic(
  () => import('react-leaflet').then((m) => m.CircleMarker),
  { ssr: false },
);
const PopupDynamic = dynamic(
  () => import('react-leaflet').then((m) => m.Popup),
  { ssr: false },
);
// Vehicle-on-badge marker for drivers with a known vehicle type.
// Imports `leaflet` at module level, hence its own ssr:false chunk.
const DriverVehicleMarkerDynamic = dynamic(
  () => import('./DriverVehicleMarker'),
  { ssr: false },
);
// Reports the map's zoom up so marker size can follow it (markerSize.ts).
const MapZoomWatcherDynamic = dynamic(
  () => import('./MapZoomWatcher'),
  { ssr: false },
);

// ---- Rides layer ----
const STATUS_COLORS: Record<string, string> = {
  searching: '#EAB308',     // yellow
  accepted: '#3B82F6',      // blue
  driver_en_route: '#3B82F6',
  arrived_at_pickup: '#8B5CF6', // purple
  in_progress: '#22C55E',   // green
  arrived_at_destination: '#14B8A6', // teal — last leg, distinct from both
};

/* `arrived_at_destination` was missing here, and this list is what the poll
   below queries status by status — so a trip vanished from the live map the
   moment the driver reached the destination and only the driver marker stayed,
   which the code at getDriverState() already counts as on-a-trip. The map
   contradicted itself. It is an active state; it belongs. */
const ACTIVE_STATUSES = ['searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination'];

/** Map opens on the whole island. Shared with the marker-size seed so the
    first paint already uses the right tier (no mount-time size jump). */
const INITIAL_CENTER: [number, number] = [21.5, -79.5];
const INITIAL_ZOOM = 7;

function parseLocation(loc: unknown): { lat: number; lng: number } | null {
  if (!loc) return null;
  if (typeof loc === 'object' && loc !== null) {
    const obj = loc as Record<string, unknown>;
    if (typeof obj.coordinates === 'object' && obj.coordinates !== null) {
      const coords = obj.coordinates as number[];
      return { lat: coords[1] ?? 0, lng: coords[0] ?? 0 };
    }
    if (typeof obj.latitude === 'number' && typeof obj.longitude === 'number') {
      return { lat: obj.latitude, lng: obj.longitude };
    }
  }
  return null;
}

// ---- Drivers layer ----
const DRIVER_STATES = ['idle', 'en_route', 'in_progress', 'on_break'] as const;
type DriverState = (typeof DRIVER_STATES)[number];

// Record<DriverState, …> (not Record<string, …>) so a future state can't
// silently render colorless — same lesson as the ride-status map (#880).
const STATE_COLORS: Record<DriverState, string> = {
  in_progress: '#F97316',   // orange — ride en curso
  en_route: '#EAB308',      // yellow — yendo al pickup o aceptado
  on_break: '#9CA3AF',      // gray — pausa
  idle: '#22C55E',          // green — online sin ride
};

function getDriverState(d: OnlineFleetDriver): DriverState {
  if (d.current_ride_status && (
    d.current_ride_status === 'arrived_at_pickup' ||
    d.current_ride_status === 'in_progress' ||
    d.current_ride_status === 'arrived_at_destination'
  )) return 'in_progress';
  if (d.current_ride_status && (
    d.current_ride_status === 'accepted' ||
    d.current_ride_status === 'driver_en_route'
  )) return 'en_route';
  if (d.is_on_break) return 'on_break';
  return 'idle';
}

function formatRelative(ts: string | null): string {
  if (!ts) return '—';
  const diffMs = Date.now() - new Date(ts).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'hace segundos';
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  return `hace ${diffDay}d`;
}

export default function LiveMapPage() {
  const { t } = useTranslation('admin');

  // Rides layer state
  const [rides, setRides] = useState<Ride[]>([]);
  const [rideFilter, setRideFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  // Drivers layer state
  const [drivers, setDrivers] = useState<OnlineFleetDriver[]>([]);
  const [driverFilter, setDriverFilter] = useState<'all' | DriverState>('all');
  const [fleetUnavailable, setFleetUnavailable] = useState(false);

  // Layer toggles (both on by default)
  const [showDrivers, setShowDrivers] = useState(true);
  const [showRides, setShowRides] = useState(true);

  // Marker size follows the zoom: divIcons are fixed px, so a street-level
  // badge is kilometres wide at country zoom. Seeded with the map's initial
  // zoom below; MapZoomWatcher keeps it current.
  const [zoom, setZoom] = useState(INITIAL_ZOOM);
  const markerSize = useMemo(() => markerSizeForZoom(zoom), [zoom]);
  // Stable identity: MapZoomWatcher seeds on mount via a useEffect keyed
  // on this callback, so a new function each render would re-fire it.
  const handleZoomChange = useCallback((z: number) => setZoom(z), []);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRides = async () => {
    try {
      const allRides: Ride[] = [];
      for (const status of ACTIVE_STATUSES) {
        try {
          const statusRides = await adminService.getRides({ status }, 0, 100);
          allRides.push(...statusRides);
        } catch { /* ignore individual status errors */ }
      }
      setRides(allRides);
    } catch {
      // Rides layer error is non-fatal; leave whatever we had.
    } finally {
      setLoading(false);
    }
  };

  // Non-fatal: a fleet RPC error must NOT blank the map or break the
  // rides layer. We just drop drivers to [] and surface a discreet note.
  const fetchFleet = async () => {
    try {
      const data = await adminService.getOnlineFleet();
      setDrivers(data);
      setFleetUnavailable(false);
    } catch {
      setDrivers([]);
      setFleetUnavailable(true);
    }
  };

  // Initial load + 30s fallback polling for both layers
  useEffect(() => {
    fetchRides();
    fetchFleet();
    intervalRef.current = setInterval(() => {
      fetchRides();
      fetchFleet();
    }, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Realtime: refetch the fleet within ~1s when a driver changes
  // is_online / position / status (same pattern as the old /fleet page).
  useEffect(() => {
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel('admin-live-map-fleet')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'driver_profiles' },
        () => {
          fetchFleet();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // ---- Derived (rides) ----
  const filteredRides = useMemo(
    () => (rideFilter === 'all' ? rides : rides.filter((r) => r.status === rideFilter)),
    [rides, rideFilter],
  );
  const rideStatusCounts = useMemo(
    () =>
      ACTIVE_STATUSES.reduce((acc, s) => {
        acc[s] = rides.filter((r) => r.status === s).length;
        return acc;
      }, {} as Record<string, number>),
    [rides],
  );
  const statusLabels: Record<string, string> = {
    searching: t('dashboard.status_searching', { defaultValue: 'Buscando' }),
    accepted: t('dashboard.status_accepted', { defaultValue: 'Aceptado' }),
    driver_en_route: t('dashboard.status_driver_en_route', { defaultValue: 'En camino' }),
    arrived_at_pickup: t('dashboard.status_arrived_at_pickup', { defaultValue: 'En punto' }),
    in_progress: t('dashboard.status_in_progress', { defaultValue: 'En progreso' }),
    // Both call sites below fall back to `?? ride.status`, so omitting this one
    // put a raw enum on the live map — and unlike the detail page's timeline,
    // here it names a ride that is still in flight.
    arrived_at_destination: t('dashboard.status_arrived_at_destination', { defaultValue: 'En destino' }),
  };

  // ---- Derived (drivers) ----
  const filteredDrivers = useMemo(
    () => (driverFilter === 'all' ? drivers : drivers.filter((d) => getDriverState(d) === driverFilter)),
    [drivers, driverFilter],
  );
  const driverStateCounts = useMemo(() => {
    const c: Record<DriverState, number> = { idle: 0, en_route: 0, in_progress: 0, on_break: 0 };
    for (const d of drivers) c[getDriverState(d)]++;
    return c;
  }, [drivers]);
  const driverStateLabels: Record<DriverState, string> = {
    idle: t('live_map.driver_idle', { defaultValue: 'Disponible' }),
    en_route: t('live_map.driver_en_route', { defaultValue: 'En camino' }),
    in_progress: t('live_map.driver_in_progress', { defaultValue: 'En viaje' }),
    on_break: t('live_map.driver_on_break', { defaultValue: 'En pausa' }),
  };
  const vehicleTypeLabels: Record<VehicleType, string> = {
    triciclo: t('drivers.type_triciclo', { defaultValue: 'Triciclo' }),
    moto: t('drivers.type_moto', { defaultValue: 'Moto' }),
    auto: t('drivers.type_auto', { defaultValue: 'Auto' }),
    confort: t('drivers.type_confort', { defaultValue: 'Confort' }),
  };

  // Shared popup for both driver marker kinds (vehicle badge / fallback dot).
  const renderDriverPopup = (d: OnlineFleetDriver, state: DriverState, color: string) => (
    <PopupDynamic>
      <div style={{ fontSize: '0.85rem', minWidth: 200 }}>
        <strong style={{ fontSize: '0.95rem' }}>{d.full_name}</strong>
        <div style={{ color: '#666', fontSize: '0.8rem', marginTop: 2 }}>{d.phone}</div>
        <hr style={{ margin: '8px 0', border: 0, borderTop: '1px solid #eee' }} />
        <div>
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: color,
              marginRight: 6,
            }}
          />
          <strong>{driverStateLabels[state]}</strong>
        </div>
        {d.vehicle_type && (
          <div style={{ marginTop: 6, color: '#444' }}>
            {vehicleTypeLabels[d.vehicle_type]}
            {d.vehicle_plate ? ` · ${d.vehicle_plate}` : ''}
          </div>
        )}
        {d.current_ride_id && (
          <div style={{ marginTop: 6 }}>
            Ride: <code style={{ fontSize: '0.75rem' }}>{d.current_ride_id.slice(0, 8)}…</code>
            <br />
            <a href={`/rides/${d.current_ride_id}`} style={{ color: 'var(--primary, #FF4D00)', fontSize: '0.8rem' }}>
              Ver viaje →
            </a>
          </div>
        )}
        <div style={{ marginTop: 6, fontSize: '0.75rem', color: '#888' }}>
          Heartbeat {formatRelative(d.last_heartbeat_at)}
        </div>
        <div style={{ marginTop: 6 }}>
          <a href={`/drivers/${d.driver_id}`} style={{ color: 'var(--primary, #FF4D00)', fontSize: '0.8rem' }}>
            Perfil conductor →
          </a>
        </div>
      </div>
    </PopupDynamic>
  );

  return (
    <div className="h-[calc(100vh-80px)] flex flex-col">
      {/* Header: title + layer toggles + per-layer filter chips */}
      <div className="px-4 py-3 border-b border-line space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-xl font-bold">
            {t('live_map.title', { defaultValue: 'Mapa en vivo' })}
          </h1>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Drivers layer toggle — solid dot icon doubles as legend */}
            <button
              onClick={() => setShowDrivers((v) => !v)}
              aria-pressed={showDrivers}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                showDrivers ? 'border-line bg-surface-sunken' : 'border-line opacity-50'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-white shadow-sm" />
              {t('live_map.layer_drivers', { defaultValue: 'Conductores' })} ({drivers.length})
            </button>
            {/* Rides layer toggle — hollow ring icon doubles as legend */}
            <button
              onClick={() => setShowRides((v) => !v)}
              aria-pressed={showRides}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                showRides ? 'border-line bg-surface-sunken' : 'border-line opacity-50'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full border-2 border-blue-500 bg-transparent" />
              {t('live_map.layer_rides', { defaultValue: 'Viajes' })} ({rides.length})
            </button>
          </div>
        </div>

        {/* Per-layer status filter chips */}
        {(showDrivers || showRides) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {showDrivers && DRIVER_STATES.map((s) => (
              <button
                key={`d-${s}`}
                onClick={() => setDriverFilter(driverFilter === s ? 'all' : s)}
                aria-pressed={driverFilter === s}
                aria-label={`${driverStateLabels[s]}: ${driverStateCounts[s]}`}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  driverFilter === s ? 'ring-2 ring-offset-1 ring-neutral-400' : ''
                }`}
                style={{ backgroundColor: `${STATE_COLORS[s]}20`, color: STATE_COLORS[s] }}
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STATE_COLORS[s] }} />
                {driverStateLabels[s]}: {driverStateCounts[s]}
              </button>
            ))}
            {showRides && ACTIVE_STATUSES.map((s) => (
              <button
                key={`r-${s}`}
                onClick={() => setRideFilter(rideFilter === s ? 'all' : s)}
                aria-pressed={rideFilter === s}
                aria-label={`${statusLabels[s]}: ${rideStatusCounts[s] ?? 0}`}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  rideFilter === s ? 'ring-2 ring-offset-1 ring-neutral-400' : ''
                }`}
                style={{ backgroundColor: `${STATUS_COLORS[s]}20`, color: STATUS_COLORS[s] }}
              >
                <span className="w-2 h-2 rounded-full border" style={{ borderColor: STATUS_COLORS[s] }} />
                {statusLabels[s]}: {rideStatusCounts[s] ?? 0}
              </button>
            ))}
          </div>
        )}

        {showDrivers && fleetUnavailable && (
          <p className="text-xs text-amber-600">
            {t('live_map.drivers_layer_unavailable', { defaultValue: 'Capa de conductores no disponible' })}
          </p>
        )}
      </div>

      {/* Map */}
      <div className="flex-1 relative">
        {typeof window !== 'undefined' && (
          <link
            rel="stylesheet"
            href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          />
        )}
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-ink-subtle">{t('common.loading')}</p>
          </div>
        ) : (
          <MapContainer
            center={INITIAL_CENTER}
            zoom={INITIAL_ZOOM}
            scrollWheelZoom
            style={{ height: '100%', width: '100%' }}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            />
            <MapZoomWatcherDynamic onZoomChange={handleZoomChange} />

            {/* Drivers — vehicle badge (ring = state color), or a plain
                solid dot when the vehicle type is unknown (no active
                vehicle row / enrichment failed). Both scale with zoom. */}
            {showDrivers && filteredDrivers.map((d) => {
              const state = getDriverState(d);
              const color = STATE_COLORS[state];
              return d.vehicle_type ? (
                <DriverVehicleMarkerDynamic
                  key={`driver-${d.driver_id}`}
                  lat={d.lat}
                  lng={d.lng}
                  vehicleType={d.vehicle_type}
                  color={color}
                  heading={d.current_heading}
                  size={markerSize}
                >
                  {renderDriverPopup(d, state, color)}
                </DriverVehicleMarkerDynamic>
              ) : (
                <CircleMarkerDynamic
                  key={`driver-${d.driver_id}`}
                  center={[d.lat, d.lng]}
                  radius={markerSize.badge / 2}
                  pathOptions={{ color: '#fff', weight: markerSize.border - 1, fillColor: color, fillOpacity: 0.95 }}
                >
                  {renderDriverPopup(d, state, color)}
                </CircleMarkerDynamic>
              );
            })}

            {/* Rides — hollow rings */}
            {showRides && filteredRides.map((ride) => {
              const pickup = parseLocation(ride.pickup_location);
              if (!pickup) return null;
              const color = STATUS_COLORS[ride.status] ?? '#999';
              return (
                <CircleMarkerDynamic
                  key={`ride-${ride.id}`}
                  center={[pickup.lat, pickup.lng]}
                  radius={7}
                  pathOptions={{ fillColor: color, color, weight: 3, fillOpacity: 0.15 }}
                >
                  <PopupDynamic>
                    <div className="text-xs">
                      <p className="font-bold">{statusLabels[ride.status] ?? ride.status}</p>
                      <p className="text-ink-muted mt-1">{ride.pickup_address ?? 'Pickup'}</p>
                      <p className="text-ink-muted">{ride.dropoff_address ?? 'Dropoff'}</p>
                      <p className="text-ink-subtle mt-1">{ride.service_type}</p>
                    </div>
                  </PopupDynamic>
                </CircleMarkerDynamic>
              );
            })}
          </MapContainer>
        )}
      </div>

      {/* Bottom panel — rides table (when rides layer on) / driver count */}
      <div className="h-48 border-t border-line overflow-y-auto bg-surface-elevated">
        <div className="px-4 py-2">
          <p className="text-xs font-semibold text-ink-muted">
            {showRides
              ? `${t('live_map.active_rides', { defaultValue: 'Viajes activos' })}: ${filteredRides.length}`
              : `${t('live_map.layer_drivers', { defaultValue: 'Conductores' })}: ${filteredDrivers.length}`}
          </p>
        </div>
        {showRides ? (
          filteredRides.length === 0 ? (
            <p className="px-4 py-2 text-sm text-ink-subtle">
              {t('live_map.no_active_rides', { defaultValue: 'No hay viajes activos' })}
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left px-4 py-2 font-semibold text-ink-muted">{t('rides.col_status')}</th>
                  <th className="text-left px-4 py-2 font-semibold text-ink-muted">{t('rides.col_route')}</th>
                  <th className="text-left px-4 py-2 font-semibold text-ink-muted">{t('rides.col_fare')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRides.map((ride) => (
                  <tr key={ride.id} className="border-b border-line hover:bg-surface-sunken">
                    <td className="px-4 py-2">
                      <span
                        className="inline-block px-2 py-0.5 rounded-full text-xs font-medium"
                        style={{
                          backgroundColor: `${STATUS_COLORS[ride.status] ?? '#999'}20`,
                          color: STATUS_COLORS[ride.status] ?? '#999',
                        }}
                      >
                        {statusLabels[ride.status] ?? ride.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-ink-muted max-w-xs truncate">
                      {ride.pickup_address ?? '?'} → {ride.dropoff_address ?? '?'}
                    </td>
                    <td className="px-4 py-2 text-ink-muted">
                      {ride.estimated_fare_cup ? `${ride.estimated_fare_cup.toLocaleString('es-CU')} CUP` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <p className="px-4 py-2 text-sm text-ink-subtle">
            {t('live_map.rides_layer_hidden', { defaultValue: 'Capa de viajes oculta' })}
          </p>
        )}
      </div>
    </div>
  );
}
