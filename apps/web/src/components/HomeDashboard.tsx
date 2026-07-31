'use client';

// Authenticated rider "home" content shown below the booking form on /book,
// parity with the mobile NativeHomeScreen (IdleView) which stacks the booking
// entry + dashboard sections on one screen. Ports the three real rider
// features the web was missing: re-book last ride, active promos, and
// admin announcements. Cosmetic mobile-home chrome (weather, online-driver
// count, inline blog) is intentionally deferred.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { rideService, announcementService, promotionService, partnerPlaceService, type ActivePromotion } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { Ride, PartnerPlace, PartnerCoupon } from '@tricigo/types';
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

/** HH:MM in Havana time, or '' when the timestamp is missing or unparseable —
 *  Intl throws RangeError on an Invalid Date, and an uncaught throw in render
 *  would take down the whole dashboard, not just the one coupon card. */
function havanaHhmm(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Havana',
  }).format(d);
}

export function HomeDashboard({ userId, onRebook, onApplyPromo }: {
  userId: string;
  /** Prefill the booking dropoff with the chosen location. Used by the re-book
   *  card and by the partner-place cards — both mean "set my destination to
   *  this and take me back to the form". */
  onRebook: (loc: LocationPreset) => void;
  /** Prefill the booking promo-code field with the tapped promo. */
  onApplyPromo: (code: string) => void;
}) {
  const router = useRouter();
  const { t } = useTranslation('web');
  const [lastRide, setLastRide] = useState<RawHistoryRide | null>(null);
  const [promos, setPromos] = useState<ActivePromotion[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [places, setPlaces] = useState<PartnerPlace[]>([]);
  const [coupons, setCoupons] = useState<PartnerCoupon[]>([]);

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

    // Live arrival coupons. Both partner readers swallow a missing RPC and
    // return [], so this is safe before the migrations are applied to prod.
    partnerPlaceService.getMyCoupons()
      .then((c) => { if (!cancelled) setCoupons(c); });

    // Nearby partner places. Geolocation only — on denial, error or timeout we
    // render nothing, the same rule the mobile carousel follows. Showing a
    // bakery that might be in another province is worse than showing none, and
    // the coupon is issued on arrival regardless of how the ride was booked.
    //
    // /book already holds a geolocation watch, so the permission prompt has
    // been answered by the time this runs; maximumAge lets us reuse that fix
    // instead of waking the GPS again for a list sorted at km granularity.
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          partnerPlaceService.getNearby(pos.coords.latitude, pos.coords.longitude, 8)
            .then((p) => { if (!cancelled) setPlaces(p); });
        },
        () => { if (!cancelled) setPlaces([]); },
        { timeout: 8000, maximumAge: 60000 },
      );
    }

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
  if (!lastRide && promos.length === 0 && announcements.length === 0
      && places.length === 0 && coupons.length === 0) return null;

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

      {/* ── Live coupons ──
          Above promos on purpose: a coupon is already earned and it expires,
          so it outranks marketing the passenger has not acted on yet. */}
      {coupons.length > 0 && (
        <section>
          <p style={sectionLabel}>{t('home.dashboard_coupons', { defaultValue: 'Tus cupones' })}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {coupons.map((c) => {
              const expiry = havanaHhmm(c.expires_at);
              return (
                <div
                  key={c.id}
                  style={{
                    border: '1.5px solid rgba(255,77,0,.32)', borderRadius: '0.85rem',
                    padding: '0.75rem 0.9rem', background: 'var(--bg-card)',
                  }}
                >
                  <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>{c.place_name}</strong>
                  <div style={{ color: 'var(--primary)', fontWeight: 700, fontSize: '0.82rem', marginTop: 2 }}>
                    {c.benefit_title}
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: '1.4rem', letterSpacing: '0.18em', marginTop: '0.5rem', color: 'var(--text-primary)' }}>
                    TG-{c.code}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '0.35rem' }}>
                    {/* Deliberately does NOT print a URL. Validation lives at a
                        per-business secret link (tricigo.com/v/<token>), so the
                        shop uses its own; bare tricigo.com/v is only an
                        explainer with no code field, and sending an employee
                        there would be a dead end. Mirrors the mobile ticket. */}
                    {expiry
                      ? t('home.dashboard_coupon_expiry', { expiry, defaultValue: `Vence a las ${expiry} · el negocio puede validarlo en su enlace de TriciGo` })
                      : t('home.dashboard_coupon_hint', { defaultValue: 'El negocio puede validarlo en su enlace de TriciGo' })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Partner places ──
          Above promos, matching the mobile home where the carousel was moved
          above Promos "where the deal is worth something". */}
      {places.length > 0 && (
        <section>
          <p style={sectionLabel}>{t('home.dashboard_partner_places', { defaultValue: 'Lugares con beneficio' })}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {places.map((p) => (
              <button
                key={p.id}
                type="button"
                // NOT a link to /book?lat=…&lng=…: that page reads no query
                // params at all (verified — no useSearchParams anywhere under
                // app/book), so those would be silently dropped and the card
                // would do nothing. onRebook is the real prefill API this
                // component already receives, and it scrolls back to the form.
                onClick={() => onRebook({
                  label: p.name,
                  address: p.address ?? p.name,
                  latitude: p.latitude,
                  longitude: p.longitude,
                })}
                style={{
                  border: '1px solid var(--border-light)', borderRadius: '0.85rem', overflow: 'hidden',
                  background: 'var(--bg-card)', color: 'inherit', display: 'block',
                  textAlign: 'left', width: '100%', padding: 0, cursor: 'pointer',
                }}
              >
                {p.photo_url && (
                  <img src={p.photo_url} alt="" style={{ width: '100%', height: 130, objectFit: 'cover', display: 'block' }} />
                )}
                <div style={{ padding: '0.75rem 0.9rem' }}>
                  <span style={{
                    display: 'inline-block', background: 'var(--primary)', color: '#fff',
                    borderRadius: 999, padding: '3px 9px', fontSize: '0.62rem', fontWeight: 700,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}>
                    {p.benefit_title}
                  </span>
                  <strong style={{ display: 'block', fontSize: '0.95rem', marginTop: '0.45rem', color: 'var(--text-primary)' }}>
                    {p.name}
                  </strong>
                  <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.4 }}>
                    {p.benefit_description}
                  </span>
                  <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-tertiary)', marginTop: '0.35rem' }}>
                    {/* Havana is walkable: "0.0 km" for a shop 80 m away reads
                        as broken, so sub-kilometre distances stay in metres. */}
                    {p.distance_m < 1000
                      ? `${Math.round(p.distance_m)} m`
                      : `${(p.distance_m / 1000).toFixed(1)} km`}
                  </span>
                </div>
              </button>
            ))}
          </div>
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
