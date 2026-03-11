'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import { useAdminUser } from '@/lib/useAdminUser';

const PAGE_SIZE = 20;

const STATUS_FILTER_KEYS = [
  { labelKey: 'incidents.filter_all', value: 'all' },
  { labelKey: 'incidents.filter_open', value: 'open' },
  { labelKey: 'incidents.filter_investigating', value: 'investigating' },
  { labelKey: 'incidents.filter_resolved', value: 'resolved' },
] as const;

const STATUS_BADGE: Record<string, string> = {
  open: 'bg-red-100 text-red-700',
  investigating: 'bg-yellow-100 text-yellow-700',
  resolved: 'bg-green-100 text-green-700',
  dismissed: 'bg-neutral-100 text-neutral-500',
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-100 text-orange-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-neutral-100 text-neutral-500',
};

interface Incident {
  id: string;
  type: string;
  severity: string;
  status: string;
  ride_id: string | null;
  reported_by: string;
  against_user_id: string | null;
  description: string;
  created_at: string;
}

export default function IncidentsPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const getTypeLabel = (type: string) => {
    const key = `incidents.type_${type}`;
    return t(key, { defaultValue: type });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    adminService
      .getIncidents(statusFilter === 'all' ? undefined : statusFilter, page, PAGE_SIZE)
      .then((data) => {
        if (!cancelled) setIncidents(data as unknown as Incident[]);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [page, statusFilter]);

  const handleStatusChange = async (incidentId: string, newStatus: string) => {
    try {
      await adminService.updateIncidentStatus(incidentId, newStatus, adminUserId);
      setIncidents((prev) =>
        prev.map((i) => (i.id === incidentId ? { ...i, status: newStatus } : i)),
      );
    } catch (err) {
      console.error('Error updating incident:', err);
    }
  };

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6">{t('incidents.title')}</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-6">
        {STATUS_FILTER_KEYS.map((f) => (
          <button
            key={f.value}
            onClick={() => { setPage(0); setStatusFilter(f.value); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === f.value
                ? 'bg-primary-500 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-neutral-50 border-b">
              <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500 uppercase whitespace-nowrap">{t('incidents.col_type')}</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500 uppercase whitespace-nowrap">{t('incidents.col_severity')}</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500 uppercase whitespace-nowrap">{t('incidents.col_status')}</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500 uppercase whitespace-nowrap hidden lg:table-cell">{t('incidents.col_ride')}</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500 uppercase whitespace-nowrap hidden lg:table-cell">{t('incidents.col_description')}</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500 uppercase whitespace-nowrap hidden lg:table-cell">{t('incidents.col_date')}</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500 uppercase whitespace-nowrap">{t('incidents.col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-neutral-400">
                  {t('incidents.loading')}
                </td>
              </tr>
            ) : incidents.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-neutral-400">
                  {t('incidents.no_incidents')}
                </td>
              </tr>
            ) : (
              incidents.map((incident) => (
                <tr key={incident.id} className="border-b hover:bg-neutral-50">
                  <td className="px-4 py-3 text-sm">
                    {getTypeLabel(incident.type)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${SEVERITY_BADGE[incident.severity] ?? 'bg-neutral-100'}`}>
                      {incident.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_BADGE[incident.status] ?? 'bg-neutral-100'}`}>
                      {incident.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-neutral-500 font-mono hidden lg:table-cell">
                    {incident.ride_id ? incident.ride_id.slice(0, 8) + '…' : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm max-w-xs truncate hidden lg:table-cell">
                    {incident.description}
                  </td>
                  <td className="px-4 py-3 text-sm text-neutral-500 hidden lg:table-cell">
                    {new Date(incident.created_at).toLocaleDateString('es-CU', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-3">
                    {incident.status === 'open' && (
                      <button
                        onClick={() => handleStatusChange(incident.id, 'investigating')}
                        className="text-xs bg-yellow-100 text-yellow-700 px-3 py-1 rounded-full hover:bg-yellow-200"
                      >
                        {t('incidents.investigate')}
                      </button>
                    )}
                    {incident.status === 'investigating' && (
                      <button
                        onClick={() => handleStatusChange(incident.id, 'resolved')}
                        className="text-xs bg-green-100 text-green-700 px-3 py-1 rounded-full hover:bg-green-200"
                      >
                        {t('incidents.resolve')}
                      </button>
                    )}
                    {incident.status === 'resolved' && (
                      <span className="text-xs text-neutral-400">{t('incidents.resolved')}</span>
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
      <div className="flex gap-3 mt-4">
        <button
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
          className="px-4 py-2 rounded-lg text-sm bg-neutral-100 disabled:opacity-30"
        >
          {t('incidents.previous')}
        </button>
        <button
          disabled={incidents.length < PAGE_SIZE}
          onClick={() => setPage((p) => p + 1)}
          className="px-4 py-2 rounded-lg text-sm bg-neutral-100 disabled:opacity-30"
        >
          {t('incidents.next')}
        </button>
      </div>
    </div>
  );
}
