'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Scale } from 'lucide-react';
import { disputeService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { RideDispute, DisputeStatus, DisputeResolution } from '@tricigo/types';
import { useAdminUser } from '@/lib/useAdminUser';
import { formatTRC } from '@tricigo/utils';
import { formatAdminDate } from '@/lib/formatDate';
import { useToast } from '@/components/ui/AdminToast';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { DataEmptyState } from '@/components/data/DataEmptyState';

type Filter = DisputeStatus | 'all';

const PRIORITY_CLASS: Record<string, string> = {
  low: 'bg-surface-sunken text-ink-muted',
  normal: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  high: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  urgent: 'bg-red-600 text-white',
};

const RESOLUTION_OPTIONS: DisputeResolution[] = [
  'full_refund',
  'partial_refund',
  'credit',
  'no_action',
  'warning_issued',
];

function slaStatus(deadline: string | null): 'ok' | 'warning' | 'expired' {
  if (!deadline) return 'ok';
  const remaining = new Date(deadline).getTime() - Date.now();
  if (remaining < 0) return 'expired';
  if (remaining < 6 * 60 * 60 * 1000) return 'warning';
  return 'ok';
}

export default function DisputesPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [disputes, setDisputes] = useState<RideDispute[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<Filter>('open');
  const [selected, setSelected] = useState<RideDispute | null>(null);

  const TABS: StatusTab<Filter>[] = useMemo(() => [
    { id: 'all', label: t('disputes.filter_all', { defaultValue: 'Todas' }) },
    { id: 'open', label: t('disputes.filter_open', { defaultValue: 'Abiertas' }), tone: 'info' },
    { id: 'under_review', label: t('disputes.filter_under_review', { defaultValue: 'En revisión' }), tone: 'warning' },
    { id: 'awaiting_response', label: t('disputes.filter_awaiting', { defaultValue: 'Esperando' }), tone: 'warning' },
    { id: 'resolved', label: t('disputes.filter_resolved', { defaultValue: 'Resueltas' }), tone: 'success' },
    { id: 'denied', label: t('disputes.filter_denied', { defaultValue: 'Denegadas' }), tone: 'danger' },
  ], [t]);

  const priorityLabel = useCallback((p: string): string => {
    switch (p) {
      case 'low': return t('disputes.priority_low', { defaultValue: 'Baja' });
      case 'normal': return t('disputes.priority_normal', { defaultValue: 'Normal' });
      case 'high': return t('disputes.priority_high', { defaultValue: 'Alta' });
      case 'urgent': return t('disputes.priority_urgent', { defaultValue: 'Urgente' });
      default: return p;
    }
  }, [t]);

  const reasonLabel = useCallback((r: string): string => {
    const key = `disputes.reason_${r}`;
    const fallbacks: Record<string, string> = {
      wrong_fare: 'Tarifa incorrecta',
      wrong_route: 'Ruta incorrecta',
      driver_behavior: 'Comportamiento del conductor',
      vehicle_condition: 'Condición del vehículo',
      safety_issue: 'Problema de seguridad',
      unauthorized_charge: 'Cobro no autorizado',
      service_not_rendered: 'Servicio no prestado',
      excessive_wait: 'Espera excesiva',
      lost_item: 'Objeto perdido',
      other: 'Otro',
    };
    return t(key, { defaultValue: fallbacks[r] ?? r });
  }, [t]);

  const resolutionLabel = useCallback((r: string): string => {
    const key = `disputes.resolution_${r === 'warning_issued' ? 'warning' : r}`;
    const fallbacks: Record<string, string> = {
      full_refund: 'Reembolso total',
      partial_refund: 'Reembolso parcial',
      credit: 'Crédito en la app',
      no_action: 'Sin acción / denegar',
      warning_issued: 'Advertencia emitida',
    };
    return t(key, { defaultValue: fallbacks[r] ?? r });
  }, [t]);

  // Resolution form state
  const [resolution, setResolution] = useState<DisputeResolution>('full_refund');
  const [refundAmount, setRefundAmount] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [resolving, setResolving] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const fetchDisputes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await disputeService.getAllDisputes({
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 100,
      });
      setDisputes(data);
    } catch (err) {
      setDisputes([]);
      setError(err instanceof Error ? err.message : t('disputes.load_error', { defaultValue: 'No pudimos cargar las disputas.' }));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  useEffect(() => {
    void fetchDisputes();
  }, [fetchDisputes]);

  const handleSelect = (d: RideDispute) => {
    setSelected(d);
    setAdminNotes(d.admin_notes ?? '');
    setRefundAmount('');
    setResolutionNotes('');
    setResolution('full_refund');
    setFormErrors({});
  };

  const validateResolveForm = () => {
    const errors: Record<string, string> = {};
    if (!resolutionNotes.trim()) errors.resolutionNotes = t('disputes.notes_required', { defaultValue: 'Contanos qué hiciste y por qué.' });
    if (resolution !== 'no_action' && resolution !== 'warning_issued') {
      const amt = parseInt(refundAmount || '0', 10);
      if (isNaN(amt) || amt < 0) errors.refundAmount = t('disputes.amount_invalid', { defaultValue: 'El monto debe ser un número positivo.' });
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleResolve = async () => {
    if (!selected) return;
    if (!validateResolveForm()) return;
    setResolving(true);
    try {
      const amount = resolution === 'no_action' ? 0 : parseInt(refundAmount || '0', 10);
      const d = selected as unknown as { ride_final_fare_trc?: number; ride_estimated_fare_trc?: number };
      const maxRefund = d.ride_final_fare_trc ?? d.ride_estimated_fare_trc ?? 100000;
      if (amount > maxRefund) {
        showToast('warning', t('disputes.refund_limit', { defaultValue: `El reembolso no puede superar ${maxRefund} TRC` }).replace('{max}', String(maxRefund)));
        setResolving(false);
        return;
      }
      await disputeService.resolveDispute(
        selected.id,
        adminUserId,
        resolution,
        amount,
        resolutionNotes,
      );
      const nextStatus: DisputeStatus = resolution === 'no_action' ? 'denied' : 'resolved';
      setDisputes((prev) =>
        prev.map((d) =>
          d.id === selected.id
            ? { ...d, status: nextStatus, resolution, refund_amount_trc: amount }
            : d,
        ),
      );
      setSelected(null);
      showToast('success', t('disputes.toast_resolved', { defaultValue: 'Disputa resuelta' }));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('disputes.resolve_error', { defaultValue: 'No pudimos resolver la disputa.' }));
    } finally {
      setResolving(false);
    }
  };

  const handleAssignToMe = async () => {
    if (!selected) return;
    try {
      await disputeService.updateDisputeStatus(selected.id, {
        status: 'under_review',
        assigned_to: adminUserId,
      });
      const updated: RideDispute = {
        ...selected,
        status: 'under_review' as DisputeStatus,
        assigned_to: adminUserId,
      };
      setSelected(updated);
      setDisputes((prev) => prev.map((d) => (d.id === selected.id ? updated : d)));
      showToast('success', t('disputes.toast_assigned', { defaultValue: 'Asignada a vos' }));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('disputes.assign_error', { defaultValue: 'No pudimos asignarla.' }));
    }
  };

  const handleSaveAdminNotes = async () => {
    if (!selected) return;
    try {
      await disputeService.addAdminNotes(selected.id, adminNotes);
      setSelected((prev) => (prev ? { ...prev, admin_notes: adminNotes } : null));
      showToast('success', t('disputes.toast_notes_saved', { defaultValue: 'Notas guardadas' }));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('disputes.notes_error', { defaultValue: 'No pudimos guardar las notas.' }));
    }
  };

  const renderList = () => {
    if (loading) {
      return (
        <div className="space-y-3 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl bg-surface-sunken p-3">
              <div className="h-9 w-9 animate-pulse rounded-xl bg-surface-elevated" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-3/4 animate-pulse rounded bg-surface-elevated" />
                <div className="h-2.5 w-1/3 animate-pulse rounded bg-surface-elevated" />
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (error) {
      return (
        <div className="p-6">
          <DataEmptyState
            icon={Scale}
            tone="danger"
            title={t('disputes.load_error_title', { defaultValue: 'No pudimos cargar las disputas' })}
            body={error}
            action={{ label: t('disputes.retry', { defaultValue: 'Reintentar' }), onClick: () => void fetchDisputes() }}
          />
        </div>
      );
    }
    if (disputes.length === 0) {
      return (
        <div className="p-6">
          <DataEmptyState
            icon={Scale}
            title={t('disputes.empty_title', { defaultValue: 'Sin disputas' })}
            body={t('disputes.empty_body', { defaultValue: 'No hay disputas abiertas en este alcance. Buen trabajo.' })}
          />
        </div>
      );
    }
    return (
      <ul className="divide-y divide-line">
        {disputes.map((d) => {
          const active = selected?.id === d.id;
          const sla = slaStatus(d.sla_resolution_deadline);
          const priorityClass = PRIORITY_CLASS[d.priority] ?? PRIORITY_CLASS.low!;
          return (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => handleSelect(d)}
                aria-current={active ? 'true' : undefined}
                className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                  active ? 'bg-primary-500/8' : 'hover:bg-surface-sunken'
                }`}
              >
                <span
                  className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${
                    active ? 'bg-primary-500/15 text-primary-500' : 'bg-surface-sunken text-ink-muted'
                  }`}
                >
                  <Scale className="h-4 w-4" strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {reasonLabel(d.reason)}
                    </span>
                    <StatusBadge domain="dispute" status={d.status} />
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-subtle">
                    <span
                      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${priorityClass}`}
                    >
                      {priorityLabel(d.priority)}
                    </span>
                    {sla === 'expired' && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                        <AlertTriangle className="h-2.5 w-2.5" /> {t('disputes.sla_expired', { defaultValue: 'SLA vencido' })}
                      </span>
                    )}
                    {sla === 'warning' && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        {t('disputes.sla_warning', { defaultValue: 'SLA < 6 h' })}
                      </span>
                    )}
                    <span className="font-mono">{d.ride_id.slice(0, 8)}…</span>
                    <span className="ml-auto">{formatAdminDate(d.created_at)}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  const canResolve =
    selected &&
    selected.status !== 'resolved' &&
    selected.status !== 'denied' &&
    selected.status !== 'closed';
  const isNumericResolution = resolution !== 'no_action' && resolution !== 'warning_issued';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('disputes.page_eyebrow', { defaultValue: 'Operación · disputas' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('disputes.title', { defaultValue: 'Disputas' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('disputes.page_description', { defaultValue: 'Reclamos de pasajeros y conductores. Escuchá ambas versiones antes de decidir.' })}
          </p>
        </div>
      </div>

      <FilterBar<Filter>
        sticky
        tabs={TABS}
        activeTab={statusFilter}
        onTabChange={(id) => {
          setStatusFilter(id);
          setSelected(null);
        }}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="admin-card overflow-hidden lg:col-span-2">
          <div className="border-b border-line px-4 py-2.5">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
              {t('disputes.tray_eyebrow', { defaultValue: 'Bandeja' })}
            </p>
            <h2 className="font-display text-[15px] font-semibold text-ink">
              {t('disputes.tray_title', { defaultValue: 'Disputas' })} ({disputes.length})
            </h2>
          </div>
          <div className="max-h-[680px] overflow-y-auto">{renderList()}</div>
        </div>

        <div className="admin-card lg:col-span-3">
          {!selected ? (
            <div className="flex min-h-[480px] items-center justify-center p-6">
              <DataEmptyState
                icon={Scale}
                title={t('disputes.pick_title', { defaultValue: 'Elegí una disputa' })}
                body={t('disputes.pick_body', { defaultValue: 'Seleccioná un reclamo en la bandeja para ver los detalles y resolverlo.' })}
              />
            </div>
          ) : (
            <div className="flex max-h-[680px] flex-col overflow-y-auto">
              <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-500/10 text-primary-500">
                  <Scale className="h-5 w-5" strokeWidth={1.8} />
                </span>
                <div className="flex-1">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                    {t('disputes.field_reason', { defaultValue: 'Motivo' })}
                  </p>
                  <h2 className="font-display text-[17px] font-semibold text-ink">
                    {reasonLabel(selected.reason)}
                  </h2>
                </div>
                <div className="flex items-center gap-1.5">
                  <StatusBadge domain="dispute" status={selected.status} size="md" />
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      PRIORITY_CLASS[selected.priority] ?? PRIORITY_CLASS.low!
                    }`}
                  >
                    {priorityLabel(selected.priority)}
                  </span>
                </div>
              </div>

              <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                    {t('disputes.field_ride', { defaultValue: 'Viaje' })}
                  </p>
                  <p className="font-mono text-[12.5px] text-ink">{selected.ride_id}</p>
                </div>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                    {t('disputes.field_created', { defaultValue: 'Creada' })}
                  </p>
                  <p className="text-[12.5px] text-ink">{formatAdminDate(selected.created_at)}</p>
                </div>
              </div>

              {!selected.assigned_to && canResolve && (
                <div className="px-5 pb-2">
                  <button
                    type="button"
                    onClick={handleAssignToMe}
                    className="rounded-full border border-primary-500/30 bg-primary-500/10 px-3 py-1.5 text-[12px] font-medium text-primary-600 hover:bg-primary-500/15 dark:text-primary-400"
                  >
                    {t('disputes.assign_to_me', { defaultValue: 'Asignármela' })}
                  </button>
                </div>
              )}

              <section className="px-5 py-4">
                <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
                  {t('disputes.rider_version', { defaultValue: 'Versión del pasajero' })}
                </h3>
                <div className="rounded-xl border border-line bg-surface-sunken p-4">
                  <p className="text-[13px] text-ink">{selected.description}</p>
                  {selected.evidence_urls.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selected.evidence_urls.map((url, i) => (
                        <a
                          key={i}
                          href={url}
                          target="_blank"
                          rel="noopener"
                          className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted hover:text-ink"
                        >
                          {t('disputes.evidence_label', { defaultValue: 'Evidencia' })} {i + 1}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <section className="px-5 py-4">
                <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
                  {t('disputes.driver_version', { defaultValue: 'Versión del conductor' })}
                </h3>
                <div className="rounded-xl border border-line bg-surface-sunken p-4">
                  {selected.respondent_message ? (
                    <>
                      <p className="text-[13px] text-ink">{selected.respondent_message}</p>
                      {selected.respondent_evidence_urls.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {selected.respondent_evidence_urls.map((url, i) => (
                            <a
                              key={i}
                              href={url}
                              target="_blank"
                              rel="noopener"
                              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted hover:text-ink"
                            >
                              {t('disputes.evidence_label', { defaultValue: 'Evidencia' })} {i + 1}
                            </a>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-[12.5px] italic text-ink-subtle">
                      {t('disputes.no_driver_response', { defaultValue: 'Aún sin respuesta del conductor.' })}
                    </p>
                  )}
                </div>
              </section>

              {canResolve && (
                <section className="px-5 py-4">
                  <div className="rounded-xl border border-primary-500/20 bg-primary-500/5 p-4">
                    <h3 className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary-600 dark:text-primary-400">
                      {t('disputes.resolve_title', { defaultValue: 'Resolver' })}
                    </h3>
                    <div className="flex flex-col gap-3">
                      <label className="flex flex-col gap-1">
                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                          {t('disputes.resolve_type_label', { defaultValue: 'Tipo de resolución' })}
                        </span>
                        <select
                          value={resolution}
                          onChange={(e) => setResolution(e.target.value as DisputeResolution)}
                          className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink focus:border-primary-500 focus:outline-none"
                        >
                          {RESOLUTION_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {resolutionLabel(r)}
                            </option>
                          ))}
                        </select>
                      </label>

                      {isNumericResolution && (
                        <label className="flex flex-col gap-1">
                          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                            {t('disputes.refund_amount_label', { defaultValue: 'Monto de reembolso (TRC)' })}
                          </span>
                          <input
                            type="number"
                            value={refundAmount}
                            onChange={(e) => {
                              setRefundAmount(e.target.value);
                              setFormErrors((p) => {
                                const { refundAmount: _r, ...rest } = p;
                                return rest;
                              });
                            }}
                            placeholder="0"
                            className={`h-9 rounded-lg border bg-surface px-2 text-[13px] text-ink focus:outline-none ${
                              formErrors.refundAmount
                                ? 'border-red-500 focus:border-red-500'
                                : 'border-line focus:border-primary-500'
                            }`}
                          />
                          {formErrors.refundAmount && (
                            <span className="text-[11px] text-red-500">
                              {formErrors.refundAmount}
                            </span>
                          )}
                        </label>
                      )}

                      <label className="flex flex-col gap-1">
                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                          {t('disputes.resolve_notes_label', { defaultValue: 'Notas de resolución' })} <span className="normal-case text-red-500">*</span>
                        </span>
                        <textarea
                          rows={3}
                          value={resolutionNotes}
                          onChange={(e) => {
                            setResolutionNotes(e.target.value);
                            setFormErrors((p) => {
                              const { resolutionNotes: _r, ...rest } = p;
                              return rest;
                            });
                          }}
                          placeholder={t('disputes.resolve_notes_placeholder', { defaultValue: '¿Qué decidiste y por qué?' })}
                          className={`rounded-lg border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-subtle focus:outline-none ${
                            formErrors.resolutionNotes
                              ? 'border-red-500 focus:border-red-500'
                              : 'border-line focus:border-primary-500'
                          }`}
                        />
                        {formErrors.resolutionNotes && (
                          <span className="text-[11px] text-red-500">
                            {formErrors.resolutionNotes}
                          </span>
                        )}
                      </label>

                      <div className="flex justify-end">
                        <button
                          onClick={() => void handleResolve()}
                          disabled={resolving || !resolutionNotes.trim()}
                          className="rounded-full bg-ink px-4 py-1.5 text-[12px] font-medium text-surface hover:opacity-90 disabled:opacity-50"
                        >
                          {resolving
                            ? t('disputes.resolving', { defaultValue: 'Resolviendo…' })
                            : resolution === 'no_action'
                              ? t('disputes.deny_button', { defaultValue: 'Denegar' })
                              : t('disputes.resolve_button', { defaultValue: 'Resolver' })}
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {(selected.status === 'resolved' || selected.status === 'denied') &&
                selected.resolution && (
                  <section className="px-5 py-4">
                    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                      <h3 className="font-display text-[14px] font-semibold text-ink">
                        {resolutionLabel(selected.resolution)}
                      </h3>
                      {selected.refund_amount_trc != null && selected.refund_amount_trc > 0 && (
                        <p className="mt-1 text-[12.5px] text-emerald-700 dark:text-emerald-400">
                          {t('disputes.refund_suffix', { defaultValue: 'Reembolso:' })} {formatTRC(selected.refund_amount_trc)}
                        </p>
                      )}
                      {selected.resolution_notes && (
                        <p className="mt-1 text-[12.5px] text-ink-muted">
                          {selected.resolution_notes}
                        </p>
                      )}
                    </div>
                  </section>
                )}

              <section className="px-5 py-4">
                <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
                  {t('disputes.admin_notes_title', { defaultValue: 'Notas internas' })}
                </h3>
                <textarea
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  placeholder={t('disputes.admin_notes_placeholder', { defaultValue: 'Detalles de gestión, contactos, próximos pasos…' })}
                  className="min-h-[80px] w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-subtle focus:border-primary-500 focus:outline-none"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    onClick={() => void handleSaveAdminNotes()}
                    className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-sunken"
                  >
                    {t('disputes.save_notes', { defaultValue: 'Guardar notas' })}
                  </button>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
