'use client';

import { useEffect, useState, useRef } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { adminService } from '@tricigo/api';
import type { Ride } from '@tricigo/types';
import dynamic from 'next/dynamic';

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

const STATUS_COLORS: Record<string, string> = {
  searching: '#EAB308',     // yellow
  accepted: '#3B82F6',      // blue
  driver_en_route: '#3B82F6',
  arrived_at_pickup: '#8B5CF6', // purple
  in_progress: '#22C55E',   // green
};

const ACTIVE_STATUSES = ['searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress'];

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

export default function LiveMapPage() {
  const { t } = useTranslation('admin');
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRides = async () => {
    try {
      // Fetch all rides and filter for active statuses
      const allRides: Ride[] = [];
      for (const status of ACTIVE_STATUSES) {
        try {
          const statusRides = await adminService.getRides({ status }, 0, 100);
          allRides.push(...statusRides);
        } catch { /* ignore individual status errors */ }
      }
      setRides(allRides);
    } catch (err) {
      console.error('Error fetching rides:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRides();
    // Refresh every 30 seconds
    intervalRef.current = setInterval(fetchRides, 30000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const filteredRides = filter === 'all'
    ? rides
    : rides.filter((r) => r.status === filter);

  const statusCounts = ACTIVE_STATUSES.reduce((acc, s) => {
    acc[s] = rides.filter((r) => r.status === s).length;
    return acc;
  }, {} as Record<string, number>);

  const statusLabels: Record<string, string> = {
    searching: t('dashboard.status_searching', { defaultValue: 'Buscando' }),
    accepted: t('dashboard.status_accepted', { defaultValue: 'Aceptado' }),
    driver_en_route: t('dashboard.status_driver_en_route', { defaultValue: 'En camino' }),
    arrived_at_pickup: t('dashboard.status_arrived_at_pickup', { defaultValue: 'En punto' }),
    in_progress: t('dashboard.status_in_progress', { defaultValue: 'En progreso' }),
  };

  return (
    <div className="h-[calc(100vh-80px)] flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-100">
        <h1 className="text-xl font-bold">
          {t('live_map.title', { defaultValue: 'Mapa en vivo' })}
        </h1>
        <div className="flex items-center gap-3">
          {/* Status counters */}
          {ACTIVE_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(filter === s ? 'all' : s)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                filter === s ? 'ring-2 ring-offset-1 ring-neutral-400' : ''
              }`}
              style={{
                backgroundColor: `${STATUS_COLORS[s]}20`,
                color: STATUS_COLORS[s],
              }}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STATUS_COLORS[s] }} />
              {statusLabels[s]}: {statusCounts[s] ?? 0}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 relative">
        {typeof window !== 'undefined' && (
          <link
            rel="stylesheet"
            href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          />
        )}
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-neutral-400">{t('common.loading')}</p>
          </div>
        ) : (
          <MapContainer
            center={[23.1136, -82.3666]}
            zoom={13}
            style={{ height: '100%', width: '100%' }}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; OpenStreetMap'
            />
            {filteredRides.map((ride) => {
              const pickup = parseLocation(ride.pickup_location);
              if (!pickup) return null;

              return (
                <CircleMarkerDynamic
                  key={ride.id}
                  center={[pickup.lat, pickup.lng]}
                  radius={8}
                  pathOptions={{
                    fillColor: STATUS_COLORS[ride.status] ?? '#999',
                    color: '#fff',
                    weight: 2,
                    fillOpacity: 0.9,
                  }}
                >
                  <PopupDynamic>
                    <div className="text-xs">
                      <p className="font-bold">{statusLabels[ride.status] ?? ride.status}</p>
                      <p className="text-neutral-500 mt-1">{ride.pickup_address ?? 'Pickup'}</p>
                      <p className="text-neutral-500">{ride.dropoff_address ?? 'Dropoff'}</p>
                      <p className="text-neutral-400 mt-1">{ride.service_type}</p>
                    </div>
                  </PopupDynamic>
                </CircleMarkerDynamic>
              );
            })}
          </MapContainer>
        )}
      </div>

      {/* Ride list sidebar */}
      <div className="h-48 border-t border-neutral-100 overflow-y-auto bg-white">
        <div className="px-4 py-2">
          <p className="text-xs font-semibold text-neutral-500">
            {t('live_map.active_rides', { defaultValue: 'Viajes activos' })}: {filteredRides.length}
          </p>
        </div>
        {filteredRides.length === 0 ? (
          <p className="px-4 py-2 text-sm text-neutral-400">
            {t('live_map.no_active_rides', { defaultValue: 'No hay viajes activos' })}
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-neutral-100">
                <th className="text-left px-4 py-2 font-semibold text-neutral-500">{t('rides.col_status')}</th>
                <th className="text-left px-4 py-2 font-semibold text-neutral-500">{t('rides.col_route')}</th>
                <th className="text-left px-4 py-2 font-semibold text-neutral-500">{t('rides.col_fare')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredRides.map((ride) => (
                <tr key={ride.id} className="border-b border-neutral-50 hover:bg-neutral-50">
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
                  <td className="px-4 py-2 text-neutral-600 max-w-xs truncate">
                    {ride.pickup_address ?? '?'} → {ride.dropoff_address ?? '?'}
                  </td>
                  <td className="px-4 py-2 text-neutral-600">
                    {ride.estimated_fare_cup ? `${(ride.estimated_fare_cup / 100).toFixed(0)} CUP` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
