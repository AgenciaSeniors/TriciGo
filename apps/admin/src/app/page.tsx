'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import type { Ride, DriverProfileWithUser } from '@tricigo/types';

type DashboardMetrics = {
  active_rides: number;
  total_rides_today: number;
  online_drivers: number;
  total_revenue_today: number;
  pending_verifications: number;
  open_incidents: number;
};

const STATUS_BADGE: Record<string, string> = {
  searching: 'bg-yellow-100 text-yellow-700',
  accepted: 'bg-blue-100 text-blue-700',
  driver_en_route: 'bg-blue-100 text-blue-700',
  arrived_at_pickup: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  canceled: 'bg-red-100 text-red-700',
  disputed: 'bg-orange-100 text-orange-700',
};

const STATUS_LABEL: Record<string, string> = {
  searching: 'Buscando',
  accepted: 'Aceptado',
  driver_en_route: 'En camino',
  arrived_at_pickup: 'En punto',
  in_progress: 'En progreso',
  completed: 'Completado',
  canceled: 'Cancelado',
  disputed: 'En disputa',
};

function truncate(str: string, len: number) {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [recentRides, setRecentRides] = useState<Ride[]>([]);
  const [pendingDrivers, setPendingDrivers] = useState<DriverProfileWithUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchDashboard() {
      try {
        const [metricsData, rides, drivers] = await Promise.all([
          adminService.getDashboardMetrics(),
          adminService.getRides({}, 0, 5),
          adminService.getDriversByStatus('pending_verification', 0, 5),
        ]);
        if (!cancelled) {
          setMetrics(metricsData);
          setRecentRides(rides);
          setPendingDrivers(drivers);
        }
      } catch (err) {
        console.error('Error fetching dashboard:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDashboard();

    const interval = setInterval(fetchDashboard, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const stats = [
    { label: 'Viajes activos', value: metrics?.active_rides ?? 0, color: 'text-[#FF4D00]', format: 'number' as const },
    { label: 'Viajes hoy', value: metrics?.total_rides_today ?? 0, color: 'text-neutral-900', format: 'number' as const },
    { label: 'Conductores en línea', value: metrics?.online_drivers ?? 0, color: 'text-green-600', format: 'number' as const },
    { label: 'Ingresos hoy', value: metrics?.total_revenue_today ?? 0, color: 'text-[#FF4D00]', format: 'cup' as const },
    { label: 'Verificaciones pendientes', value: metrics?.pending_verifications ?? 0, color: 'text-yellow-600', format: 'number' as const },
    { label: 'Incidentes abiertos', value: metrics?.open_incidents ?? 0, color: 'text-red-600', format: 'number' as const },
  ];

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Dashboard</h1>

      {/* Metric cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100"
          >
            <p className="text-sm text-neutral-500 mb-1">{stat.label}</p>
            <p className={`text-3xl font-bold ${stat.color}`}>
              {loading ? '—' : stat.format === 'cup' ? formatCUP(stat.value) : stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Bottom section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent rides */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
          <h2 className="text-lg font-bold mb-4">Viajes recientes</h2>
          {recentRides.length === 0 ? (
            <p className="text-neutral-400">Sin viajes recientes</p>
          ) : (
            <div className="space-y-3">
              {recentRides.map((ride) => (
                <div key={ride.id} className="flex items-center justify-between py-2 border-b border-neutral-50 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-neutral-900 truncate">{truncate(ride.pickup_address, 30)}</p>
                    <p className="text-xs text-neutral-500">→ {truncate(ride.dropoff_address, 30)}</p>
                  </div>
                  <span className={`ml-3 inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[ride.status] ?? 'bg-neutral-100 text-neutral-700'}`}>
                    {STATUS_LABEL[ride.status] ?? ride.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pending drivers */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
          <h2 className="text-lg font-bold mb-4">Conductores pendientes</h2>
          {pendingDrivers.length === 0 ? (
            <p className="text-neutral-400">Sin verificaciones pendientes</p>
          ) : (
            <div className="space-y-3">
              {pendingDrivers.map((driver) => (
                <div key={driver.id} className="flex items-center justify-between py-2 border-b border-neutral-50 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-neutral-900">
                      {(driver as unknown as { users: { full_name: string } }).users?.full_name ?? 'Sin nombre'}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {(driver as unknown as { users: { phone: string } }).users?.phone ?? ''}
                    </p>
                  </div>
                  <a
                    href={`/drivers/${driver.id}`}
                    className="text-sm text-[#FF4D00] hover:underline"
                  >
                    Ver detalle
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
