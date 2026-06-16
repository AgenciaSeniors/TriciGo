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
      {/* TODO: Replace id000000000 with real App Store ID once published */}
      <a
        href="https://apps.apple.com/app/tricigo"
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
                  alt="TriciGo - App de transporte. Pedí triciclos, motos y autos."
                  width={390}
                  height={793}
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

      {/* ── TriciGo para empresas (B2B teaser) ── */}
      <section className="section">
        <div className="container">
          <div style={{ textAlign: 'center' }}>
            <span style={{
              display: 'inline-block',
              fontSize: '0.72rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--primary)',
              background: 'var(--primary-alpha-10)',
              padding: '0.3rem 0.8rem',
              borderRadius: 'var(--radius-full)',
              marginBottom: '0.9rem',
            }}>
              Para empresas
            </span>
          </div>
          <h2 className="section-title text-center">Movilidad para tu empresa</h2>
          <p className="section-subtitle text-center" style={{ maxWidth: 580, margin: '0.75rem auto 0' }}>
            Mové a tu personal o a tus clientes por las 16 provincias, con todo facturado y bajo control.
            Una cuenta corporativa sin mensualidad: pagás solo los viajes que tu empresa consume.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginTop: '2.5rem' }}>
            {[
              {
                title: 'Control de presupuesto',
                desc: 'Definí el límite mensual, el tope por viaje y los horarios permitidos para tu equipo.',
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
                    <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
                    <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
                    <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
                  </svg>
                ),
              },
              {
                title: 'Reportes por empleado',
                desc: 'Mirá quién viaja, cuánto y a dónde, con un reporte claro mes a mes.',
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                ),
              },
              {
                title: 'Facturas mensuales en PDF',
                desc: 'Descargá la factura cada mes con el desglose por empleado y por servicio.',
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><line x1="10" y1="9" x2="8" y2="9" />
                  </svg>
                ),
              },
              {
                title: 'Flota exclusiva (opcional)',
                desc: 'Si tu empresa tiene conductores propios, los viajes corporativos van solo a ellos.',
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 17h14M5 17a2 2 0 0 1-2-2v-3l2-5a2 2 0 0 1 1.9-1.4h10.2A2 2 0 0 1 19 5l2 5v3a2 2 0 0 1-2 2" />
                    <circle cx="7.5" cy="17" r="1.5" /><circle cx="16.5" cy="17" r="1.5" />
                  </svg>
                ),
              },
            ].map((f) => (
              <div key={f.title} style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-light)',
                borderRadius: 'var(--radius-lg)',
                padding: '1.5rem',
                textAlign: 'center',
              }}>
                <div style={{
                  width: 48,
                  height: 48,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--primary-alpha-10)',
                  color: 'var(--primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 1rem',
                }}>
                  {f.icon}
                </div>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.4rem', color: 'var(--text-primary)' }}>{f.title}</h3>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>{f.desc}</p>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '2.5rem' }}>
            <Link href="/empresas" className="btn-base btn-primary-solid" style={{ padding: '0.8rem 1.75rem', fontSize: 'var(--text-md)' }}>
              Conocer TriciGo Empresas
            </Link>
            <Link href="/empresas/registro" className="btn-base btn-secondary-outline" style={{ padding: '0.8rem 1.75rem', fontSize: 'var(--text-md)' }}>
              Solicitar cuenta
            </Link>
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
