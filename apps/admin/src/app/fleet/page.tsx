'use client';

// ============================================================
// TriciGo Admin — /admin/fleet — Live driver fleet overview
//                 (PR-MAP-1, closes Gap A from driver rendering audit)
//
// What the existing /admin/live-map doesn't show: this page renders
// every driver currently online + approved + with a location, color-
// coded by their state (idle / en route / in progress / on break).
// Updates live via Supabase realtime subscription to driver_profiles
// UPDATE events. Polls every 30s as fallback.
//
// Stack: react-leaflet (same as /admin/live-map for consistency, not
// Mapbox-gl-js). Lower bundle, no new dependencies.
//
// RPC: admin_get_online_fleet() — see supabase/migrations/00339_*.sql
// ============================================================

import { useEffect, useState, useRef, useMemo } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { adminService, getSupabaseClient } from '@tricigo/api';
import type { OnlineFleetDriver } from '@tricigo/types';
import dynamic from 'next/dynamic';

// react-leaflet must be SSR-disabled (Leaflet touches `window`).
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

// Color per driver state (matches /admin/live-map palette but for
// driver states not ride statuses).
const STATE_COLORS = {
  in_progress: '#F97316',   // orange — ride en curso
  en_route: '#EAB308',      // yellow — yendo al pickup o aceptado
  on_break: '#9CA3AF',      // gray — pausa
  idle: '#22C55E',          // green — online sin ride
};

const STATE_LABELS = {
  in_progress: 'En viaje',
  en_route: 'En camino al pasajero',
  on_break: 'En pausa',
  idle: 'Disponible',
};

function getDriverState(d: OnlineFleetDriver): keyof typeof STATE_COLORS {
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

export default function FleetPage() {
  const { t } = useTranslation('admin');
  const [drivers, setDrivers] = useState<OnlineFleetDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | keyof typeof STATE_COLORS>('all');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchFleet = async () => {
    try {
      const data = await adminService.getOnlineFleet();
      setDrivers(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar la flota');
    } finally {
      setLoading(false);
    }
  };

  // Initial load + 30s fallback polling
  useEffect(() => {
    fetchFleet();
    pollRef.current = setInterval(fetchFleet, 30_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Realtime subscription — updates the fleet within ~1s when a driver
  // changes is_online, position, or status. Uses driver_profiles
  // UPDATE channel (same pattern as nearbyService.subscribeToDriverPositions
  // in packages/api/src/services/nearby.service.ts:46). On any change,
  // refetch the full list (cheap — at most ~9 drivers right now in prod).
  useEffect(() => {
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel('admin-fleet-overview')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'driver_profiles',
        },
        () => {
          // Debounce: refetch once for any change. Could be optimized
          // with payload-merge but the fleet is small enough.
          fetchFleet();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const counts = useMemo(() => {
    const c = { all: drivers.length, in_progress: 0, en_route: 0, on_break: 0, idle: 0 };
    for (const d of drivers) c[getDriverState(d)]++;
    return c;
  }, [drivers]);

  const filteredDrivers = useMemo(() => {
    if (filter === 'all') return drivers;
    return drivers.filter((d) => getDriverState(d) === filter);
  }, [drivers, filter]);

  // Map center on Cuba (Cuba_CENTER = 21.5, -79.5; zoom 7 covers all 16 provinces)
  const center: [number, number] = [21.5, -79.5];

  return (
    <div style={{ padding: '1.5rem' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1
          style={{
            fontSize: '1.75rem',
            fontWeight: 800,
            color: 'var(--text-primary)',
            marginBottom: '0.25rem',
          }}
        >
          {t('fleet.title', { defaultValue: 'Flota en vivo' })}
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
          {t('fleet.subtitle', {
            defaultValue:
              'Mapa de conductores online aprobados con ubicación. Actualiza en tiempo real.',
          })}
        </p>
      </header>

      {/* Counters / filter chips */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '1rem',
        }}
      >
        <FilterChip
          active={filter === 'all'}
          onClick={() => setFilter('all')}
          color="#0F172A"
          label={`Todos (${counts.all})`}
        />
        <FilterChip
          active={filter === 'idle'}
          onClick={() => setFilter('idle')}
          color={STATE_COLORS.idle}
          label={`${STATE_LABELS.idle} (${counts.idle})`}
        />
        <FilterChip
          active={filter === 'en_route'}
          onClick={() => setFilter('en_route')}
          color={STATE_COLORS.en_route}
          label={`${STATE_LABELS.en_route} (${counts.en_route})`}
        />
        <FilterChip
          active={filter === 'in_progress'}
          onClick={() => setFilter('in_progress')}
          color={STATE_COLORS.in_progress}
          label={`${STATE_LABELS.in_progress} (${counts.in_progress})`}
        />
        <FilterChip
          active={filter === 'on_break'}
          onClick={() => setFilter('on_break')}
          color={STATE_COLORS.on_break}
          label={`${STATE_LABELS.on_break} (${counts.on_break})`}
        />
      </div>

      {loading && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Cargando flota…
        </div>
      )}

      {error && !loading && (
        <div
          style={{
            padding: '0.75rem 1rem',
            background: '#fee',
            color: '#c00',
            borderRadius: '0.5rem',
            marginBottom: '1rem',
            fontSize: '0.875rem',
          }}
        >
          {error}
        </div>
      )}

      {!loading && drivers.length === 0 && !error && (
        <div
          style={{
            padding: '3rem 2rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-light)',
            borderRadius: '0.75rem',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>📭</div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 0.25rem' }}>
            No hay conductores online ahora mismo
          </h2>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            La página se actualiza en vivo. Cuando un conductor se conecte aparecerá aquí.
          </p>
        </div>
      )}

      {/* Map */}
      {!loading && (
        <div
          style={{
            height: 600,
            borderRadius: '0.75rem',
            overflow: 'hidden',
            border: '1px solid var(--border-light)',
          }}
        >
          <MapContainer
            center={center}
            zoom={7}
            scrollWheelZoom
            style={{ height: '100%', width: '100%' }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {filteredDrivers.map((d) => {
              const state = getDriverState(d);
              const color = STATE_COLORS[state];
              return (
                <CircleMarkerDynamic
                  key={d.driver_id}
                  center={[d.lat, d.lng]}
                  radius={10}
                  pathOptions={{
                    color: '#fff',
                    weight: 2,
                    fillColor: color,
                    fillOpacity: 0.9,
                  }}
                >
                  <PopupDynamic>
                    <div style={{ fontSize: '0.85rem', minWidth: 200 }}>
                      <strong style={{ fontSize: '0.95rem' }}>{d.full_name}</strong>
                      <div style={{ color: '#666', fontSize: '0.8rem', marginTop: 2 }}>
                        {d.phone}
                      </div>
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
                        <strong>{STATE_LABELS[state]}</strong>
                      </div>
                      {d.current_ride_id && (
                        <div style={{ marginTop: 6 }}>
                          Ride: <code style={{ fontSize: '0.75rem' }}>{d.current_ride_id.slice(0, 8)}…</code>
                          <br />
                          <a
                            href={`/rides/${d.current_ride_id}`}
                            style={{ color: 'var(--primary, #FF4D00)', fontSize: '0.8rem' }}
                          >
                            Ver viaje →
                          </a>
                        </div>
                      )}
                      <div style={{ marginTop: 6, fontSize: '0.75rem', color: '#888' }}>
                        Heartbeat {formatRelative(d.last_heartbeat_at)}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <a
                          href={`/drivers/${d.driver_id}`}
                          style={{ color: 'var(--primary, #FF4D00)', fontSize: '0.8rem' }}
                        >
                          Perfil conductor →
                        </a>
                      </div>
                    </div>
                  </PopupDynamic>
                </CircleMarkerDynamic>
              );
            })}
          </MapContainer>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  color,
  label,
}: {
  active: boolean;
  onClick: () => void;
  color: string;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.4rem 0.85rem',
        borderRadius: '999px',
        fontSize: '0.82rem',
        fontWeight: 600,
        cursor: 'pointer',
        background: active ? color : 'transparent',
        color: active ? '#fff' : 'var(--text-primary)',
        border: `1px solid ${active ? color : 'var(--border-light)'}`,
        display: 'flex',
        alignItems: 'center',
        gap: '0.4rem',
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
        }}
      />
      {label}
    </button>
  );
}
