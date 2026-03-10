'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@tricigo/api/services/admin';
import type { AdminAction } from '@tricigo/types';

const PAGE_SIZE = 20;

function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString('es-CU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const ACTION_LABELS: Record<string, string> = {
  approve_driver: 'Aprobar conductor',
  reject_driver: 'Rechazar conductor',
  suspend_driver: 'Suspender conductor',
  approve_redemption: 'Aprobar canje',
  reject_redemption: 'Rechazar canje',
  approve_recharge: 'Aprobar recarga',
  reject_recharge: 'Rechazar recarga',
  incident_investigating: 'Investigar incidente',
  incident_resolved: 'Resolver incidente',
};

const TARGET_LABELS: Record<string, string> = {
  driver_profile: 'Conductor',
  wallet_redemption: 'Canje wallet',
  wallet_recharge_request: 'Recarga wallet',
  incident_report: 'Incidente',
};

export default function AuditPage() {
  const [actions, setActions] = useState<AdminAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function fetchActions() {
      setLoading(true);
      try {
        const filters: { dateFrom?: string; dateTo?: string } = {};
        if (dateFrom) filters.dateFrom = dateFrom;
        if (dateTo) filters.dateTo = dateTo;

        const data = await adminService.getAdminActions(page, PAGE_SIZE, filters);
        if (!cancelled) {
          setActions(data);
        }
      } catch (err) {
        console.error('Error fetching admin actions:', err);
        if (!cancelled) {
          setActions([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchActions();
    return () => {
      cancelled = true;
    };
  }, [page, dateFrom, dateTo]);

  const canGoPrev = page > 0;
  const canGoNext = actions.length === PAGE_SIZE;

  function handleClearFilter() {
    setDateFrom('');
    setDateTo('');
    setPage(0);
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Auditoría</h1>

      {/* Date range filters */}
      <div className="flex flex-wrap items-end gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-neutral-600 mb-1">
            Desde
          </label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(0);
            }}
            className="px-3 py-2 rounded-lg border border-neutral-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#FF4D00]/30 focus:border-[#FF4D00]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-neutral-600 mb-1">
            Hasta
          </label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(0);
            }}
            className="px-3 py-2 rounded-lg border border-neutral-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#FF4D00]/30 focus:border-[#FF4D00]"
          />
        </div>
        {(dateFrom || dateTo) && (
          <button
            onClick={handleClearFilter}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition-colors"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {/* Actions table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-100">
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">
                Fecha
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">
                Admin
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">
                Acción
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">
                Objetivo
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">
                Detalles
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={5}
                  className="text-center py-12 text-neutral-400"
                >
                  Cargando...
                </td>
              </tr>
            ) : actions.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="text-center py-12 text-neutral-400"
                >
                  No hay acciones registradas
                </td>
              </tr>
            ) : (
              actions.map((action) => (
                <tr
                  key={action.id}
                  className="border-b border-neutral-50 hover:bg-neutral-50/50 transition-colors"
                >
                  <td className="px-6 py-4 text-sm text-neutral-600">
                    {formatDateTime(action.created_at)}
                  </td>
                  <td className="px-6 py-4 text-sm text-neutral-600 font-mono">
                    {action.admin_id.slice(0, 8)}...
                  </td>
                  <td className="px-6 py-4">
                    <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                      {ACTION_LABELS[action.action] ?? action.action}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-neutral-600">
                    <span className="text-neutral-500">
                      {TARGET_LABELS[action.target_type] ?? action.target_type}
                    </span>
                    {action.target_id && (
                      <span className="ml-1 font-mono text-xs text-neutral-400">
                        {action.target_id.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-neutral-500">
                    {action.reason ? (
                      <span title={action.reason}>
                        {action.reason.length > 40
                          ? action.reason.slice(0, 40) + '...'
                          : action.reason}
                      </span>
                    ) : (
                      <span className="text-neutral-300">—</span>
                    )}
                  </td>
                </tr>
              ))
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
        <span className="text-sm text-neutral-500">
          Página {page + 1}
        </span>
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
