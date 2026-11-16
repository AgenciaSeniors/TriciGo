'use client';

/**
 * ActiveRideBanner: "Tienes un viaje en curso · Ver viaje en curso", under the
 * header on every page of the site.
 *
 * Only /track/[id] used to look for the rider's active ride. A rider who closed
 * that tab during a trip and came back to tricigo.com (or opened /book) saw no
 * ride, no driver and no vehicle, and had no way back unless they kept the
 * link. The lookup and its retries live in @tricigo/utils/activeRidePoller.
 *
 * A notice, not a redirect: it never blocks anything (a rider can still read
 * the site or schedule a later ride while one is in progress) and it shows on
 * every page, not just the home page and /book.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { rideService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { Ride } from '@tricigo/types';
import { startActiveRidePoller, type PollerWakeSignals } from '@tricigo/utils/activeRidePoller';
import { useAuth } from '@/app/providers';

/** Sign-in and onboarding: the rider is not in the site yet, the notice would be noise. */
const HIDDEN_ON = ['/login', '/auth', '/complete-profile', '/verify-phone'];

/** The tab's visibility and the network, as the poller needs them. */
const browserSignals: PollerWakeSignals = {
  isVisible: () => document.visibilityState !== 'hidden',
  subscribe(wake) {
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') wake();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', wake);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', wake);
    };
  },
};

function statusKey(ride: Ride): string {
  const delivery = ride.ride_mode === 'cargo';
  switch (ride.status) {
    case 'searching':
      return 'active_ride_banner.status_searching';
    case 'arrived_at_pickup':
      return delivery ? 'active_ride_banner.status_arrived_delivery' : 'active_ride_banner.status_arrived';
    case 'in_progress':
      return delivery ? 'active_ride_banner.status_in_progress_delivery' : 'active_ride_banner.status_in_progress';
    case 'arrived_at_destination':
      return delivery ? 'active_ride_banner.status_arriving_delivery' : 'active_ride_banner.status_arriving';
    default:
      // accepted, driver_en_route
      return 'active_ride_banner.status_on_the_way';
  }
}

export function ActiveRideBanner() {
  const { t } = useTranslation('web');
  const { user } = useAuth();
  const pathname = usePathname() ?? '';
  const userId = user?.id ?? null;
  const [ride, setRide] = useState<Ride | null>(null);

  useEffect(() => {
    if (!userId) {
      setRide(null);
      return;
    }
    // Restarted on every page change, so leaving /track/<id> after the ride
    // ended, or after booking one, does not show a stale notice for 20 s.
    return startActiveRidePoller<Ride>({
      fetchActiveRide: () => rideService.getActiveRide(userId),
      onChange: setRide,
      signals: browserSignals,
    });
  }, [userId, pathname]);

  // The ride of another account (a sign-in switch whose first lookup failed) is not shown.
  if (!userId || !ride || ride.customer_id !== userId) return null;
  // Already looking at this ride (/track/<id>, /chat/<id>…), or not signed in yet.
  if (pathname.split('/').includes(ride.id)) return null;
  if (HIDDEN_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  const delivery = ride.ride_mode === 'cargo';
  const status = t(statusKey(ride));
  const destination = ride.dropoff_address
    ? t('active_ride_banner.to', { address: ride.dropoff_address })
    : '';
  const detail = destination ? `${status} · ${destination}` : status;

  return (
    <div className="active-ride-banner" role="status" aria-live="polite">
      <div className="container active-ride-banner__inner">
        <span className="active-ride-banner__icon" aria-hidden="true">
          {ride.status === 'searching' && <span className="active-ride-banner__pulse" />}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
            <circle cx="12" cy="10" r="3" />
          </svg>
        </span>
        <div className="active-ride-banner__text">
          <p className="active-ride-banner__title">
            {t(delivery ? 'active_ride_banner.title_delivery' : 'active_ride_banner.title')}
          </p>
          <p className="active-ride-banner__detail" title={detail}>{detail}</p>
        </div>
        <Link
          href={`/track/${ride.id}`}
          prefetch={false}
          className="btn-base btn-primary-solid active-ride-banner__cta"
        >
          {t(delivery ? 'active_ride_banner.cta_delivery' : 'active_ride_banner.cta')}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
