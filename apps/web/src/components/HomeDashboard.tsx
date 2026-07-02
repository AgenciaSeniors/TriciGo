'use client';

// Authenticated rider "home" content shown below the booking form on /book,
// parity with the mobile NativeHomeScreen (IdleView) which stacks the booking
// entry + dashboard sections on one screen. Ports the three real rider
// features the web was missing: re-book last ride, active promos, and
// admin announcements. Cosmetic mobile-home chrome (weather, online-driver
// count, inline blog) is intentionally deferred.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { rideService, announcementService, promotionService, type ActivePromotion } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { Ride } from '@tricigo/types';
import { announcementCtaWebHref } from '@tricigo/utils';
import type { LocationPreset } from '@tricigo/utils';

/** getRideHistoryFiltered returns the raw rides row: the geography columns
 *  (dropoff_location) arrive as opaque WKB hex STRINGS, not {lat,lng} —
 *  the usable coords live in the trigger-synced dropoff_lat/dropoff_lng
 *  numeric columns (same source getRideWithDriver normalizes from). */
type RawHistoryRide = Ride & { dropoff_lat?: number | null; dropoff_lng?: number | null };

type Announcement = Awaited<ReturnType<typeof announcementService.getActive>>[number];

const sectionLabel: React.CSSProperties = {
  fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)',
  textTransform: 'uppercase', letterSpacing: '0.03em', margin: '0 0 0.6rem',
};

export function HomeDashboard({ userId, onRebook, onApplyPromo }: {
  userId: string;
  /** Prefill the booking dropoff with the chosen location (re-book flow). */
  onRebook: (loc: LocationPreset) => void;
  /** Prefill the booking promo-code field with the tapped promo. */
  onApplyPromo: (code: string) => void;
}) {
  const router = useRouter();
  const { t } = useTranslation('web');
  const [lastRide, setLastRide] = useState<RawHistoryRide | null>(null);
  const [promos, setPromos] = useState<ActivePromotion[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    // Last completed ride → 1-tap re-book (parity con la "last ride card").
    // Only keep it when the numeric dropoff coords exist — without them the
    // re-book button would prefill a destination with undefined coordinates.
    rideService.getRideHistoryFiltered({ userId, page: 0, pageSize: 1, status: ['completed'] })
      .then((rides) => {
        const r = rides[0] as RawHistoryRide | undefined;
        if (!cancelled && r && typeof r.dropoff_lat === 'number' && typeof r.dropoff_lng === 'number') {
          setLastRide(r);
        }
      })
      .catch(() => { /* non-critical */ });

    // Active promos — via the SECURITY DEFINER RPC (mig 00476). The
    // promotions table is admin-only under RLS (00321), so the previous
    // direct .from('promotions') read silently returned 0 rows for every
    // customer and this section never rendered. Tolerant: [] on error.
    promotionService.getActivePromotions(6)
      .then((data) => { if (!cancelled) setPromos(data); });

    // Admin announcements (home_announcements, RLS filters inactive/expired).
    announcementService.getActive(null, 6)
      .then((a) => { if (!cancelled) setAnnouncements(a); })
      .catch(() => { /* non-critical */ });

    return () => { cancelled = true; };
  }, [userId]);

  // cta_url stores MOBILE Expo Router paths (every live campaign in prod uses
  // '/(tabs)'-style values) — pushing them raw 404'd on Next (PASS2 P1).
  // announcementCtaWebHref translates them to real web routes, or null when
  // there's nothing safe to open (the card then renders untappable).
  const openCta = (url: string | null) => {
    const href = announcementCtaWebHref(url);
    if (!href) return;
    if (href.startsWith('/')) router.push(href);
    else window.open(href, '_blank', 'noopener,noreferrer');
  };

  // Nothing to show → render nothing (no empty chrome).
  if (!lastRide && promos.length === 0 && announcements.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '1.75rem' }}>
      {/* ── Re-book last ride ── */}
      {lastRide && (
        <section>
          <p style={sectionLabel}>{t('home.dashboard_last_ride', { defaultValue: 'Tu último viaje' })}</p>
          <button
            type="button"
            onClick={() => onRebook({
              label: lastRide.dropoff_address,
              address: lastRide.dropoff_address,
              // dropoff_location on the raw history row is a WKB hex string —
              // the numeric trigger-synced columns are the real coords.
              latitude: lastRide.dropoff_lat as number,
              longitude: lastRide.dropoff_lng as number,
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
                {t('home.dashboard_rebook', { defaultValue: 'Pedir de nuevo' })}
              </span>
            </span>
            <span style={{ color: 'var(--primary)', fontWeight: 700 }}>→</span>
          </button>
        </section>
      )}

      {/* ── Active promos ── */}
      {promos.length > 0 && (
        <section>
          <p style={sectionLabel}>{t('home.dashboard_promos', { defaultValue: 'Promociones' })}</p>
          <div style={{ display: 'flex', gap: '0.6rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
            {promos.map((p) => {
              // Marketing copy (title_es) wins when the admin filled it.
              // discount_fixed_cup is WHOLE CUP (validate_promo_code applies it
              // raw against CUP fares) — dividing by 100 showed "10 CUP" for the
              // live $1000 promo. Mirror of the PASS#3 mobile fix.
              const headline = p.title_es
                || (p.discount_percent
                  ? `${p.discount_percent}% OFF`
                  : p.discount_fixed_cup
                    ? `${p.discount_fixed_cup} CUP`
                    : '🎁');
              const expiry = p.valid_until
                ? new Date(p.valid_until).toLocaleDateString('es', { day: 'numeric', month: 'short', timeZone: 'America/Havana' })
                : null;
              return (
                <button
                  key={p.id}
                  type="button"
                  // Prefill the booking promo field (this dashboard renders on
                  // /book, right below the form). Was wrongly routing to
                  // /profile/referral — same class of bug the mobile home fixed.
                  onClick={() => onApplyPromo(p.code)}
                  aria-label={t('home.dashboard_promo_aria', { code: p.code, headline, defaultValue: `Promo ${p.code}: ${headline}` })}
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
                      {t('home.dashboard_promo_until', { expiry, defaultValue: `Hasta ${expiry}` })}
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
          <p style={sectionLabel}>{t('home.dashboard_news', { defaultValue: 'Novedades' })}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {announcements.map((a) => {
              const tappable = !!announcementCtaWebHref(a.cta_url);
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
                    {a.cta_label_es && tappable && (
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
