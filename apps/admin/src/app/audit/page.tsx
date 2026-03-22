'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import type { AdminAction } from '@tricigo/types';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';

const PAGE_SIZE = 20;


const ACTION_LABEL_KEYS: Record<string, string> = {
  approve_driver: 'audit.action_approve_driver',
  reject_driver: 'audit.action_reject_driver',
  suspend_driver: 'audit.action_suspend_driver',
  approve_redemption: 'audit.action_approve_redemption',
  reject_redemption: 'audit.action_reject_redemption',
  approve_recharge: 'audit.action_approve_recharge',
  reject_recharge: 'audit.action_reject_recharge',
  incident_investigating: 'audit.action_investigate_incident',
  incident_resolved: 'audit.action_resolve_incident',
};

const TARGET_LABEL_KEYS: Record<string, string> = {
  driver_profile: 'audit.target_driver',
  wallet_redemption: 'audit.target_redemption',
  wallet_recharge_request: 'audit.target_recharge',
  incident_report: 'audit.target_incident',
};

export default function AuditPage() {
  const { t } = useTranslation('admin');
  const [actions, setActions] = useState<AdminAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
          setError(err instanceof Error ? err.message : 'Error al cargar auditoría');
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
      <h1 className="text-2xl md:text-3xl font-bold mb-6">{t('audit.title')}</h1>

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); setPage(0); }}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Date range filters */}
      <div className="flex flex-col sm:flex-row flex-wrap items-start sm:items-end gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-neutral-600 mb-1">
            {t('audit.filter_from')}
          </label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(0);
            }}
            className="px-3 py-2 rounded-lg border border-neutral-200 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-neutral-600 mb-1">
            {t('audit.filter_to')}
          </label>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => {
              if (dateFrom && e.target.value < dateFrom) return;
              setDateTo(e.target.value);
              setPage(0);
            }}
            className="px-3 py-2 rounded-lg border border-neutral-200 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500"
          />
        </div>
        {(dateFrom || dateTo) && (
          <button
            onClick={handleClearFilter}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition-colors"
          >
            {t('audit.clear_filters')}
          </button>
        )}
      </div>

      {/* Actions table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-100">
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                {t('audit.col_date')}
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap hidden lg:table-cell">
                {t('audit.col_admin')}
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                {t('audit.col_action')}
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                {t('audit.col_target')}
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap hidden lg:table-cell">
                {t('audit.col_details')}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-0 py-0">
                  <AdminTableSkeleton rows={5} columns={5} />
                </td>
              </tr>
            ) : actions.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="text-center py-12 text-neutral-400"
                >
                  {t('audit.no_actions')}
                </td>
              </tr>
            ) : (
              actions.map((action) => (
                <tr
                  key={action.id}
                  className="border-b border-neutral-50 hover:bg-neutral-50/50 transition-colors"
                >
                  <td className="px-6 py-4 text-sm text-neutral-600">
                    {formatAdminDate(action.created_at)}
                  </td>
                  <td className="px-6 py-4 text-sm text-neutral-600 font-mono hidden lg:table-cell">
                    {action.admin_id.slice(0, 8)}...
                  </td>
                  <td className="px-6 py-4">
                    <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                      {ACTION_LABEL_KEYS[action.action] ? t(ACTION_LABEL_KEYS[action.action]!) : action.action}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-neutral-600">
                    <span className="text-neutral-500">
                      {TARGET_LABEL_KEYS[action.target_type] ? t(TARGET_LABEL_KEYS[action.target_type]!) : action.target_type}
                    </span>
                    {action.target_id && (
                      <span className="ml-1 font-mono text-xs text-neutral-400">
                        {action.target_id.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-neutral-500 hidden lg:table-cell">
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
          {t('common.previous')}
        </button>
        <span className="text-sm text-neutral-500">
          {t('common.page')} {page + 1}
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
          {t('common.next')}
        </button>
      </div>
    </div>
  );
}
