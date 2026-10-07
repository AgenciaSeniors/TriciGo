'use client';

/**
 * The drivers support can send a waiting ride to (admin_ride_assist_candidates, 00628):
 * online first, then by distance to the pickup. "Enviar oferta" puts the ride on the driver's
 * screen like any offer; "Asignar directo" gives it to them at once, with a reason.
 * Support can also look at drivers of another type, to call them before changing the ride's
 * type; the actions stay off until the ride is of their type.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Phone } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { rideAssistService, type AssistCandidate, type RideOfferStatus } from '@tricigo/api';
import { waMeLink } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { assistErrorKey } from './assistErrors';
import { agoLabel, telLink } from './supportFormat';

export interface ServiceTypeOption {
  slug: string;
  name: string;
}

interface Props {
  rideId: string;
  rideServiceType: string;
  pickupAddress: string;
  typeOptions: ServiceTypeOption[];
  onChanged: () => void;
}

const CHIP = 'rounded-full px-2 py-0.5 text-xs font-semibold';
const LINK_BTN =
  'inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-sunken';

export function AssistCandidates({ rideId, rideServiceType, pickupAddress, typeOptions, onChanged }: Props) {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [serviceType, setServiceType] = useState(rideServiceType);
  const [rows, setRows] = useState<AssistCandidate[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [assignTo, setAssignTo] = useState<AssistCandidate | null>(null);
  const [reason, setReason] = useState('');

  // When the ride's type changes (support applied it, or the rider accepted), the list follows.
  useEffect(() => {
    setServiceType(rideServiceType);
  }, [rideServiceType]);

  const otherType = serviceType !== rideServiceType;
  const options = typeOptions.some((o) => o.slug === rideServiceType)
    ? typeOptions
    : [{ slug: rideServiceType, name: rideServiceType }, ...typeOptions];

  // Only the latest request may write: when the ride's type changes, an older request for the
  // previous type can answer last and would list drivers the server now refuses.
  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const seq = ++latestLoad.current;
    try {
      const next = await rideAssistService.getCandidates(
        rideId,
        serviceType === rideServiceType ? undefined : serviceType,
      );
      if (seq !== latestLoad.current) return;
      setRows(next);
      setLoadFailed(false);
      setNow(Date.now());
    } catch {
      if (seq !== latestLoad.current) return;
      setLoadFailed(true);
    }
  }, [rideId, serviceType, rideServiceType]);

  useEffect(() => {
    void load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [load]);

  // Stable, so the modal does not re-run its focus effect on every parent render.
  const closeAssign = useCallback(() => setAssignTo(null), []);

  const offer = async (c: AssistCandidate) => {
    setBusyId(c.driver_profile_id);
    try {
      const r = await rideAssistService.offerToDriver(rideId, c.driver_profile_id);
      const key =
        r.mode === 'created'
          ? 'ride_assist.offer_created'
          : r.mode === 'extended'
            ? 'ride_assist.offer_extended'
            : 'ride_assist.offer_rearmed';
      showToast('success', t(key, { name: c.full_name }));
      onChanged();
      void load();
    } catch (err) {
      showToast('error', t(assistErrorKey(err)));
      onChanged(); // the ride may have been taken or canceled meanwhile: show what it is now
    } finally {
      setBusyId(null);
    }
  };

  const confirmAssign = async () => {
    if (!assignTo) return;
    const why = reason.trim();
    if (!why) {
      showToast('error', t('ride_assist.error_reason_required'));
      return;
    }
    try {
      await rideAssistService.assignToDriver(rideId, assignTo.driver_profile_id, why);
      showToast('success', t('ride_assist.assigned', { name: assignTo.full_name }));
      setAssignTo(null);
      setReason('');
      onChanged();
    } catch (err) {
      showToast('error', t(assistErrorKey(err)));
      onChanged();
    }
  };

  return (
    <section className="mb-6 rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">{t('ride_assist.candidates_card')}</h2>
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          {t('ride_assist.candidates_type')}
          <select
            value={serviceType}
            onChange={(e) => setServiceType(e.target.value)}
            className="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink"
          >
            {options.map((o) => (
              <option key={o.slug} value={o.slug}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {otherType && (
        <p className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-400">
          {t('ride_assist.candidates_other_type')}
        </p>
      )}
      {loadFailed && <p className="mb-3 text-sm text-red-700 dark:text-red-400">{t('ride_assist.load_error')}</p>}
      {rows !== null && rows.length === 0 && !loadFailed && (
        <p className="text-sm text-ink-muted">{t('ride_assist.candidates_empty')}</p>
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="divide-y divide-line">
          {rows.map((c) => {
            const wa = waMeLink(c.phone, t('ride_assist.driver_whatsapp_text', { pickup: pickupAddress }));
            const tel = telLink(c.phone);
            const offerLapsed =
              c.offer_status === 'pending' && c.offer_expires_at !== null && new Date(c.offer_expires_at).getTime() <= now;
            const offerShown: RideOfferStatus | null = offerLapsed ? 'expired' : c.offer_status;
            const canAct = !otherType && busyId === null;
            return (
              <li key={c.driver_profile_id} className="flex flex-col gap-2 py-3 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{c.full_name}</p>
                  <p className="truncate text-xs text-ink-muted">{c.vehicle_label}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {c.is_online ? (
                      <span className={`${CHIP} bg-green-500/10 text-green-700 dark:text-green-400`}>
                        {t('ride_assist.online')}
                      </span>
                    ) : (
                      <span className={`${CHIP} bg-surface-sunken text-ink-muted`}>
                        {c.last_heartbeat_at
                          ? t('ride_assist.offline_seen', { time: agoLabel(c.last_heartbeat_at, now) })
                          : t('ride_assist.seen_never')}
                      </span>
                    )}
                    {c.distance_m !== null && (
                      <span className="text-xs text-ink-muted">
                        {t('ride_assist.distance_km', { km: (c.distance_m / 1000).toFixed(1) })}
                      </span>
                    )}
                    {c.busy_ride_id && (
                      <span className={`${CHIP} bg-amber-500/10 text-amber-800 dark:text-amber-400`}>
                        {t('ride_assist.chip_busy')}
                      </span>
                    )}
                    {!c.can_afford && (
                      <span className={`${CHIP} bg-red-500/10 text-red-700 dark:text-red-400`}>
                        {t('ride_assist.chip_no_balance')}
                      </span>
                    )}
                    {offerShown && (
                      <span className={`${CHIP} bg-surface-sunken text-ink-muted`}>
                        {t(`ride_assist.offer_status_${offerShown}`)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {wa && (
                    <a href={wa} target="_blank" rel="noopener noreferrer" className={LINK_BTN}>
                      <MessageCircle className="h-3.5 w-3.5" />
                      {t('ride_assist.whatsapp')}
                    </a>
                  )}
                  {tel && (
                    <a href={tel} className={LINK_BTN}>
                      <Phone className="h-3.5 w-3.5" />
                      {t('ride_assist.call')}
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => void offer(c)}
                    disabled={!canAct}
                    className="rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('ride_assist.send_offer')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReason('');
                      setAssignTo(c);
                    }}
                    disabled={!canAct || !c.is_online || c.busy_ride_id !== null}
                    className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('ride_assist.assign')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AdminConfirmModal
        open={assignTo !== null}
        title={t('ride_assist.assign_title', { name: assignTo?.full_name ?? '' })}
        message={t('ride_assist.assign_message', { name: assignTo?.full_name ?? '' })}
        confirmLabel={t('ride_assist.assign_confirm')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        onConfirm={confirmAssign}
        onCancel={closeAssign}
        inputValue={reason}
        onInputChange={setReason}
        inputPlaceholder={t('ride_assist.assign_reason_placeholder')}
      />
    </section>
  );
}
