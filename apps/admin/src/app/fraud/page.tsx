'use client';

import { useEffect, useState } from 'react';
import { fraudService } from '@tricigo/api';
import type { FraudAlert } from '@tricigo/types';
import { useAdminUser } from '@/lib/useAdminUser';

const severityBadge: Record<string, string> = {
  low: 'bg-blue-50 text-blue-700',
  medium: 'bg-yellow-50 text-yellow-700',
  high: 'bg-orange-50 text-orange-700',
  critical: 'bg-red-50 text-red-700',
};

const alertTypeLabels: Record<string, string> = {
  unusual_transfer: 'Transferencias inusuales',
  rapid_recharges: 'Recargas rápidas',
  suspicious_cancellations: 'Cancelaciones sospechosas',
  velocity_anomaly: 'Anomalía de velocidad',
};

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('es-CU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function FraudAlertsPage() {
  const { userId: adminUserId } = useAdminUser();
  const [alerts, setAlerts] = useState<FraudAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'unresolved' | 'all'>('unresolved');
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [showResolveModal, setShowResolveModal] = useState<string | null>(null);

  const fetchAlerts = async () => {
    setLoading(true);
    try {
      const data = await fraudService.getFraudAlerts({
        resolved: filter === 'unresolved' ? false : undefined,
        limit: 100,
      });
      setAlerts(data);
    } catch (err) {
      console.error('Error fetching alerts:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAlerts();
  }, [filter]);

  const handleResolve = async (alertId: string) => {
    setResolving(alertId);
    try {
      await fraudService.resolveAlert(alertId, adminUserId, resolutionNote || undefined);
      setAlerts((prev) =>
        prev.map((a) => (a.id === alertId ? { ...a, resolved: true, resolved_at: new Date().toISOString() } : a)),
      );
      setShowResolveModal(null);
      setResolutionNote('');
    } catch (err) {
      console.error('Error resolving alert:', err);
    } finally {
      setResolving(null);
    }
  };

  const unresolvedCount = alerts.filter((a) => !a.resolved).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Alertas de fraude</h1>
          {unresolvedCount > 0 && (
            <p className="text-sm text-red-500 mt-1">{unresolvedCount} alertas sin resolver</p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setFilter('unresolved')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === 'unresolved'
                ? 'bg-[#FF4D00] text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            Sin resolver
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === 'all'
                ? 'bg-[#FF4D00] text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            Todas
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Fecha</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Tipo</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Severidad</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Detalles</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Estado</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {alerts.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-neutral-400">
                  {loading ? 'Cargando...' : 'Sin alertas'}
                </td>
              </tr>
            ) : (
              alerts.map((alert) => (
                <tr key={alert.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                  <td className="px-4 py-3 text-neutral-600 text-xs">
                    {formatDate(alert.created_at)}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {alertTypeLabels[alert.alert_type] ?? alert.alert_type}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                      severityBadge[alert.severity] ?? 'bg-neutral-100 text-neutral-600'
                    }`}>
                      {alert.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-neutral-500 max-w-xs truncate">
                    {alert.details ? JSON.stringify(alert.details) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                      alert.resolved
                        ? 'bg-green-50 text-green-700'
                        : 'bg-red-50 text-red-700'
                    }`}>
                      {alert.resolved ? 'Resuelto' : 'Pendiente'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {!alert.resolved && (
                      <button
                        onClick={() => setShowResolveModal(alert.id)}
                        className="text-sm text-[#FF4D00] hover:underline"
                      >
                        Resolver
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Resolve modal */}
      {showResolveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-bold mb-4">Resolver alerta</h3>
            <textarea
              className="w-full border border-neutral-200 rounded-lg p-3 text-sm focus:outline-none focus:border-[#FF4D00]"
              rows={3}
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
              placeholder="Nota de resolución (opcional)..."
            />
            <div className="flex gap-3 mt-4 justify-end">
              <button
                onClick={() => {
                  setShowResolveModal(null);
                  setResolutionNote('');
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={() => handleResolve(showResolveModal)}
                disabled={resolving === showResolveModal}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-[#FF4D00] text-white hover:bg-[#e04400] transition-colors disabled:opacity-50"
              >
                {resolving ? 'Resolviendo...' : 'Marcar como resuelto'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
