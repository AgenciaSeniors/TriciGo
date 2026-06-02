'use client';

// Authenticated rider "home" content shown below the booking form on /book,
// parity with the mobile NativeHomeScreen (IdleView) which stacks the booking
// entry + dashboard sections on one screen. Ports the three real rider
// features the web was missing: re-book last ride, active promos, and
// admin announcements. Cosmetic mobile-home chrome (weather, online-driver
// count, inline blog) is intentionally deferred.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { rideService, announcementService, getSupabaseClient } from '@tricigo/api';
import type { Ride } from '@tricigo/types';
import type { LocationPreset } from '@tricigo/utils';

interface Promo {
  id: string;
  code: string;
  discount_percent: number | null;
  discount_fixed_cup: number | null;
  valid_until: string | null;
}

type Announcement = Awaited<ReturnType<typeof announcementService.getActive>>[number];

const sectionLabel: React.CSSProperties = {
  fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)',
  textTransform: 'uppercase', letterSpacing: '0.03em', margin: '0 0 0.6rem',
};

export function HomeDashboard({ userId, onRebook }: {
  userId: string;
  /** Prefill the booking dropoff with the chosen location (re-book flow). */
  onRebook: (loc: LocationPreset) => void;
}) {
  const router = useRouter();
  const [lastRide, setLastRide] = useState<Ride | null>(null);
  const [promos, setPromos] = useState<Promo[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    // Last completed ride → 1-tap re-book (parity con la "last ride card").
    rideService.getRideHistoryFiltered({ userId, page: 0, pageSize: 1, status: ['completed'] })
      .then((rides) => { if (!cancelled && rides[0]) setLastRide(rides[0]); })
      .catch(() => { /* non-critical */ });

    // Active promos — direct query, same shape as the mobile home
    // (no promotionService exists). is_active + not-expired, newest 6.
    const nowIso = new Date().toISOString();
    getSupabaseClient()
      .from('promotions')
      .select('id, code, discount_percent, discount_fixed_cup, valid_until')
      .eq('is_active', true)
      .or(`valid_until.is.null,valid_until.gt.${nowIso}`)
      .order('created_at', { ascending: false })
      .limit(6)
      .then(({ data }) => { if (!cancelled && data) setPromos(data as Promo[]); });

    // Admin announcements (home_announcements, RLS filters inactive/expired).
    announcementService.getActive(null, 6)
      .then((a) => { if (!cancelled) setAnnouncements(a); })
      .catch(() => { /* non-critical */ });

    return () => { cancelled = true; };
  }, [userId]);

  const openCta = (url: string | null) => {
    if (!url) return;
    if (url.startsWith('/')) router.push(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  };

  // Nothing to show → render nothing (no empty chrome).
  if (!lastRide && promos.length === 0 && announcements.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '1.75rem' }}>
      {/* ── Re-book last ride ── */}
      {lastRide && (
        <section>
          <p style={sectionLabel}>Tu último viaje</p>
          <button
            type="button"
            onClick={() => onRebook({
              label: lastRide.dropoff_address,
              address: lastRide.dropoff_address,
              latitude: lastRide.dropoff_location.latitude,
              longitude: lastRide.dropoff_location.longitude,
            })}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%',
              padding: '0.9rem 1rem', borderRadius: '0.85rem', textAlign: 'left',
              background: 'var(--bg-card)', border: '1px solid var(--border-light)', cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: '1.2rem' }}>🔁</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {lastRide.dropoff_address}
              </span>
              <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
                Pedir de nuevo
              </span>
            </span>
            <span style={{ color: 'var(--primary)', fontWeight: 700 }}>→</span>
          </button>
        </section>
      )}

      {/* ── Active promos ── */}
      {promos.length > 0 && (
        <section>
          <p style={sectionLabel}>Promociones</p>
          <div style={{ display: 'flex', gap: '0.6rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
            {promos.map((p) => {
              const headline = p.discount_percent
                ? `${p.discount_percent}% OFF`
                : p.discount_fixed_cup
                  ? `${Math.round(p.discount_fixed_cup / 100)} CUP`
                  : '🎁';
              const expiry = p.valid_until
                ? new Date(p.valid_until).toLocaleDateString('es', { day: 'numeric', month: 'short' })
                : null;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => router.push('/profile/referral')}
                  aria-label={`Promo ${p.code}: ${headline}`}
                  style={{
                    flex: '0 0 auto', width: 200, textAlign: 'left', cursor: 'pointer',
                    padding: '0.85rem', borderRadius: '0.85rem',
                    background: 'var(--bg-card)', border: '1px solid var(--primary)',
                  }}
                >
                  <span style={{ display: 'block', fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '0.04em', marginBottom: 4 }}>
                    🏷️ {p.code}
                  </span>
                  <span style={{ display: 'block', fontSize: '1.25rem', fontWeight: 800, color: 'var(--primary)' }}>
                    {headline}
                  </span>
                  {expiry && (
                    <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-tertiary)', marginTop: 2 }}>
                      Hasta {expiry}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Announcements / campañas ── */}
      {announcements.length > 0 && (
        <section>
          <p style={sectionLabel}>Novedades</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {announcements.map((a) => {
              const tappable = !!a.cta_url;
              return (
                <div
                  key={a.id}
                  onClick={tappable ? () => openCta(a.cta_url) : undefined}
                  role={tappable ? 'button' : undefined}
                  style={{
                    borderRadius: '0.85rem', overflow: 'hidden',
                    background: 'var(--bg-card)', border: '1px solid var(--border-light)',
                    cursor: tappable ? 'pointer' : 'default',
                  }}
                >
                  {a.image_url && (
                    <img src={a.image_url} alt="" style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }} />
                  )}
                  <div style={{ padding: '0.85rem 1rem' }}>
                    <p style={{ margin: 0, fontSize: '0.92rem', fontWeight: 700, color: 'var(--text-primary)' }}>{a.title_es}</p>
                    {a.body_es && (
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>{a.body_es}</p>
                    )}
                    {a.cta_label_es && a.cta_url && (
                      <span style={{ display: 'inline-block', marginTop: '0.6rem', fontSize: '0.8rem', fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                        {a.cta_label_es} →
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
