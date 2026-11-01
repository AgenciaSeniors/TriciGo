'use client';

/**
 * The drivers support can send a waiting ride to (admin_ride_assist_candidates, 00628):
 * online first, then by distance to the pickup. "Enviar oferta" puts the ride on the driver's
 * screen like any offer; "Asignar directo" gives it to them at once, with a reason.
 * Support can also look at drivers of another type, to call them before changing the ride's
 * type; the actions stay off until the ride is of their type.
 * Every row says the driver's vehicle type. A list that mixes types (a car ride takes Auto and
 * Confort, a delivery takes any vehicle that carries cargo) can be narrowed to one of them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Phone } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { rideAssistService, type AssistCandidate, type RideOfferStatus } from '@tricigo/api';
import type { VehicleType } from '@tricigo/types';
import { waMeLink } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { VEHICLE_TYPE_LABEL, labelFor } from '@/lib/labels';
import { assistErrorKey } from './assistErrors';
import { agoLabel, telLink } from './supportFormat';
import { VEHICLE_TYPE_ORDER, VehicleTypeChip } from './VehicleTypeChip';

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
  /** Shows the offer and assign buttons (rides.act). */
  allowed?: boolean;
}

const CHIP = 'rounded-full px-2 py-0.5 text-xs font-semibold';
const LINK_BTN =
  'inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-sunken';
// The tab look of FilterBar.
const FILTER_BTN =
  'inline-flex flex-shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-all';
const FILTER_ON = 'border-line-strong bg-surface text-ink shadow-elev-1';
const FILTER_OFF = 'border-transparent text-ink-muted hover:bg-surface-sunken';

export function AssistCandidates({ rideId, rideServiceType, pickupAddress, typeOptions, onChanged, allowed = true }: Props) {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [serviceType, setServiceType] = useState(rideServiceType);
  const [rows, setRows] = useState<AssistCandidate[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [assignTo, setAssignTo] = useState<AssistCandidate | null>(null);
  const [reason, setReason] = useState('');
  const [vehicleFilter, setVehicleFilter] = useState<VehicleType | null>(null);

  // When the ride's type changes (support applied it, or the rider accepted), the list follows.
  useEffect(() => {
    setServiceType(rideServiceType);
  }, [rideServiceType]);

  // A filter belongs to the list it was picked on.
  useEffect(() => {
    setVehicleFilter(null);
  }, [serviceType]);

  // How many drivers of each type the list has, in VEHICLE_TYPE_ORDER.
  const typeCounts = useMemo(() => {
    const counts = new Map<VehicleType, number>();
    for (const c of rows ?? []) counts.set(c.vehicle_type, (counts.get(c.vehicle_type) ?? 0) + 1);
    return VEHICLE_TYPE_ORDER.filter((type) => counts.has(type)).map((type) => ({ type, count: counts.get(type) ?? 0 }));
  }, [rows]);
  // A type that a refresh left out of the list stops filtering it.
  const activeFilter = vehicleFilter !== null && typeCounts.some((c) => c.type === vehicleFilter) ? vehicleFilter : null;
  const shownRows = rows === null || activeFilter === null ? rows : rows.filter((c) => c.vehicle_type === activeFilter);

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

      {otherType && allowed && (
        <p className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-400">
          {t('ride_assist.candidates_other_type')}
        </p>
      )}
      {loadFailed && <p className="mb-3 text-sm text-red-700 dark:text-red-400">{t('ride_assist.load_error')}</p>}
      {rows !== null && rows.length === 0 && !loadFailed && (
        <p className="text-sm text-ink-muted">{t('ride_assist.candidates_empty')}</p>
      )}

      {typeCounts.length > 1 && rows !== null && (
        <div role="group" aria-label={t('ride_assist.vehicle_filter')} className="mb-2 flex flex-wrap items-center gap-1">
          {[{ type: null, count: rows.length }, ...typeCounts].map(({ type, count }) => {
            const on = type === activeFilter;
            return (
              <button
                key={type ?? 'all'}
                type="button"
                aria-pressed={on}
                onClick={() => setVehicleFilter(type)}
                className={`${FILTER_BTN} ${on ? FILTER_ON : FILTER_OFF}`}
              >
                <span className="whitespace-nowrap">
                  {type === null ? t('ride_assist.vehicle_all') : labelFor(t, VEHICLE_TYPE_LABEL, type)}
                </span>
                <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-ink-muted" data-tabular>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {shownRows !== null && shownRows.length > 0 && (
        <ul className="divide-y divide-line">
          {shownRows.map((c) => {
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
                    <VehicleTypeChip type={c.vehicle_type} />
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
                  {allowed && (
                    <>
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
                    </>
                  )}
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
