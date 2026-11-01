'use client';

/**
 * The assist page's view for a ride that already has a driver (00660): who is involved and how to
 * reach them, where the ride is, what finishing it would charge, and the actions the server allows
 * for its status. Every action asks for a reason and is refused if the ride changed meanwhile: it
 * sends back the status, the driver and the total support saw when they opened the dialog.
 */

import { useCallback, useState } from 'react';
import { MessageCircle, Phone } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { rideAssistService, type ActiveRideAction, type ActiveRideContext } from '@tricigo/api';
import { formatCUP, waMeLink } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { formatAdminDate } from '@/lib/formatDate';
import { rideTypeLabel } from '@/lib/rideType';
import { assistErrorKey, serverErrorMessage } from './assistErrors';
import { agoLabel, telLink } from './supportFormat';
import { VehicleTypeChip } from './VehicleTypeChip';

const CARD = 'rounded-xl border border-line bg-surface-elevated p-6 shadow-sm';
const LINK_BTN =
  'inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken';
// White on primary-700 passes AA (5.5:1); on primary-600 it does not (4.05:1).
const ACTION_BTN =
  'rounded-lg bg-primary-700 px-4 py-2 text-sm font-medium text-white hover:bg-primary-800 disabled:opacity-50';
// White on amber-700 passes AA (5.0:1); on amber-600 it does not (3.2:1).
const DANGER_BTN =
  'rounded-lg bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50';

/**
 * The dialog's action, frozen when support clicks the button. The 10 s poll keeps this component
 * and replaces the context under an open dialog: the action sends what support read in the
 * dialog, never the newer context, so the server can refuse it with ride_changed or amount_changed.
 */
interface PendingAction {
  kind: ActiveRideAction;
  status: string;
  driverId: string;
  totalCup: number | null;
  title: string;
  message: string;
}

const ADVANCE_LABEL: Record<string, string> = {
  accepted: 'ride_assist.action_advance_arrived',
  driver_en_route: 'ride_assist.action_advance_arrived',
  arrived_at_pickup: 'ride_assist.action_advance_started',
  in_progress: 'ride_assist.action_advance_destination',
};

export function AssistActiveRide({
  ctx,
  now,
  onChanged,
  allowed = true,
}: {
  ctx: ActiveRideContext;
  now: number;
  /** Reloads the page; the buttons stay disabled until it settles. */
  onChanged: () => Promise<void>;
  /** Shows the advance, complete and release buttons (rides.act). */
  allowed?: boolean;
}) {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const { ride, driver, last_point: point, alert, preview } = ctx;
  // The driver support saw. Every action sends it back; without it the actions stay hidden.
  const driverId = ctx.driver_profile_id;
  const riderWa = waMeLink(ride.customer_phone, t('ride_assist.rider_whatsapp_text', { code: ride.code }));
  const riderTel = telLink(ride.customer_phone);
  const driverWa = waMeLink(driver?.phone ?? null, t('ride_assist.active_driver_whatsapp_text', { code: ride.code }));
  const driverTel = telLink(driver?.phone);
  const beforePickup = ride.status === 'accepted' || ride.status === 'driver_en_route';
  const towardPickup = beforePickup || ride.status === 'arrived_at_pickup';
  const can = (a: ActiveRideAction) => driverId != null && ctx.allowed_actions.includes(a);
  const showAdvance = can('advance') && !!ADVANCE_LABEL[ride.status];
  const showComplete = can('complete') && !!preview;
  const showRelease = can('release');
  const hasActions = showAdvance || showComplete || showRelease;
  // A ride scheduled for later gets no action from the server until its time (00660).
  const scheduledLater =
    ctx.allowed_actions.length === 0 && !!ride.scheduled_at && new Date(ride.scheduled_at).getTime() > now;
  // The later of the phone's time and the server's receipt, as the server orders the trail.
  const pointAt =
    point && point.received_at && Date.parse(point.received_at) > Date.parse(point.recorded_at)
      ? point.received_at
      : point?.recorded_at ?? null;
  const totalNow = preview?.total_cup ?? null;
  // The ride moved on under the open dialog: the server will refuse the action, so say it now.
  const pendingStale =
    pending !== null && (pending.status !== ride.status || pending.driverId !== driverId || pending.totalCup !== totalNow);

  const titleFor = (kind: ActiveRideAction) =>
    kind === 'release'
      ? t('ride_assist.action_release')
      : kind === 'complete'
        ? t('ride_assist.action_complete')
        : t(ADVANCE_LABEL[ride.status] ?? 'ride_assist.actions_card');

  const messageFor = (kind: ActiveRideAction) => {
    if (kind === 'release') {
      const name = driver?.full_name?.trim() || t('ride_assist.release_driver_fallback');
      return t('ride_assist.confirm_release_message', { name });
    }
    if (kind === 'complete') return t('ride_assist.confirm_complete_message', { total: formatCUP(totalNow ?? 0) });
    if (beforePickup) return t('ride_assist.confirm_arrived_message');
    if (ride.status === 'arrived_at_pickup') {
      const vars = {
        time: ctx.start_pickup_at ? formatAdminDate(ctx.start_pickup_at) : '',
        source: t(`ride_assist.source_${ctx.start_pickup_source ?? 'now'}`),
      };
      return preview
        ? t('ride_assist.confirm_started_message', { ...vars, wait: formatCUP(preview.wait_cup) })
        : t('ride_assist.confirm_started_message_no_price', vars);
    }
    return t('ride_assist.confirm_destination_message');
  };

  const open = (kind: ActiveRideAction) => {
    if (!driverId) return;
    setReason('');
    setPending({ kind, status: ride.status, driverId, totalCup: totalNow, title: titleFor(kind), message: messageFor(kind) });
  };

  // Stable, so the modal does not re-run its focus effect on every parent render.
  const close = useCallback(() => {
    setPending(null);
    setReason('');
  }, []);

  const confirm = async () => {
    const why = reason.trim();
    if (why.length < 3) {
      showToast('error', t('ride_assist.error_reason_required'));
      return;
    }
    if (!pending) return;
    // Only what support saw when the dialog opened.
    const { kind, status, driverId: sawDriver, totalCup } = pending;
    setBusy(true);
    try {
      if (kind === 'release') {
        await rideAssistService.releaseActiveRide(ride.id, status, sawDriver, why);
        showToast('success', t('ride_assist.done_release'));
      } else if (kind === 'advance') {
        const r = await rideAssistService.advanceActiveRide(ride.id, status, sawDriver, why);
        showToast(
          'success',
          r.status === 'in_progress'
            ? t('ride_assist.done_started', { time: formatAdminDate(r.pickup_at), wait: formatCUP(r.wait_cup) })
            : t('ride_assist.done_advance'),
        );
      } else if (kind === 'complete' && totalCup !== null) {
        const r = await rideAssistService.completeActiveRide(ride.id, status, sawDriver, totalCup, why);
        if (typeof r.cash_amount_cup === 'number' && r.cash_amount_cup > 0) {
          // Support has to pass this on to a driver whose app is down: keep it up longer.
          showToast(
            'success',
            t('ride_assist.done_complete_cash', { total: formatCUP(r.final_fare_cup), cash: formatCUP(r.cash_amount_cup) }),
            20_000,
          );
        } else {
          showToast('success', t('ride_assist.done_complete', { total: formatCUP(r.final_fare_cup) }));
        }
      }
      close();
    } catch (err) {
      // A refusal has its own message. Anything else the server raised (complete_ride_and_pay
      // failing to charge, for example) is shown as the server worded it.
      const key = assistErrorKey(err);
      const serverMessage = key === 'ride_assist.error_generic' ? serverErrorMessage(err) : null;
      showToast('error', serverMessage ? t('ride_assist.error_server', { message: serverMessage }) : t(key));
      close();
    } finally {
      // The reload shows what changed; the buttons stay disabled until it lands.
      await onChanged().catch(() => undefined);
      setBusy(false);
    }
  };

  return (
    <>
      <p className="mb-4 text-sm font-medium text-ink-muted">
        {t('ride_assist.active_title')} ·{' '}
        {t('ride_assist.active_status', { status: t(`ride_assist.status_${ride.status}`, { defaultValue: ride.status }) })}
      </p>

      {alert && (
        <div className="mb-6 rounded-xl bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-400">
          {t('ride_assist.alert', {
            reason: t(`ride_assist.alert_${alert.reason}`, { defaultValue: alert.reason }),
            ago: agoLabel(alert.detected_at, now),
          })}
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className={CARD}>
          <h2 className="mb-4 text-lg font-bold">{t('ride_assist.ride_card')}</h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-ink-muted">{t('ride_assist.origin')}</dt>
              <dd className="font-medium text-ink">{ride.pickup_address}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">{t('ride_assist.destination')}</dt>
              <dd className="font-medium text-ink">{ride.dropoff_address}</dd>
            </div>
            <div className="flex flex-wrap gap-6">
              <div>
                <dt className="text-ink-muted">{t('ride_assist.service')}</dt>
                <dd className="font-medium text-ink">{rideTypeLabel(t, ride.service_type)}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('ride_assist.payment')}</dt>
                <dd className="font-medium text-ink">
                  {t(`rides.payment_${ride.payment_method}`, { defaultValue: ride.payment_method })}
                </dd>
              </div>
            </div>
            <div className="flex flex-wrap gap-6">
              {ride.accepted_at && (
                <div>
                  <dt className="text-ink-muted">{t('ride_assist.times_accepted')}</dt>
                  <dd className="font-medium text-ink">{formatAdminDate(ride.accepted_at)}</dd>
                </div>
              )}
              {ride.driver_arrived_at && (
                <div>
                  <dt className="text-ink-muted">{t('ride_assist.times_arrived')}</dt>
                  <dd className="font-medium text-ink">{formatAdminDate(ride.driver_arrived_at)}</dd>
                </div>
              )}
              {ride.pickup_at && (
                <div>
                  <dt className="text-ink-muted">{t('ride_assist.times_pickup')}</dt>
                  <dd className="font-medium text-ink">{formatAdminDate(ride.pickup_at)}</dd>
                </div>
              )}
            </div>
            <p className="text-ink-muted">
              {point && pointAt
                ? t('ride_assist.last_point', {
                    ago: agoLabel(pointAt, now),
                    meters: towardPickup ? point.distance_to_pickup_m : point.distance_to_dropoff_m,
                    target: t(towardPickup ? 'ride_assist.target_pickup' : 'ride_assist.target_dropoff'),
                  })
                : t('ride_assist.last_point_none')}
            </p>
          </dl>
        </section>

        <section className={CARD}>
          <h2 className="mb-4 text-lg font-bold">{t('ride_assist.rider')}</h2>
          <p className="text-sm font-medium text-ink">{ride.customer_name}</p>
          <p className="text-sm text-ink-muted">{ride.customer_phone ?? '—'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {riderWa && (
              <a href={riderWa} target="_blank" rel="noopener noreferrer" className={LINK_BTN}>
                <MessageCircle className="h-4 w-4" />
                {t('ride_assist.whatsapp')}
              </a>
            )}
            {riderTel && (
              <a href={riderTel} className={LINK_BTN}>
                <Phone className="h-4 w-4" />
                {t('ride_assist.call')}
              </a>
            )}
          </div>

          {driver && (
            <>
              <h2 className="mb-2 mt-6 text-lg font-bold">{t('ride_assist.driver')}</h2>
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                {driver.full_name}
                {driver.vehicle_type && <VehicleTypeChip type={driver.vehicle_type} />}
              </p>
              <p className="text-sm text-ink-muted">
                {driver.phone ?? '—'}
                {driver.vehicle_label ? ` · ${driver.vehicle_label}` : ''}
              </p>
              <p className="text-sm text-ink-muted">
                {t(driver.is_online ? 'ride_assist.driver_online' : 'ride_assist.driver_offline')}
                {driver.last_heartbeat_at ? ` · ${t('ride_assist.heartbeat_ago', { ago: agoLabel(driver.last_heartbeat_at, now) })}` : ''}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {driverWa && (
                  <a href={driverWa} target="_blank" rel="noopener noreferrer" className={LINK_BTN}>
                    <MessageCircle className="h-4 w-4" />
                    {t('ride_assist.whatsapp')}
                  </a>
                )}
                {driverTel && (
                  <a href={driverTel} className={LINK_BTN}>
                    <Phone className="h-4 w-4" />
                    {t('ride_assist.call')}
                  </a>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <section className={`${CARD} mb-6`}>
        <h2 className="mb-4 text-lg font-bold">{t('ride_assist.charge_card')}</h2>
        {!preview ? (
          <p className="text-sm text-ink-muted">{t('ride_assist.charge_none')}</p>
        ) : (
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-muted">{t('ride_assist.charge_agreed')}</dt>
              <dd className="font-medium text-ink">{formatCUP(preview.agreed_cup)}</dd>
            </div>
            {preview.discount_cup > 0 && (
              <div className="flex justify-between">
                <dt className="text-ink-muted">{t('ride_assist.charge_discount')}</dt>
                <dd className="font-medium text-ink">−{formatCUP(preview.discount_cup)}</dd>
              </div>
            )}
            {beforePickup ? (
              <p className="text-ink-muted">{t('ride_assist.charge_not_yet')}</p>
            ) : (
              <>
                <div className="flex justify-between">
                  <dt className="text-ink-muted">
                    {t('ride_assist.charge_wait', { minutes: preview.wait_minutes, billable: preview.billable_minutes })}
                  </dt>
                  <dd className="font-medium text-ink">{formatCUP(preview.wait_cup)}</dd>
                </div>
                {preview.insurance_cup > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">{t('ride_assist.charge_insurance')}</dt>
                    <dd className="font-medium text-ink">{formatCUP(preview.insurance_cup)}</dd>
                  </div>
                )}
                <div className="flex justify-between border-t border-line pt-2">
                  <dt className="font-semibold text-ink">{t('ride_assist.charge_total')}</dt>
                  <dd className="font-bold text-ink">{formatCUP(preview.total_cup)}</dd>
                </div>
                {preview.is_corporate && <p className="text-ink-muted">{t('ride_assist.charge_corporate')}</p>}
              </>
            )}
          </dl>
        )}
      </section>

      {((allowed && hasActions) || ctx.delivery_proof_missing || scheduledLater) && (
        <section className={`${CARD} mb-6`}>
          <h2 className="mb-4 text-lg font-bold">{t('ride_assist.actions_card')}</h2>
          {scheduledLater && <p className="mb-4 text-sm text-ink-muted">{t('ride_assist.scheduled_later_note')}</p>}
          {ctx.delivery_proof_missing && (
            <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-400">
              {/* The driver's app asks for the proof only while the ride is in progress (DriverTripView):
                  before that the note warns against marking the destination, at it, it says to cancel. */}
              {t(
                ride.status === 'arrived_at_destination'
                  ? 'ride_assist.delivery_proof_missing_note_at_destination'
                  : 'ride_assist.delivery_proof_missing_note',
              )}
            </p>
          )}
          {allowed && hasActions && (
            <div className="flex flex-wrap gap-3">
              {showAdvance && (
                <button type="button" disabled={busy} className={ACTION_BTN} onClick={() => open('advance')}>
                  {t(ADVANCE_LABEL[ride.status]!)}
                </button>
              )}
              {showComplete && (
                <button type="button" disabled={busy} className={ACTION_BTN} onClick={() => open('complete')}>
                  {t('ride_assist.action_complete')}
                </button>
              )}
              {showRelease && (
                <button type="button" disabled={busy} className={DANGER_BTN} onClick={() => open('release')}>
                  {t('ride_assist.action_release')}
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <AdminConfirmModal
        open={pending !== null}
        title={pending?.title ?? ''}
        message={
          pending
            ? pendingStale
              ? `${t('ride_assist.error_ride_changed')} ${pending.message}`
              : pending.message
            : ''
        }
        confirmLabel={t('common.confirm', { defaultValue: 'Confirmar' })}
        cancelLabel={t('common.cancel')}
        variant={pending?.kind === 'release' ? 'warning' : 'default'}
        onConfirm={confirm}
        onCancel={close}
        inputValue={reason}
        onInputChange={setReason}
        inputPlaceholder={t('ride_assist.reason_placeholder')}
      />
    </>
  );
}
