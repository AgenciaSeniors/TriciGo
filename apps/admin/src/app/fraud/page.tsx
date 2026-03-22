'use client';

import { useEffect, useState } from 'react';
import { fraudService } from '@tricigo/api';
import type { FraudAlert } from '@tricigo/types';
import { useTranslation } from '@tricigo/i18n';
import { useAdminUser } from '@/lib/useAdminUser';
import { formatAdminDate } from '@/lib/formatDate';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { AdminEmptyState } from '@/components/ui/AdminEmptyState';

const severityBadge: Record<string, string> = {
  low: 'bg-blue-50 text-blue-700',
  medium: 'bg-yellow-50 text-yellow-700',
  high: 'bg-orange-50 text-orange-700',
  critical: 'bg-red-50 text-red-700',
};


export default function FraudAlertsPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [alerts, setAlerts] = useState<FraudAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'unresolved' | 'all'>('unresolved');
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [showResolveModal, setShowResolveModal] = useState<string | null>(null);

  const getAlertTypeLabel = (type: string) => {
    const key = `fraud.type_${type}`;
    return t(key, { defaultValue: type });
  };

  const fetchAlerts = async () => {
    setLoading(true);
    try {
      const data = await fraudService.getFraudAlerts({
        resolved: filter === 'unresolved' ? false : undefined,
        limit: 100,
      });
      setAlerts(data);
    } catch (err) {
      // Error handled by UI
      setError(err instanceof Error ? err.message : 'Error al cargar alertas de fraude');
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
      // Error handled by UI
    } finally {
      setResolving(null);
    }
  };

  const unresolvedCount = alerts.filter((a) => !a.resolved).length;

  return (
    <div>
      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); fetchAlerts(); }}
          onDismiss={() => setError(null)}
        />
      )}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{t('fraud.title')}</h1>
          {unresolvedCount > 0 && (
            <p className="text-sm text-red-500 mt-1">{t('fraud.unresolved_count', { count: unresolvedCount })}</p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setFilter('unresolved')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === 'unresolved'
                ? 'bg-primary-500 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {t('fraud.filter_unresolved')}
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === 'all'
                ? 'bg-primary-500 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {t('fraud.filter_all')}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap hidden lg:table-cell">{t('fraud.col_date')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('fraud.col_type')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('fraud.col_severity')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap hidden lg:table-cell">{t('fraud.col_details')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('fraud.col_status')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('fraud.col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-0 py-0">
                  <AdminTableSkeleton rows={5} columns={6} />
                </td>
              </tr>
            ) : alerts.length === 0 ? (
              <tr>
                <td colSpan={6}><AdminEmptyState icon="🛡️" title={t('fraud.no_alerts')} /></td>
              </tr>
            ) : (
              alerts.map((alert) => (
                <tr key={alert.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                  <td className="px-4 py-3 text-neutral-600 text-xs hidden lg:table-cell">
                    {formatAdminDate(alert.created_at)}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {getAlertTypeLabel(alert.alert_type)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                      severityBadge[alert.severity] ?? 'bg-neutral-100 text-neutral-600'
                    }`}>
                      {alert.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-neutral-500 max-w-xs truncate hidden lg:table-cell">
                    {alert.details ? JSON.stringify(alert.details) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                      alert.resolved
                        ? 'bg-green-50 text-green-700'
                        : 'bg-red-50 text-red-700'
                    }`}>
                      {alert.resolved ? t('fraud.status_resolved') : t('fraud.status_pending')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {!alert.resolved && (
                      <button
                        onClick={() => setShowResolveModal(alert.id)}
                        className="text-sm text-primary-500 hover:underline"
                      >
                        {t('fraud.resolve')}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Resolve modal */}
      {showResolveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-bold mb-4">{t('fraud.resolve_title')}</h3>
            <textarea
              className="w-full border border-neutral-200 rounded-lg p-3 text-sm focus:outline-none focus:border-primary-500"
              rows={3}
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
              placeholder={t('fraud.resolve_note_placeholder')}
            />
            <div className="flex gap-3 mt-4 justify-end">
              <button
                onClick={() => {
                  setShowResolveModal(null);
                  setResolutionNote('');
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition-colors"
              >
                {t('fraud.cancel')}
              </button>
              <button
                onClick={() => handleResolve(showResolveModal)}
                disabled={resolving === showResolveModal}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50"
              >
                {resolving ? t('fraud.resolving') : t('fraud.mark_resolved')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
