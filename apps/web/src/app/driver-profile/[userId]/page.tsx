'use client';

/**
 * Driver public profile page (web parity with mobile
 * `apps/client/app/driver-profile/[userId].tsx`).
 *
 * Shows the same data the mobile screen surfaces — avatar, name,
 * rating + review count, total trips, vehicle (when available), and
 * recent reviews — but skips the contact buttons (call/chat/report)
 * because those require a live ride context that's not available when
 * the user opens this URL directly. The link from `/track/[id]` driver
 * card is the only entrypoint that has live-ride context, and the
 * dispute / chat / call buttons are already on that screen anyway.
 */
import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { authService, driverService, reviewService, getSupabaseClient } from '@tricigo/api';
import type { User, DriverProfile, ReviewSummary, ReviewWithReviewer } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';

function getRelativeDate(iso: string, t: (k: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return t('common.today', { defaultValue: 'Hoy' });
  if (days === 1) return t('common.yesterday', { defaultValue: 'Ayer' });
  if (days < 7) return t('common.days_ago', { count: days, defaultValue: `Hace ${days} días` });
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return t('common.weeks_ago', { count: weeks, defaultValue: `Hace ${weeks} sem` });
  const months = Math.floor(days / 30);
  return t('common.months_ago', { count: months, defaultValue: `Hace ${months} mes` });
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

export default function DriverProfilePage() {
  const router = useRouter();
  const { t } = useTranslation('web');
  const params = useParams();
  const driverUserId = params?.userId as string | undefined;

  const [authLoading, setAuthLoading] = useState(true);
  const [authed, setAuthed] = useState(false);

  const [user, setUser] = useState<User | null>(null);
  const [driverProfile, setDriverProfile] = useState<DriverProfile | null>(null);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [reviews, setReviews] = useState<ReviewWithReviewer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        router.replace('/login');
        return;
      }
      setAuthed(true);
      setAuthLoading(false);
    });
  }, [router]);

  useEffect(() => {
    if (!authed || !driverUserId) return;
    let cancelled = false;
    (async () => {
      try {
        // Fetch every public-profile data source in parallel so the
        // page renders the full picture in one network round-trip.
        // Each call falls back to null on failure so a missing piece
        // (e.g. driver_profile rows missing for legacy users) doesn't
        // hide the rest of the screen.
        const [userResult, driverResult, publicProfileResult] = await Promise.allSettled([
          (async (): Promise<User | null> => {
            // users RLS (users_select_own) blocks reading ANOTHER user's row,
            // so getUserById always failed for a passenger viewing a driver
            // and the whole page showed the error state. The SECURITY DEFINER
            // lookup (mig 00403) returns the public display fields; getUserById
            // stays as fallback (self/admin, or 00403 not yet applied).
            try {
              const { data, error: rpcError } = await getSupabaseClient()
                .rpc('get_public_display_names', { p_user_ids: [driverUserId] });
              const row = !rpcError && Array.isArray(data)
                ? (data as { user_id: string; full_name: string | null; avatar_url: string | null }[])[0]
                : null;
              if (row) {
                return { id: row.user_id, full_name: row.full_name ?? '', avatar_url: row.avatar_url ?? undefined } as User;
              }
            } catch { /* fall through */ }
            return authService.getUserById(driverUserId);
          })(),
          driverService.getProfile(driverUserId),
          reviewService.getDriverPublicProfile(driverUserId),
        ]);
        if (cancelled) return;
        if (userResult.status === 'fulfilled') setUser(userResult.value);
        if (driverResult.status === 'fulfilled') setDriverProfile(driverResult.value);
        if (publicProfileResult.status === 'fulfilled') {
          setSummary(publicProfileResult.value.summary);
          setReviews(publicProfileResult.value.recentReviews);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authed, driverUserId]);

  if (authLoading || loading) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '1.5rem 1rem' }}>
        <WebSkeletonList count={4} />
      </main>
    );
  }

  // Only hard-fail when NOTHING loaded — a missing users header (RLS,
  // migration lag) must not hide the driver stats/reviews that did load.
  if (error || (!user && !driverProfile && !summary)) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '1.5rem 1rem' }}>
        <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-secondary)' }}>
          {t('driver_profile.error', { defaultValue: 'No se pudo cargar el perfil del conductor.' })}
        </div>
        <button
          type="button"
          onClick={() => router.back()}
          style={{
            marginTop: '0.75rem',
            display: 'block',
            marginInline: 'auto',
            padding: '0.5rem 1rem',
            border: '1px solid var(--border)',
            background: 'transparent',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
          }}
        >
          {t('common.back', { defaultValue: 'Volver' })}
        </button>
      </main>
    );
  }

  const driverName = user?.full_name?.trim() || user?.phone || t('driver_profile.fallback_name', { defaultValue: 'Conductor' });
  const avatarUrl = user?.avatar_url;
  const initials = getInitials(driverName);
  const rating = summary?.average_rating ?? driverProfile?.rating_avg ?? 0;
  const totalRides = driverProfile?.total_rides_completed ?? driverProfile?.total_rides ?? 0;

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '1rem' }}>
      {/* Header with back */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <button
          type="button"
          onClick={() => router.back()}
          aria-label={t('common.back', { defaultValue: 'Volver' })}
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            border: 0,
            background: 'transparent',
            cursor: 'pointer',
            fontSize: '1.25rem',
            color: 'var(--text-primary)',
          }}
        >
          ←
        </button>
        <h1 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
          {t('driver_profile.title', { defaultValue: 'Perfil del conductor' })}
        </h1>
      </div>

      {/* Avatar + name + rating */}
      <section style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '1.25rem 0' }}>
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={driverName}
            style={{ width: 120, height: 120, borderRadius: '50%', objectFit: 'cover' }}
          />
        ) : (
          <div
            style={{
              width: 120,
              height: 120,
              borderRadius: '50%',
              background: 'rgba(255,77,0,0.12)',
              color: 'var(--primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '2.5rem',
              fontWeight: 700,
            }}
          >
            {initials}
          </div>
        )}
        <div style={{ marginTop: '0.75rem', fontSize: '1.375rem', fontWeight: 700 }}>{driverName}</div>
        <div style={{ marginTop: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <span style={{ color: '#F59E0B' }}>★</span>
          <span style={{ fontWeight: 600 }}>{rating.toFixed(1)}</span>
          {summary && summary.total_reviews > 0 && (
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', marginLeft: 4 }}>
              · {t('driver_profile.review_count', {
                count: summary.total_reviews,
                defaultValue: `${summary.total_reviews} reseñas`,
              })}
            </span>
          )}
        </div>
      </section>

      {/* Stats row */}
      <section
        style={{
          display: 'flex',
          margin: '0 0 1.25rem',
          padding: '1rem',
          background: 'var(--bg-light)',
          borderRadius: 'var(--radius-md)',
          gap: '1rem',
        }}
      >
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>{totalRides}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {t('driver_profile.trips', { count: totalRides, defaultValue: 'viajes' })}
          </div>
        </div>
        <div style={{ width: 1, background: 'var(--border)' }} />
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: '1.125rem', fontWeight: 700, color: '#16A34A' }}>✓</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {t('driver_profile.verified', { defaultValue: 'Verificado' })}
          </div>
        </div>
      </section>

      {/* Reviews list */}
      <section style={{ padding: '0 0 2rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 0.75rem' }}>
          {t('driver_profile.reviews', { defaultValue: 'Reseñas recientes' })}
        </h2>

        {reviews.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-secondary)' }}>
            {t('driver_profile.no_reviews', { defaultValue: 'Aún no hay reseñas.' })}
          </div>
        ) : (
          reviews.map((review) => (
            <article
              key={review.id}
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: '0.875rem',
                marginBottom: '0.625rem',
              }}
            >
              <header style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.5rem' }}>
                {review.reviewer_avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={review.reviewer_avatar_url}
                    alt={review.reviewer_first_name ?? '?'}
                    style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }}
                  />
                ) : (
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      background: 'rgba(255,77,0,0.12)',
                      color: 'var(--primary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                    }}
                  >
                    {(review.reviewer_first_name?.[0] ?? '?').toUpperCase()}
                  </div>
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{review.reviewer_first_name ?? '—'}</div>
                  <div style={{ fontSize: '0.75rem', color: '#F59E0B' }}>
                    {'★'.repeat(review.rating)}
                    <span style={{ color: 'var(--border)' }}>{'★'.repeat(5 - review.rating)}</span>
                  </div>
                </div>
                <time style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {getRelativeDate(review.created_at, t)}
                </time>
              </header>
              {review.comment && (
                <p style={{ margin: 0, fontSize: '0.875rem', lineHeight: 1.5, color: 'var(--text-primary)' }}>
                  {review.comment}
                </p>
              )}
              {review.review_tags && review.review_tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginTop: '0.5rem' }}>
                  {review.review_tags.map((tag) => {
                    const positive = tag.sentiment === 'positive';
                    return (
                      <span
                        key={tag.key}
                        style={{
                          padding: '0.125rem 0.5rem',
                          borderRadius: '999px',
                          fontSize: '0.75rem',
                          fontWeight: 500,
                          background: positive ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.15)',
                          color: positive ? '#16A34A' : '#DC2626',
                        }}
                      >
                        {tag.label_es || tag.label_en}
                      </span>
                    );
                  })}
                </div>
              )}
            </article>
          ))
        )}
      </section>
    </main>
  );
}
