'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shield, ShieldCheck, X } from 'lucide-react';
import { fraudService } from '@tricigo/api';
import type { FraudAlert } from '@tricigo/types';
import { useTranslation } from '@tricigo/i18n';
import { useAdminUser } from '@/lib/useAdminUser';
import { useToast } from '@/components/ui/AdminToast';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { formatAdminDate } from '@/lib/formatDate';

type Filter = 'unresolved' | 'all';

const TABS: StatusTab<Filter>[] = [
  { id: 'unresolved', label: 'Sin resolver', tone: 'danger' },
  { id: 'all', label: 'Todas' },
];

const SEVERITY_META: Record<string, { label: string; className: string }> = {
  low: {
    label: 'Baja',
    className: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  },
  medium: {
    label: 'Media',
    className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  high: {
    label: 'Alta',
    className: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  },
  critical: {
    label: 'Crítica',
    className: 'bg-red-600 text-white',
  },
};

export default function FraudAlertsPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [alerts, setAlerts] = useState<FraudAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('unresolved');
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [resolveModalId, setResolveModalId] = useState<string | null>(null);

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fraudService.getFraudAlerts({
        resolved: filter === 'unresolved' ? false : undefined,
        limit: 100,
      });
      setAlerts(data);
    } catch (err) {
      setAlerts([]);
      setError(err instanceof Error ? err.message : 'No pudimos cargar las alertas.');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void fetchAlerts();
  }, [fetchAlerts]);

  const unresolvedCount = useMemo(() => alerts.filter((a) => !a.resolved).length, [alerts]);

  const handleResolve = async (alertId: string) => {
    setResolving(alertId);
    try {
      await fraudService.resolveAlert(alertId, adminUserId, resolutionNote || undefined);
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alertId ? { ...a, resolved: true, resolved_at: new Date().toISOString() } : a,
        ),
      );
      setResolveModalId(null);
      setResolutionNote('');
      showToast('success', 'Alerta marcada como resuelta');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No pudimos resolver la alerta.');
    } finally {
      setResolving(null);
    }
  };

  const columns: DataColumn<FraudAlert>[] = useMemo(
    () => [
      {
        id: 'alert_type',
        header: 'Tipo',
        cell: (a) => (
          <span className="font-medium text-ink">
            {t(`fraud.type_${a.alert_type}`, { defaultValue: a.alert_type.replace(/_/g, ' ') })}
          </span>
        ),
        primary: true,
      },
      {
        id: 'severity',
        header: 'Severidad',
        cell: (a) => {
          const meta = SEVERITY_META[a.severity] ?? { label: a.severity, className: 'bg-surface-sunken text-ink-muted' };
          return (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.className}`}
            >
              {meta.label}
            </span>
          );
        },
        width: '110px',
      },
      {
        id: 'resolved',
        header: 'Estado',
        cell: (a) =>
          a.resolved ? (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              Resuelta
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
              Pendiente
            </span>
          ),
        width: '120px',
      },
      {
        id: 'details',
        header: 'Detalles',
        cell: (a) => (
          <span className="block max-w-xs truncate font-mono text-[10.5px] text-ink-muted">
            {a.details ? JSON.stringify(a.details) : '—'}
          </span>
        ),
        hideBelow: 'lg',
        secondary: true,
      },
      {
        id: 'created_at',
        header: 'Fecha',
        cell: (a) => <span className="text-ink-muted">{formatAdminDate(a.created_at)}</span>,
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [t],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            Operación · antifraude
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            Alertas de fraude
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {unresolvedCount > 0
              ? `${unresolvedCount} ${unresolvedCount === 1 ? 'alerta pendiente' : 'alertas pendientes'} de revisión`
              : 'Sin alertas pendientes. Buena señal.'}
          </p>
        </div>
      </div>

      <FilterBar<Filter>
        sticky
        tabs={TABS}
        activeTab={filter}
        onTabChange={setFilter}
      />

      <DataTable<FraudAlert>
        columns={columns}
        rows={alerts}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => void fetchAlerts()}
        empty={{
          icon: filter === 'unresolved' ? ShieldCheck : Shield,
          title: filter === 'unresolved' ? 'Sin alertas activas' : 'Sin alertas registradas',
          body:
            filter === 'unresolved'
              ? 'Nada pendiente de revisión. El sistema no detectó fraude reciente.'
              : 'Todavía no hay alertas para mostrar en este alcance.',
          tone: 'success',
        }}
        rowActions={[
          {
            label: 'Resolver',
            onClick: (a) => {
              if (!a.resolved) setResolveModalId(a.id);
            },
          },
        ]}
      />

      {/* Resolve modal */}
      {resolveModalId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fraud-resolve-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setResolveModalId(null);
              setResolutionNote('');
            }
          }}
        >
          <div className="relative mx-4 w-full max-w-md overflow-hidden rounded-2xl border border-line bg-surface-elevated shadow-elev-3">
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
                  Antifraude
                </p>
                <h3 id="fraud-resolve-title" className="font-display text-[17px] font-semibold text-ink">
                  Resolver alerta
                </h3>
              </div>
              <button
                onClick={() => {
                  setResolveModalId(null);
                  setResolutionNote('');
                }}
                aria-label="Cerrar"
                className="rounded-md p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-5 py-4">
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                  Nota de resolución <span className="normal-case text-ink-subtle">(opcional)</span>
                </span>
                <textarea
                  rows={4}
                  value={resolutionNote}
                  onChange={(e) => setResolutionNote(e.target.value)}
                  placeholder="¿Qué se encontró? ¿Qué se hizo?"
                  className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-subtle focus:border-primary-500 focus:outline-none"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
              <button
                onClick={() => {
                  setResolveModalId(null);
                  setResolutionNote('');
                }}
                className="rounded-full border border-line bg-surface px-4 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-sunken"
              >
                Cancelar
              </button>
              <button
                onClick={() => handleResolve(resolveModalId)}
                disabled={resolving === resolveModalId}
                className="rounded-full bg-ink px-4 py-1.5 text-[12px] font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {resolving === resolveModalId ? 'Resolviendo…' : 'Marcar como resuelta'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
