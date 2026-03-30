'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';

/* ── SVG Icons for Features ── */

function IconPricing() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

function IconTracking() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="3 11 22 2 13 21 11 13 3 11" />
    </svg>
  );
}

function IconSafety() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}

function IconPayment() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
      <line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  );
}

function GooglePlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.199l2.807 1.626a1 1 0 010 1.732l-2.807 1.626L15.206 12l2.492-2.492zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z" />
    </svg>
  );
}

function AppStoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

/* ── Store Buttons (reusable) ── */

function StoreButtons({ variant = 'dark' }: { variant?: 'dark' | 'white' }) {
  const cls = variant === 'white' ? 'btn-store btn-store--white' : 'btn-store';
  return (
    <>
      <a
        href="https://play.google.com/store/apps/details?id=app.tricigo.client"
        target="_blank"
        rel="noopener noreferrer"
        className={cls}
      >
        <GooglePlayIcon /> Google Play
      </a>
      <a
        href="https://apps.apple.com/app/tricigo/id000000000"
        target="_blank"
        rel="noopener noreferrer"
        className={cls}
      >
        <AppStoreIcon /> App Store
      </a>
    </>
  );
}

/* ── HomeClient: all interactive/translated content ── */

export default function HomeClient() {
  const { t } = useTranslation('web');

  const steps = [
    { num: 1, title: t('home.how_step1_title'), desc: t('home.how_step1_desc') },
    { num: 2, title: t('home.how_step2_title'), desc: t('home.how_step2_desc') },
    { num: 3, title: t('home.how_step3_title'), desc: t('home.how_step3_desc') },
  ];

  const services = [
    { key: 'triciclo', img: '/images/vehicles/triciclo.png', title: t('home.service_triciclo'), desc: t('home.service_triciclo_desc') },
    { key: 'moto', img: '/images/vehicles/moto.png', title: t('home.service_moto'), desc: t('home.service_moto_desc') },
    { key: 'auto', img: '/images/vehicles/auto.png', title: t('home.service_auto'), desc: t('home.service_auto_desc') },
    { key: 'mensajeria', img: '/images/vehicles/mensajeria.png', title: t('home.service_mensajeria'), desc: t('home.service_mensajeria_desc') },
  ];

  const features = [
    { icon: <IconPricing />, title: t('home.feature_pricing_title'), desc: t('home.feature_pricing_desc') },
    { icon: <IconTracking />, title: t('home.feature_tracking_title'), desc: t('home.feature_tracking_desc') },
    { icon: <IconSafety />, title: t('home.feature_safety_title'), desc: t('home.feature_safety_desc') },
    { icon: <IconPayment />, title: t('home.feature_payment_title'), desc: t('home.feature_payment_desc') },
  ];

  return (
    <>
      {/* ── Hero ── */}
      <section className="section">
        <div className="container">
          <div className="hero">
            <div>
              <h1>
                {t('home.hero_title_1')}<br />
                <span style={{ color: 'var(--primary)' }}>{t('home.hero_title_2')}</span>
              </h1>
              <p>{t('home.hero_subtitle')}</p>
              <div className="hero__buttons">
                <Link href="/book" className="btn-primary">
                  {t('home.hero_cta')}
                </Link>
              </div>
              <div className="hero__store-buttons">
                <StoreButtons />
              </div>
            </div>
            <div className="hero__visual">
              <div className="hero__phone-frame">
                <Image
                  src="/images/screenshots/02-home.png"
                  alt="TriciGo - App de taxi en La Habana, Cuba. Pide triciclos, motos y autos."
                  width={390}
                  height={844}
                  priority
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="section section--gray">
        <div className="container">
          <h2 className="section-title text-center">{t('home.how_title')}</h2>
          <p className="section-subtitle text-center" style={{ maxWidth: 500, margin: '0.75rem auto 0' }}>
            {t('home.how_subtitle')}
          </p>
          <div className="steps-grid">
            {steps.map((s) => (
              <div key={s.num} className="step-card">
                <div className="step-number">{s.num}</div>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Services ── */}
      <section className="section">
        <div className="container">
          <h2 className="section-title text-center">{t('home.services_title')}</h2>
          <p className="section-subtitle text-center" style={{ maxWidth: 500, margin: '0.75rem auto 0' }}>
            {t('home.services_subtitle')}
          </p>
          <div className="services-grid">
            {services.map((svc) => (
              <div key={svc.key} className="service-card">
                <Image
                  src={svc.img}
                  alt={svc.title}
                  width={80}
                  height={80}
                  style={{ width: 80, height: 80, objectFit: 'contain', margin: '0 auto 1rem', display: 'block' }}
                />
                <h3>{svc.title}</h3>
                <p>{svc.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="section section--gray">
        <div className="container">
          <h2 className="section-title text-center">{t('home.features_title')}</h2>
          <div className="features-grid">
            {features.map((f, i) => (
              <div key={i} className="feature-card">
                <div className="feature-icon">{f.icon}</div>
                <div>
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Social Proof / Stats ── */}
      <section className="section">
        <div className="container">
          <h2 className="section-title text-center">{t('home.stats_title', { defaultValue: 'La Habana confía en TriciGo' })}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.5rem', marginTop: '2.5rem' }}>
            {[
              { value: '500+', label: t('home.stat_drivers', { defaultValue: 'Conductores registrados' }) },
              { value: '10,000+', label: t('home.stat_rides', { defaultValue: 'Viajes completados' }) },
              { value: '4.8★', label: t('home.stat_rating', { defaultValue: 'Calificación promedio' }) },
              { value: '24/7', label: t('home.stat_available', { defaultValue: 'Disponible siempre' }) },
            ].map((s) => (
              <div key={s.value} style={{
                textAlign: 'center',
                padding: '1.5rem 1rem',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-light)',
                background: 'var(--bg-card)',
              }}>
                <p style={{ fontSize: 'clamp(1.75rem, 3vw, 2.5rem)', fontWeight: 800, color: 'var(--primary)', marginBottom: '0.25rem', lineHeight: 1.2 }}>{s.value}</p>
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{s.label}</p>
              </div>
            ))}
          </div>

          {/* Testimonials */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem', marginTop: '3rem' }}>
            {[
              { text: t('home.testimonial_1', { defaultValue: '"Uso TriciGo todos los días para ir al trabajo. Es rápido y confiable."' }), name: 'María G.', loc: 'Vedado', initial: 'M' },
              { text: t('home.testimonial_2', { defaultValue: '"Como conductor, TriciGo me permite ganar bien y organizar mi tiempo."' }), name: 'Carlos R.', loc: 'Centro Habana', initial: 'C' },
              { text: t('home.testimonial_3', { defaultValue: '"El pago con TriciCoin es genial. No necesito efectivo."' }), name: 'Ana P.', loc: 'Miramar', initial: 'A' },
            ].map((review) => (
              <div key={review.initial} style={{
                background: 'var(--bg-card)',
                borderRadius: 'var(--radius-lg)',
                padding: '1.5rem',
                border: '1px solid var(--border-light)',
                transition: 'transform var(--transition-fast), box-shadow var(--transition-fast)',
                cursor: 'default',
              }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-lg)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="var(--primary-alpha-20)" style={{ marginBottom: '0.75rem' }}>
                  <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10H14.017zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10H0z" />
                </svg>
                <p style={{ fontSize: 'var(--text-md)', lineHeight: 1.6, marginBottom: '1rem', color: 'var(--text-primary)' }}>
                  {review.text}
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%',
                    background: 'var(--gradient-primary)', color: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 'var(--text-sm)', fontWeight: 700,
                  }}>
                    {review.initial}
                  </div>
                  <div>
                    <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{review.name}</p>
                    <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{review.loc}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Download CTA ── */}
      <section className="section section--orange">
        <div className="container">
          <div className="download-cta">
            <div>
              <h2>{t('home.download_cta_title')}</h2>
              <p>{t('home.download_cta_subtitle')}</p>
            </div>
            <div className="download-cta__buttons">
              <StoreButtons variant="white" />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
