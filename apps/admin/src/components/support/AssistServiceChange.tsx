'use client';

/**
 * Switch a waiting ride to another vehicle type (00628). The price is quoted here with the
 * code the rider app uses (rideService.getLocalFareEstimate), on Havana time and for the
 * rider. Support then proposes it to the rider in the app, or applies it with the rider's
 * WhatsApp consent. The admin has no Mapbox token, so the route comes from OSRM: the price
 * can differ a little from what the rider app would show, and the rider consents to this one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { rideAssistService, rideService, type RideAssistContext } from '@tricigo/api';
import type { ServiceTypeConfig, ServiceTypeSlug } from '@tricigo/types';
import { formatCUP } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { assistErrorKey } from './assistErrors';

/** A price is only ever shown, proposed or applied together with the type it was quoted for. */
interface Quote {
  target: ServiceTypeSlug;
  fare: number;
}

interface Props {
  ride: RideAssistContext['ride'];
  configs: ServiceTypeConfig[];
  /** The latest proposal's state, already worded by the page, or null. */
  proposalLine: string | null;
  onChanged: () => void;
}

export function AssistServiceChange({ ride, configs, proposalLine, onChanged }: Props) {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [target, setTarget] = useState<ServiceTypeSlug | ''>('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [reason, setReason] = useState('');

  // Only the latest quote request may write: an answer for a type support has since left
  // would put that type's price next to another type, and Proponer/Aplicar would send both.
  const latestQuote = useRef(0);

  // The ride's type changed (applied here, or the rider accepted): start over, and drop any
  // quote still in flight for the old situation.
  useEffect(() => {
    latestQuote.current++;
    setTarget('');
    setQuote(null);
    setQuoting(false);
    setApplyOpen(false);
  }, [ride.service_type]);

  // The same refusals as _ride_service_change_error, so support is not offered a dead end.
  // Only passenger types: a type without a passenger capacity (null or 0) carries cargo.
  const blocked = ride.ride_mode === 'cargo' || ride.is_corporate || ride.has_waypoints;
  const targets = useMemo(
    () =>
      configs.filter(
        (c) =>
          c.is_active &&
          c.slug !== 'mensajeria' &&
          c.slug !== ride.service_type &&
          (c.max_passengers ?? 0) > 0 &&
          ride.passenger_count <= c.max_passengers,
      ),
    [configs, ride.service_type, ride.passenger_count],
  );
  const typeName = (slug: string) => configs.find((c) => c.slug === slug)?.name_es ?? slug;
  // The quote on screen, only while it is for the type selected now.
  const shownQuote = quote && quote.target === target ? quote : null;
  const closeApply = useCallback(() => setApplyOpen(false), []);

  const calculate = async () => {
    if (!target) return;
    // Old rows can lack coordinates (typed number, NULL in the database): never quote a price
    // from a route that does not exist.
    const coords = [ride.pickup_lat, ride.pickup_lng, ride.dropoff_lat, ride.dropoff_lng];
    if (!coords.every((n) => Number.isFinite(n))) {
      showToast('error', t('ride_assist.change_quote_error'));
      return;
    }
    const seq = ++latestQuote.current;
    const quoted = target;
    setQuoting(true);
    setQuote(null);
    try {
      const estimate = await rideService.getLocalFareEstimate({
        service_type: quoted,
        pickup_lat: ride.pickup_lat,
        pickup_lng: ride.pickup_lng,
        dropoff_lat: ride.dropoff_lat,
        dropoff_lng: ride.dropoff_lng,
        for_user_id: ride.customer_id,
        time_zone: 'America/Havana',
      });
      if (seq !== latestQuote.current) return;
      setQuote({ target: quoted, fare: estimate.estimated_fare_cup });
    } catch {
      if (seq !== latestQuote.current) return;
      showToast('error', t('ride_assist.change_quote_error'));
    } finally {
      if (seq === latestQuote.current) setQuoting(false);
    }
  };

  const propose = async () => {
    const q = shownQuote;
    if (!q) return;
    setProposing(true);
    try {
      await rideAssistService.changeServiceType(ride.id, q.target, q.fare, 'propose');
      showToast('success', t('ride_assist.change_proposed'));
      onChanged();
    } catch (err) {
      showToast('error', t(assistErrorKey(err)));
      onChanged();
    } finally {
      setProposing(false);
    }
  };

  const apply = async () => {
    const q = shownQuote;
    if (!q) return;
    const why = reason.trim();
    if (!why) {
      showToast('error', t('ride_assist.error_reason_required'));
      return;
    }
    try {
      await rideAssistService.changeServiceType(ride.id, q.target, q.fare, 'apply', why);
      showToast('success', t('ride_assist.change_applied', { type: typeName(q.target) }));
      setApplyOpen(false);
      setReason('');
      onChanged();
    } catch (err) {
      showToast('error', t(assistErrorKey(err)));
      onChanged();
    }
  };

  return (
    <section className="mb-6 rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
      <h2 className="mb-4 text-lg font-bold">{t('ride_assist.change_card')}</h2>
      {proposalLine && <p className="mb-4 rounded-lg bg-surface-sunken px-3 py-2 text-sm text-ink">{proposalLine}</p>}

      {blocked ? (
        <p className="text-sm text-ink-muted">{t('ride_assist.change_blocked')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              {t('ride_assist.change_target')}
              <select
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value as ServiceTypeSlug | '');
                  setQuote(null);
                }}
                disabled={quoting}
                className="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">—</option>
                {targets.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name_es}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void calculate()}
              disabled={!target || quoting}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('ride_assist.change_quote')}
            </button>
          </div>

          {shownQuote && (
            <>
              <p className="text-sm font-medium text-ink">
                {t('ride_assist.change_price', {
                  price: formatCUP(shownQuote.fare),
                  current: formatCUP(ride.estimated_fare_cup),
                })}
              </p>
              {ride.shared_ride && shownQuote.target !== 'triciclo_basico' && (
                <p className="text-sm text-amber-800 dark:text-amber-400">{t('ride_assist.change_shared_lost')}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void propose()}
                  disabled={proposing}
                  className="rounded-lg bg-primary-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('ride_assist.change_propose')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReason('');
                    setApplyOpen(true);
                  }}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-ink hover:bg-surface-sunken"
                >
                  {t('ride_assist.change_apply')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <AdminConfirmModal
        open={applyOpen}
        title={t('ride_assist.change_apply_title', {
          type: shownQuote ? typeName(shownQuote.target) : '',
          price: shownQuote ? formatCUP(shownQuote.fare) : '',
        })}
        message={t('ride_assist.change_apply_message')}
        confirmLabel={t('ride_assist.change_apply')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        onConfirm={apply}
        onCancel={closeApply}
        inputValue={reason}
        onInputChange={setReason}
        inputPlaceholder={t('ride_assist.assign_reason_placeholder')}
      />
    </section>
  );
}
