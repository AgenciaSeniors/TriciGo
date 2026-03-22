'use client';

import { useEffect, useState } from 'react';
import { disputeService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { RideDispute, DisputeStatus, DisputeResolution } from '@tricigo/types';
import { useAdminUser } from '@/lib/useAdminUser';
import { formatTRC } from '@tricigo/utils';
import { formatAdminDate } from '@/lib/formatDate';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { useSortableTable } from '@/hooks/useSortableTable';
import { SortableHeader } from '@/components/ui/SortableHeader';

const statusBadge: Record<string, string> = {
  open: 'bg-blue-50 text-blue-700',
  under_review: 'bg-yellow-50 text-yellow-700',
  awaiting_response: 'bg-purple-50 text-purple-700',
  resolved: 'bg-green-50 text-green-700',
  denied: 'bg-red-50 text-red-700',
  closed: 'bg-neutral-100 text-neutral-500',
};

const priorityBadge: Record<string, string> = {
  low: 'bg-neutral-100 text-neutral-600',
  normal: 'bg-blue-50 text-blue-600',
  high: 'bg-orange-50 text-orange-600',
  urgent: 'bg-red-50 text-red-600',
};

const reasonLabelKeys: Record<string, string> = {
  wrong_fare: 'Wrong fare',
  wrong_route: 'Wrong route',
  driver_behavior: 'Driver behavior',
  vehicle_condition: 'Vehicle condition',
  safety_issue: 'Safety issue',
  unauthorized_charge: 'Unauthorized charge',
  service_not_rendered: 'Service not rendered',
  excessive_wait: 'Excessive wait',
  lost_item: 'Lost item',
  other: 'Other',
};

const RESOLUTION_OPTIONS: DisputeResolution[] = [
  'full_refund',
  'partial_refund',
  'credit',
  'no_action',
  'warning_issued',
];


function getSlaStatus(deadline: string | null): 'ok' | 'warning' | 'expired' {
  if (!deadline) return 'ok';
  const remaining = new Date(deadline).getTime() - Date.now();
  if (remaining < 0) return 'expired';
  if (remaining < 6 * 60 * 60 * 1000) return 'warning'; // less than 6h
  return 'ok';
}

export default function DisputesPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [disputes, setDisputes] = useState<RideDispute[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<DisputeStatus | 'all'>('open');
  const [selected, setSelected] = useState<RideDispute | null>(null);

  // Resolution form state
  const [resolution, setResolution] = useState<DisputeResolution>('full_refund');
  const [refundAmount, setRefundAmount] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [resolving, setResolving] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  function validateResolveForm() {
    const errors: Record<string, string> = {};
    if (!resolutionNotes.trim()) errors.resolutionNotes = 'Campo requerido';
    if (resolution !== 'no_action' && resolution !== 'warning_issued') {
      const amt = parseInt(refundAmount || '0', 10);
      if (isNaN(amt) || amt < 0) errors.refundAmount = t('common.must_be_positive');
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  const fetchDisputes = async () => {
    setLoading(true);
    try {
      const data = await disputeService.getAllDisputes({
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 100,
      });
      setDisputes(data);
    } catch (err) {
      // Error handled by UI
      setError(err instanceof Error ? err.message : 'Error al cargar disputas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDisputes();
  }, [statusFilter]);

  const handleSelect = (dispute: RideDispute) => {
    setSelected(dispute);
    setAdminNotes(dispute.admin_notes ?? '');
    setRefundAmount('');
    setResolutionNotes('');
    setResolution('full_refund');
    setFormErrors({});
  };

  const handleResolve = async () => {
    if (!selected) return;
    if (!validateResolveForm()) return;
    setResolving(true);
    try {
      const amount = resolution === 'no_action' ? 0 : parseInt(refundAmount || '0', 10);
      if (amount < 0) { showToast('warning', 'El monto no puede ser negativo'); setResolving(false); return; }
      const maxRefund = selected.ride_final_fare_trc ?? selected.ride_estimated_fare_trc ?? 100000;
      if (amount > maxRefund) { showToast('warning', `El reembolso no puede superar ${maxRefund} TRC`); setResolving(false); return; }
      await disputeService.resolveDispute(
        selected.id,
        adminUserId,
        resolution,
        amount,
        resolutionNotes,
      );
      // Update local state
      setDisputes((prev) =>
        prev.map((d) =>
          d.id === selected.id
            ? { ...d, status: resolution === 'no_action' ? 'denied' : 'resolved' as DisputeStatus, resolution, refund_amount_trc: amount }
            : d,
        ),
      );
      setSelected(null);
    } catch (err) {
      // Error handled by UI
      showToast('error', t('disputes.error_resolving'));
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
      const updated = { ...selected, status: 'under_review' as DisputeStatus, assigned_to: adminUserId };
      setSelected(updated);
      setDisputes((prev) => prev.map((d) => (d.id === selected.id ? updated : d)));
    } catch (err) {
      // Error handled by UI
    }
  };

  const handleSaveAdminNotes = async () => {
    if (!selected) return;
    try {
      await disputeService.addAdminNotes(selected.id, adminNotes);
      setSelected((prev) => prev ? { ...prev, admin_notes: adminNotes } : null);
    } catch (err) {
      // Error handled by UI
    }
  };

  const { sortedData: sortedDisputes, toggleSort, sortKey, sortDirection } = useSortableTable(disputes, 'created_at');

  const FILTER_TABS = ['all', 'open', 'under_review', 'awaiting_response', 'resolved', 'denied'] as const;

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6">{t('disputes.title')}</h1>

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); fetchDisputes(); }}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {FILTER_TABS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            aria-pressed={statusFilter === s}
            aria-label={t(`disputes.filter_${s}`)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === s
                ? 'bg-primary-500 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {t(`disputes.filter_${s}`)}
          </button>
        ))}
      </div>

      {/* Sort controls */}
      <div className="flex gap-2 mb-4">
        <SortableHeader label={t('common.date')} sortKey="created_at" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-600" />
        <SortableHeader label={t('disputes.col_priority', { defaultValue: 'Prioridad' })} sortKey="priority" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-600" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Dispute list */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
          <div className="max-h-[650px] overflow-y-auto">
            {loading ? (
              <div className="px-4 py-4">
                <AdminTableSkeleton rows={5} columns={4} />
              </div>
            ) : sortedDisputes.length === 0 ? (
              <div className="text-center py-12 text-neutral-400">
                {t('disputes.no_disputes')}
              </div>
            ) : (
              sortedDisputes.map((dispute) => {
                const sla = getSlaStatus(dispute.sla_resolution_deadline);
                return (
                  <button
                    key={dispute.id}
                    onClick={() => handleSelect(dispute)}
                    aria-label={`${reasonLabelKeys[dispute.reason] ?? dispute.reason} - ${t(`disputes.filter_${dispute.status}`, { defaultValue: dispute.status })}`}
                    className={`w-full text-left px-4 py-3 border-b border-neutral-50 hover:bg-neutral-50 transition-colors ${
                      selected?.id === dispute.id ? 'bg-orange-50' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium truncate pr-2">
                        {dispute.ride_id.slice(0, 8)}… — {reasonLabelKeys[dispute.reason] ?? dispute.reason}
                      </span>
                      <span className={`shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        statusBadge[dispute.status] ?? 'bg-neutral-100'
                      }`}>
                        {t(`disputes.filter_${dispute.status}`, { defaultValue: dispute.status })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        priorityBadge[dispute.priority] ?? ''
                      }`}>
                        {dispute.priority}
                      </span>
                      {sla === 'expired' && (
                        <span className="text-[10px] font-bold text-red-600">{t('disputes.sla_expired')}</span>
                      )}
                      {sla === 'warning' && (
                        <span className="text-[10px] font-bold text-orange-600">{t('disputes.sla_warning')}</span>
                      )}
                      <span className="text-xs text-neutral-400 ml-auto">
                        {formatAdminDate(dispute.created_at)}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Dispute detail */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6" aria-label={t('disputes.detail_panel', { defaultValue: 'Dispute detail' })}>
          {selected ? (
            <div className="max-h-[650px] overflow-y-auto space-y-4">
              {/* Header */}
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">
                  {reasonLabelKeys[selected.reason] ?? selected.reason}
                </h2>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    statusBadge[selected.status] ?? ''
                  }`}>
                    {t(`disputes.filter_${selected.status}`, { defaultValue: selected.status })}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    priorityBadge[selected.priority] ?? ''
                  }`}>
                    {selected.priority}
                  </span>
                </div>
              </div>

              {/* Ride ID */}
              <div className="text-xs text-neutral-400">
                Ride: {selected.ride_id}
              </div>

              {/* Assign button */}
              {!selected.assigned_to && selected.status !== 'resolved' && selected.status !== 'denied' && (
                <button
                  onClick={handleAssignToMe}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-500/10 text-primary-600 hover:bg-primary-500/20"
                >
                  {t('disputes.assign_to_me')}
                </button>
              )}

              {/* Rider statement */}
              <div className="border border-neutral-100 rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-2">{t('disputes.rider_side')}</h3>
                <p className="text-sm text-neutral-700">{selected.description}</p>
                {selected.evidence_urls.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-neutral-400 mb-1">{t('disputes.evidence')}</p>
                    <div className="flex gap-2 flex-wrap">
                      {selected.evidence_urls.map((url, i) => (
                        <a key={i} href={url} target="_blank" rel="noopener" className="text-xs text-primary-500 underline">
                          {t('disputes.evidence')} {i + 1}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Driver response */}
              <div className="border border-neutral-100 rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-2">{t('disputes.driver_side')}</h3>
                {selected.respondent_message ? (
                  <>
                    <p className="text-sm text-neutral-700">{selected.respondent_message}</p>
                    {selected.respondent_evidence_urls.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs text-neutral-400 mb-1">{t('disputes.evidence')}</p>
                        <div className="flex gap-2 flex-wrap">
                          {selected.respondent_evidence_urls.map((url, i) => (
                            <a key={i} href={url} target="_blank" rel="noopener" className="text-xs text-primary-500 underline">
                              {t('disputes.evidence')} {i + 1}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-neutral-400 italic">{t('disputes.no_driver_response')}</p>
                )}
              </div>

              {/* Resolution panel (only for non-resolved) */}
              {selected.status !== 'resolved' && selected.status !== 'denied' && selected.status !== 'closed' && (
                <div className="border-2 border-primary-100 rounded-lg p-4 space-y-3">
                  <h3 className="text-sm font-semibold">{t('disputes.resolution_type')}</h3>

                  <select
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value as DisputeResolution)}
                    aria-label={t('disputes.resolution_type')}
                    className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                  >
                    {RESOLUTION_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {t(`disputes.resolution_${r}`)}
                      </option>
                    ))}
                  </select>

                  {resolution !== 'no_action' && resolution !== 'warning_issued' && (
                    <div>
                      <label className="text-xs text-neutral-500 mb-1 block">{t('disputes.refund_amount')}</label>
                      <input
                        type="number"
                        value={refundAmount}
                        onChange={(e) => { setRefundAmount(e.target.value); setFormErrors((prev) => { const { refundAmount, ...rest } = prev; return rest; }); }}
                        className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 ${formErrors.refundAmount ? 'border-red-500' : 'border-neutral-200'}`}
                        placeholder="0"
                      />
                      {formErrors.refundAmount && <p className="text-red-500 text-xs mt-1">{formErrors.refundAmount}</p>}
                    </div>
                  )}

                  <div>
                    <label className="text-xs text-neutral-500 mb-1 block">{t('disputes.resolution_notes_placeholder')}<span className="text-red-500 ml-1">*</span></label>
                    <textarea
                      value={resolutionNotes}
                      onChange={(e) => { setResolutionNotes(e.target.value); setFormErrors((prev) => { const { resolutionNotes, ...rest } = prev; return rest; }); }}
                      className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 min-h-[80px] ${formErrors.resolutionNotes ? 'border-red-500' : 'border-neutral-200'}`}
                      placeholder={t('disputes.resolution_notes_placeholder')}
                    />
                    {formErrors.resolutionNotes && <p className="text-red-500 text-xs mt-1">{formErrors.resolutionNotes}</p>}
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={handleResolve}
                      disabled={resolving || !resolutionNotes.trim()}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {resolution === 'no_action' ? t('disputes.deny') : t('disputes.resolve')}
                    </button>
                  </div>
                </div>
              )}

              {/* Resolved info */}
              {(selected.status === 'resolved' || selected.status === 'denied') && selected.resolution && (
                <div className="border border-green-200 rounded-lg p-4 bg-green-50">
                  <h3 className="text-sm font-semibold mb-1">
                    {t(`disputes.resolution_${selected.resolution}`)}
                  </h3>
                  {selected.refund_amount_trc != null && selected.refund_amount_trc > 0 && (
                    <p className="text-sm text-green-700">
                      {t('disputes.refund_amount')}: {formatTRC(selected.refund_amount_trc)}
                    </p>
                  )}
                  {selected.resolution_notes && (
                    <p className="text-sm text-neutral-600 mt-1">{selected.resolution_notes}</p>
                  )}
                </div>
              )}

              {/* Admin notes */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{t('disputes.admin_notes')}</h3>
                <textarea
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  aria-label={t('disputes.admin_notes')}
                  className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 min-h-[60px]"
                  placeholder={t('disputes.admin_notes_placeholder')}
                />
                <button
                  onClick={handleSaveAdminNotes}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                >
                  {t('common.save')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[650px] text-neutral-400">
              {t('disputes.select_dispute')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
