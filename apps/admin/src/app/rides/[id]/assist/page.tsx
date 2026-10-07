'use client';

/**
 * /rides/[id]/assist — support helps a waiting ride find a driver (00628): send it to a
 * chosen driver, assign it directly, or switch its vehicle type with the rider's consent.
 * The ride is re-read every 10 s; the candidates refresh on their own every 20 s.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { MessageCircle, Phone } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import {
  adminService,
  rideAssistService,
  RIDE_ASSIST_UNAVAILABLE,
  type RideAssistContext,
  type RideOfferStatus,
} from '@tricigo/api';
import type { ServiceTypeConfig } from '@tricigo/types';
import { formatCUP, waMeLink } from '@tricigo/utils';
import { AdminBreadcrumb } from '@/components/ui/AdminBreadcrumb';
import { AssistCandidates } from '@/components/support/AssistCandidates';
import { AssistServiceChange } from '@/components/support/AssistServiceChange';
import { telLink, waitLabel } from '@/components/support/supportFormat';
import { formatAdminDate } from '@/lib/formatDate';

const CARD = 'rounded-xl border border-line bg-surface-elevated p-6 shadow-sm';
const LINK_BTN =
  'inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken';

// Text -700 on a -500/10 tint (amber -800) passes AA on every admin surface (CLAUDE.md).
const OFFER_CHIP: Record<RideOfferStatus, string> = {
  pending: 'bg-amber-500/10 text-amber-800 dark:text-amber-400',
  accepted: 'bg-green-500/10 text-green-700 dark:text-green-400',
  rejected: 'bg-red-500/10 text-red-700 dark:text-red-400',
  expired: 'bg-surface-sunken text-ink-muted',
  superseded: 'bg-surface-sunken text-ink-muted',
};

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

export default function RideAssistPage() {
  const { t } = useTranslation('admin');
  const { id } = useParams<{ id: string }>();
  const [ctx, setCtx] = useState<RideAssistContext | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [state, setState] = useState<LoadState>('loading');
  const [configs, setConfigs] = useState<ServiceTypeConfig[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const next = await rideAssistService.getAssistContext(id);
      setCtx(next);
      setFetchedAt(Date.now());
      setState('ready');
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      // A failed poll keeps the page as it was; only the first load decides what to show.
      setState((s) => (s === 'ready' ? s : code === RIDE_ASSIST_UNAVAILABLE ? 'unavailable' : 'error'));
    }
  }, [id]);

  useEffect(() => {
    void load();
    const poll = setInterval(load, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  useEffect(() => {
    adminService
      .getServiceTypeConfigs()
      .then(setConfigs)
      .catch(() => setConfigs([]));
  }, []);

  const typeName = useCallback((slug: string) => configs.find((c) => c.slug === slug)?.name_es ?? slug, [configs]);
  const typeOptions = useMemo(
    () => configs.filter((c) => c.is_active).map((c) => ({ slug: c.slug, name: c.name_es })),
    [configs],
  );

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-ink-subtle">{t('common.loading')}</p>
      </div>
    );
  }
  if (state !== 'ready' || !ctx) {
    return (
      <div className="max-w-3xl">
        <p className={`${CARD} text-sm text-ink-muted`}>
          {state === 'unavailable' ? t('ride_assist.unavailable') : t('ride_assist.load_error')}
        </p>
      </div>
    );
  }

  const { ride, offers, proposal } = ctx;
  const searching = ride.status === 'searching';
  const waitS = ride.wait_s + Math.max(0, Math.floor((now - fetchedAt) / 1000));
  const riderWa = waMeLink(ride.customer_phone, t('ride_assist.rider_whatsapp_text', { code: ride.code }));
  const riderTel = telLink(ride.customer_phone);

  let proposalLine: string | null = null;
  if (proposal) {
    const vars = { type: typeName(proposal.to_service_type), price: formatCUP(proposal.to_fare_cup) };
    const left = Math.floor((new Date(proposal.expires_at).getTime() - now) / 1000);
    if (proposal.status === 'pending') {
      proposalLine =
        left > 0
          ? t('ride_assist.proposal_pending', { ...vars, time: waitLabel(left) })
          : t('ride_assist.proposal_expired', vars);
    } else {
      proposalLine = t(`ride_assist.proposal_${proposal.status}`, vars);
    }
  }

  return (
    <div className="max-w-5xl">
      <AdminBreadcrumb
        items={[
          { label: t('sidebar.rides'), href: '/rides' },
          { label: `#${ride.code}`, href: `/rides/${ride.id}` },
          { label: t('ride_assist.assist_breadcrumb') },
        ]}
      />

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{t('ride_assist.assist_title', { code: ride.code })}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            {searching && <span>{t('ride_assist.waiting_for', { time: waitLabel(waitS) })}</span>}
            {ctx.help_requested_at && (
              <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-700 dark:text-red-400">
                {t('ride_assist.chip_help')}
              </span>
            )}
            {ride.customer_is_test && (
              <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-ink-muted">
                {t('ride_assist.chip_test')}
              </span>
            )}
          </div>
        </div>
        <p className="text-3xl font-bold text-primary-600 dark:text-primary-400">{formatCUP(ride.estimated_fare_cup)}</p>
      </div>

      {!searching && (
        <div className="mb-6 rounded-xl bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-400">
          {t('ride_assist.not_searching', { status: ride.status })}{' '}
          <Link href={`/rides/${ride.id}`} className="font-semibold underline">
            {t('ride_assist.see_ride')}
          </Link>
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
                <dd className="font-medium text-ink">{typeName(ride.service_type)}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('ride_assist.passengers')}</dt>
                <dd className="font-medium text-ink">{ride.passenger_count}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('ride_assist.payment')}</dt>
                <dd className="font-medium text-ink">
                  {t(`rides.payment_${ride.payment_method}`, { defaultValue: ride.payment_method })}
                </dd>
              </div>
            </div>
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
        </section>
      </div>

      <section className={`${CARD} mb-6`}>
        <h2 className="mb-4 text-lg font-bold">{t('ride_assist.offers_card')}</h2>
        {offers.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('ride_assist.offers_empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {offers.map((o) => {
              const left = Math.floor((new Date(o.expires_at).getTime() - now) / 1000);
              const live = o.status === 'pending' && left > 0;
              const shown: RideOfferStatus = o.status === 'pending' && !live ? 'expired' : o.status;
              return (
                <li key={o.driver_profile_id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="font-medium text-ink">{o.driver_name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${OFFER_CHIP[shown]}`}>
                    {t(`ride_assist.offer_status_${shown}`)}
                  </span>
                  {live && <span className="text-ink-muted">{t('ride_assist.expires_in', { time: waitLabel(left) })}</span>}
                  <span className="ml-auto text-xs text-ink-subtle">{formatAdminDate(o.offered_at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {searching && (
        <>
          <AssistCandidates
            rideId={ride.id}
            rideServiceType={ride.service_type}
            pickupAddress={ride.pickup_address}
            typeOptions={typeOptions}
            onChanged={load}
          />
          <AssistServiceChange ride={ride} configs={configs} proposalLine={proposalLine} onChanged={load} />
        </>
      )}
    </div>
  );
}
