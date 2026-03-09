'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api';
import type { DriverProfileWithUser } from '@tricigo/types';
import type { DriverStatus } from '@tricigo/types';

const PAGE_SIZE = 20;

type StatusFilter = DriverStatus | 'all';

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'Todos', value: 'all' },
  { label: 'Pendientes', value: 'pending_verification' },
  { label: 'En revisión', value: 'under_review' },
  { label: 'Aprobados', value: 'approved' },
  { label: 'Rechazados', value: 'rejected' },
  { label: 'Suspendidos', value: 'suspended' },
];

const statusBadgeClasses: Record<DriverStatus, string> = {
  pending_verification: 'bg-yellow-50 text-yellow-700',
  under_review: 'bg-blue-50 text-blue-700',
  approved: 'bg-green-50 text-green-700',
  rejected: 'bg-red-50 text-red-700',
  suspended: 'bg-orange-50 text-orange-700',
};

const statusLabels: Record<DriverStatus, string> = {
  pending_verification: 'Pendiente',
  under_review: 'En revisión',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  suspended: 'Suspendido',
};

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('es-CU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function DriversPage() {
  const [drivers, setDrivers] = useState<DriverProfileWithUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    let cancelled = false;

    async function fetchDrivers() {
      setLoading(true);
      try {
        const data =
          statusFilter === 'all'
            ? await adminService.getAllDrivers(page, PAGE_SIZE)
            : await adminService.getDriversByStatus(statusFilter, page, PAGE_SIZE);
        if (!cancelled) setDrivers(data);
      } catch (err) {
        console.error('Error fetching drivers:', err);
        if (!cancelled) setDrivers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDrivers();
    return () => {
      cancelled = true;
    };
  }, [page, statusFilter]);

  const canGoPrev = page > 0;
  const canGoNext = drivers.length === PAGE_SIZE;

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Conductores</h1>

      {/* Status filter tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => {
              setStatusFilter(filter.value);
              setPage(0);
            }}
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

      {/* Drivers table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-100">
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Nombre</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Teléfono</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Vehículo</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Estado</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Rating</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Registro</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-neutral-400">
                  Cargando...
                </td>
              </tr>
            ) : drivers.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-neutral-400">
                  No hay conductores registrados aún
                </td>
              </tr>
            ) : (
              drivers.map((driver) => {
                const vehicle = driver.vehicles?.[0];
                return (
                  <tr
                    key={driver.id}
                    className="border-b border-neutral-50 hover:bg-neutral-50/50 transition-colors"
                  >
                    <td className="px-6 py-4 text-sm text-neutral-900 font-medium">
                      {driver.users.full_name || '—'}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600">
                      {driver.users.phone}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600">
                      {vehicle ? `${vehicle.type} — ${vehicle.plate_number}` : '—'}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          statusBadgeClasses[driver.status]
                        }`}
                      >
                        {statusLabels[driver.status]}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600">
                      {Number(driver.rating_avg).toFixed(1)}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600">
                      {formatDate(driver.created_at)}
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        href={`/drivers/${driver.id}`}
                        className="text-sm font-medium text-[#FF4D00] hover:text-[#e04400] transition-colors"
                      >
                        Ver detalle
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-6">
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={!canGoPrev}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            canGoPrev
              ? 'bg-white text-neutral-700 border border-neutral-200 hover:border-neutral-300'
              : 'bg-neutral-50 text-neutral-300 border border-neutral-100 cursor-not-allowed'
          }`}
        >
          Anterior
        </button>
        <span className="text-sm text-neutral-500">Página {page + 1}</span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={!canGoNext}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            canGoNext
              ? 'bg-white text-neutral-700 border border-neutral-200 hover:border-neutral-300'
              : 'bg-neutral-50 text-neutral-300 border border-neutral-100 cursor-not-allowed'
          }`}
        >
          Siguiente
        </button>
      </div>
    </div>
  );
}
