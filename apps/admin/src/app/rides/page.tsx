'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import type { Ride, RideStatus } from '@tricigo/types';

const PAGE_SIZE = 20;

const STATUS_FILTERS = [
  { label: 'Todos', value: 'all' },
  { label: 'Buscando', value: 'searching' },
  { label: 'Aceptados', value: 'accepted' },
  { label: 'En progreso', value: 'in_progress' },
  { label: 'Completados', value: 'completed' },
  { label: 'Cancelados', value: 'canceled' },
  { label: 'En disputa', value: 'disputed' },
] as const;

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

export default function RidesPage() {
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchRides() {
      try {
        const filters = statusFilter === 'all' ? {} : { status: statusFilter };
        const data = await adminService.getRides(filters, page, PAGE_SIZE);
        if (!cancelled) setRides(data);
      } catch (err) {
        console.error('Error fetching rides:', err);
        if (!cancelled) setRides([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchRides();
    return () => { cancelled = true; };
  }, [page, statusFilter]);

  const canGoPrev = page > 0;
  const canGoNext = rides.length === PAGE_SIZE;

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Viajes</h1>

      {/* Status filter tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => { setStatusFilter(filter.value); setPage(0); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === filter.value
                ? 'bg-[#FF4D00] text-white'
                : 'bg-white text-neutral-600 border border-neutral-200 hover:border-neutral-300'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Origen → Destino</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Estado</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Tarifa</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Distancia</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Pago</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Fecha</th>
            </tr>
          </thead>
          <tbody>
            {rides.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-neutral-400">
                  {loading ? 'Cargando...' : 'No hay viajes registrados'}
                </td>
              </tr>
            ) : (
              rides.map((ride) => (
                <tr key={ride.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    <div className="text-neutral-900">{truncate(ride.pickup_address, 25)}</div>
                    <div className="text-neutral-500 text-xs">→ {truncate(ride.dropoff_address, 25)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[ride.status] ?? 'bg-neutral-100 text-neutral-700'}`}>
                      {STATUS_LABEL[ride.status] ?? ride.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {ride.final_fare_cup != null ? (
                      <>
                        <span>{formatCUP(ride.final_fare_cup)}</span>
                        {ride.final_fare_cup !== ride.estimated_fare_cup && (
                          <span className="text-xs text-neutral-400 ml-1 line-through">
                            {formatCUP(ride.estimated_fare_cup)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-neutral-400">{formatCUP(ride.estimated_fare_cup)} (est.)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {ride.actual_distance_m != null
                      ? `${(ride.actual_distance_m / 1000).toFixed(1)} km`
                      : ride.estimated_distance_m > 0
                        ? <span className="text-neutral-400">{(ride.estimated_distance_m / 1000).toFixed(1)} km (est.)</span>
                        : '—'}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {ride.payment_method === 'cash' ? 'Efectivo' : 'TriciCoin'}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {new Date(ride.created_at).toLocaleDateString('es-CU', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4">
        <button
          onClick={() => setPage((p) => p - 1)}
          disabled={!canGoPrev}
          className="px-4 py-2 rounded-lg text-sm border border-neutral-200 disabled:opacity-30"
        >
          Anterior
        </button>
        <span className="text-sm text-neutral-500">
          Página <strong>{page + 1}</strong>
        </span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={!canGoNext}
          className="px-4 py-2 rounded-lg text-sm border border-neutral-200 disabled:opacity-30"
        >
          Siguiente
        </button>
      </div>
    </div>
  );
}
