'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import { useAdminUser } from '@/lib/useAdminUser';
import { useToast } from '@/components/ui/AdminToast';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { StatusBadge } from '@/components/data/StatusBadge';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { formatAdminDate } from '@/lib/formatDate';

const PAGE_SIZE = 20;

type StatusFilter = 'all' | 'open' | 'investigating' | 'resolved';

type Severity = 'critical' | 'high' | 'medium' | 'low';

const SEVERITY_CLASS: Record<Severity, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-red-500/10 text-red-600 dark:text-red-400',
  medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  low: 'bg-surface-sunken text-ink-muted',
};

type Incident = {
  id: string;
  type: string;
  severity: string;
  status: string;
  ride_id: string | null;
  reported_by: string;
  against_user_id: string | null;
  description: string;
  created_at: string;
};

function typeLabel(raw: string, t: (k: string, opts?: { defaultValue?: string }) => string) {
  const key = `incidents.type_${raw}`;
  return t(key, { defaultValue: raw.replace(/_/g, ' ') });
}

export default function IncidentsPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const STATUS_TABS: StatusTab<StatusFilter>[] = useMemo(() => [
    { id: 'all', label: t('incidents.filter_label_all', { defaultValue: 'Todos' }) },
    { id: 'open', label: t('incidents.filter_label_open', { defaultValue: 'Abiertos' }), tone: 'danger' },
    { id: 'investigating', label: t('incidents.filter_label_investigating', { defaultValue: 'En investigación' }), tone: 'warning' },
    { id: 'resolved', label: t('incidents.filter_label_resolved', { defaultValue: 'Resueltos' }), tone: 'success' },
  ], [t]);

  const severityLabel = useCallback((sev: Severity): string => {
    switch (sev) {
      case 'critical': return t('incidents.severity_critical', { defaultValue: 'Crítica' });
      case 'high': return t('incidents.severity_high', { defaultValue: 'Alta' });
      case 'medium': return t('incidents.severity_medium', { defaultValue: 'Media' });
      case 'low': return t('incidents.severity_low', { defaultValue: 'Baja' });
    }
  }, [t]);

  const fetchIncidents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminService.getIncidents(
        statusFilter === 'all' ? undefined : statusFilter,
        page,
        PAGE_SIZE,
      );
      setIncidents(data as unknown as Incident[]);
    } catch (err) {
      setIncidents([]);
      setError(err instanceof Error ? err.message : t('incidents.load_error', { defaultValue: 'No pudimos cargar los incidentes.' }));
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    void fetchIncidents();
  }, [fetchIncidents]);

  const advanceStatus = useCallback(
    async (id: string, next: string, successMsg: string) => {
      try {
        await adminService.updateIncidentStatus(id, next, adminUserId);
        setIncidents((prev) => prev.map((i) => (i.id === id ? { ...i, status: next } : i)));
        showToast('success', successMsg);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : t('incidents.update_error', { defaultValue: 'No pudimos actualizar el estado.' }));
      }
    },
    [adminUserId, showToast, t],
  );

  const columns: DataColumn<Incident>[] = useMemo(
    () => [
      {
        id: 'type',
        header: t('incidents.col_type', { defaultValue: 'Tipo' }),
        cell: (i) => <span className="font-medium text-ink">{typeLabel(i.type, t)}</span>,
        primary: true,
      },
      {
        id: 'severity',
        header: t('incidents.col_severity', { defaultValue: 'Severidad' }),
        cell: (i) => {
          const sev = ((i.severity as Severity) ?? 'low');
          const className = SEVERITY_CLASS[sev] ?? SEVERITY_CLASS.low;
          return (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${className}`}
            >
              {severityLabel(sev)}
            </span>
          );
        },
        width: '110px',
      },
      {
        id: 'status',
        header: t('incidents.col_status', { defaultValue: 'Estado' }),
        cell: (i) => <StatusBadge domain="incident" status={i.status} />,
        width: '170px',
      },
      {
        id: 'ride_id',
        header: t('incidents.col_ride', { defaultValue: 'Viaje' }),
        cell: (i) => (i.ride_id ? `${i.ride_id.slice(0, 8)}…` : <span className="text-ink-subtle">—</span>),
        mono: true,
        hideBelow: 'lg',
        width: '120px',
      },
      {
        id: 'description',
        header: t('incidents.col_description', { defaultValue: 'Descripción' }),
        cell: (i) => (
          <span className="block max-w-xs truncate text-ink-muted">{i.description}</span>
        ),
        hideBelow: 'lg',
        secondary: true,
      },
      {
        id: 'created_at',
        header: t('incidents.col_date', { defaultValue: 'Creado' }),
        cell: (i) => <span className="text-ink-muted">{formatAdminDate(i.created_at)}</span>,
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [t, severityLabel],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('incidents.page_eyebrow', { defaultValue: 'Operación · incidentes' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('incidents.title', { defaultValue: 'Incidentes' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('incidents.page_description', { defaultValue: 'Reportes de seguridad, conflictos y situaciones que requieren intervención.' })}
          </p>
        </div>
      </div>

      <FilterBar<StatusFilter>
        sticky
        tabs={STATUS_TABS}
        activeTab={statusFilter}
        onTabChange={(id) => {
          setStatusFilter(id);
          setPage(0);
        }}
      />

      <DataTable<Incident>
        columns={columns}
        rows={incidents}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => {
          setError(null);
          void fetchIncidents();
        }}
        empty={
          statusFilter === 'resolved'
            ? {
                icon: ShieldCheck,
                title: t('incidents.empty_resolved_title', { defaultValue: 'Sin incidentes resueltos' }),
                body: t('incidents.empty_resolved_body', { defaultValue: 'Cuando se cierre alguno, va a aparecer acá.' }),
              }
            : {
                icon: ShieldCheck,
                title: t('incidents.empty_calm_title', { defaultValue: 'Todo en calma' }),
                body: t('incidents.empty_calm_body', { defaultValue: 'No hay incidentes abiertos en este momento. Buena señal.' }),
              }
        }
        rowActions={[
          {
            label: t('incidents.action_investigate', { defaultValue: 'Investigar' }),
            onClick: (i) => {
              if (i.status === 'open') {
                void advanceStatus(i.id, 'investigating', t('incidents.toast_now_investigating', { defaultValue: 'Incidente pasado a investigación' }));
              }
            },
          },
          {
            label: t('incidents.action_resolve', { defaultValue: 'Resolver' }),
            onClick: (i) => {
              if (i.status === 'investigating') {
                void advanceStatus(i.id, 'resolved', t('incidents.toast_resolved', { defaultValue: 'Incidente resuelto' }));
              }
            },
          },
        ]}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: incidents.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
      />
    </div>
  );
}
