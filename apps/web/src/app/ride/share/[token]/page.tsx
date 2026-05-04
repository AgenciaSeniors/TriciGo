'use client';

/**
 * Web parity entrypoint for `tricigo://ride/share/{token}` /
 * `https://tricigo.com/ride/share/{token}` deep links.
 *
 * Mobile has `apps/client/app/ride/share/[token].tsx` that resolves the
 * share token and redirects to `/ride/[id]` (full active-ride screen).
 * Without this web route, anyone who clicks the share link in a browser
 * (instead of in the mobile app) would land on a 404. This route mirrors
 * the mobile behavior:
 *
 *   - Look up the ride by share_token via `rideService.getRideByShareToken()`.
 *   - If the viewer IS the ride owner (logged-in customer_id matches) →
 *     redirect to `/track/[id]` (the authenticated tracking screen they
 *     already use after creating a ride).
 *   - Otherwise → redirect to the public `/track/share/[token]` view that
 *     already exists in web (anonymous tracking, friends/family use case).
 *
 * If the token is invalid or expired, render an error state mirroring
 * the mobile UX.
 */
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { rideService, getSupabaseClient } from '@tricigo/api';

export default function RideShareTokenRedirect() {
  const router = useRouter();
  const { t } = useTranslation('web');
  const params = useParams();
  const token = params?.token as string | undefined;
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!token) {
      setError(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ride = await rideService.getRideByShareToken(token);
        if (cancelled) return;
        if (!ride) {
          setError(true);
          return;
        }
        // If the current viewer owns this ride, send them to the
        // authenticated tracking screen (matches mobile that always
        // redirects to /ride/[id] because the app user IS the customer).
        // Otherwise we keep them on the public token-gated view so the
        // share works for friends/family without needing a TriciGo
        // account.
        const { data: { session } } = await getSupabaseClient().auth.getSession();
        const viewerIsOwner = session?.user?.id && session.user.id === ride.customer_id;
        if (viewerIsOwner) {
          router.replace(`/track/${ride.id}`);
        } else {
          router.replace(`/track/share/${token}`);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [token, router]);

  if (error) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: '3rem 1rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem' }}>
          {t('deeplink.ride_not_found', { defaultValue: 'Viaje no encontrado' })}
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          {t('deeplink.ride_not_found_desc', { defaultValue: 'El enlace del viaje no es válido o ha expirado.' })}
        </p>
        <Link
          href="/"
          style={{
            display: 'inline-block',
            padding: '0.625rem 1.25rem',
            background: 'var(--primary)',
            color: 'white',
            borderRadius: 'var(--radius-md)',
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          {t('common.go_home', { defaultValue: 'Ir al inicio' })}
        </Link>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '3rem 1rem', textAlign: 'center' }}>
      <div
        aria-hidden="true"
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          border: '3px solid rgba(255,77,0,0.18)',
          borderTopColor: 'var(--primary)',
          margin: '0 auto 1rem',
          animation: 'spin 0.9s linear infinite',
        }}
      />
      <p style={{ color: 'var(--text-secondary)' }}>
        {t('deeplink.loading', { defaultValue: 'Cargando...' })}
      </p>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </main>
  );
}
