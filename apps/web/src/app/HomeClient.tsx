'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { HOME_FAQS } from '@/lib/home-faq';

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
              <Link key={svc.key} href={`/${svc.key}`} className="service-card" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
                <Image
                  src={svc.img}
                  alt={svc.title}
                  width={80}
                  height={80}
                  style={{ width: 80, height: 80, objectFit: 'contain', margin: '0 auto 1rem', display: 'block' }}
                />
                <h3>{svc.title}</h3>
                <p>{svc.desc}</p>
              </Link>
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

      {/* ── Todo lo que podés hacer (bento) ── */}
      <section className="section">
        <div className="container">
          <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto' }}>
            <span className="bento-eyebrow">La app</span>
            <h2 className="section-title">Todo lo que podés hacer</h2>
            <p className="section-subtitle">
              TriciGo es más que pedir un viaje: programá, compartí, sumá paradas y viajá a tu manera.
            </p>
          </div>

          <div className="bento">
            {/* Programá — primary, tall */}
            <div className="bento-tile bento-tile--primary bento-2 bento-tall">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </div>
              <h3 style={{ fontSize: '1.35rem' }}>Programá tus viajes</h3>
              <p>Reservá un viaje para más tarde, o dejá programados tus viajes de siempre —al trabajo, a la escuela— para que se repitan solos.</p>
            </div>

            {/* Agregá paradas */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><line x1="12" y1="7" x2="12" y2="13" /><line x1="9" y1="10" x2="15" y2="10" />
                </svg>
              </div>
              <h3>Agregá paradas</h3>
              <p>¿Surgió una parada? Sumala en pleno viaje y el precio se ajusta solo.</p>
            </div>

            {/* Chateá con tu conductor */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <h3>Chateá con tu conductor</h3>
              <p>Coordiná la recogida con mensajes dentro de la app.</p>
            </div>

            {/* Direcciones guardadas — glow */}
            <div className="bento-tile bento-tile--glow">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
                </svg>
              </div>
              <h3>Direcciones guardadas</h3>
              <p>Guardá casa y trabajo y pedí en dos toques. Tu historial, siempre a mano.</p>
            </div>

            {/* Tu viaje a tu medida */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="21" y1="4" x2="14" y2="4" /><line x1="10" y1="4" x2="3" y2="4" /><line x1="21" y1="12" x2="12" y2="12" /><line x1="8" y1="12" x2="3" y2="12" /><line x1="21" y1="20" x2="16" y2="20" /><line x1="12" y1="20" x2="3" y2="20" /><line x1="14" y1="2" x2="14" y2="6" /><line x1="8" y1="10" x2="8" y2="14" /><line x1="16" y1="18" x2="16" y2="22" />
                </svg>
              </div>
              <h3>Tu viaje a tu medida</h3>
              <p>Modo silencio, espacio para equipaje y opciones de accesibilidad (silla de ruedas y más).</p>
            </div>

            {/* Compartí y dividí — full-width row */}
            <div className="bento-tile bento-tile--row bento-4">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
              </div>
              <div>
                <h3>Compartí y dividí</h3>
                <p>En triciclo, compartí los asientos libres y pagás menos. ¿Viajan juntos? Dividí la cuenta con quien va con vos, sin cuentas a mano.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Seguridad (bento) ── */}
      <section className="section section--gray">
        <div className="container">
          <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto' }}>
            <span className="bento-eyebrow">Seguridad</span>
            <h2 className="section-title">Viajá tranquilo, siempre</h2>
            <p className="section-subtitle">
              Tu seguridad va con vos en cada viaje: conductores verificados, seguimiento en vivo
              y un botón de emergencia a un toque.
            </p>
          </div>

          <div className="bento">
            {/* SOS — primary, wide */}
            <div className="bento-tile bento-tile--primary bento-2">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <h3 style={{ fontSize: '1.35rem' }}>Botón SOS</h3>
              <p>Un toque para pedir ayuda y avisar a tus contactos de confianza en una emergencia. Disponible durante todo el viaje.</p>
            </div>

            {/* Conductores verificados */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" />
                </svg>
              </div>
              <h3>Conductores verificados</h3>
              <p>Identidad y documentos revisados antes de manejar.</p>
            </div>

            {/* Seguimiento en vivo — glow */}
            <div className="bento-tile bento-tile--glow">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
                </svg>
              </div>
              <h3>Seguimiento en vivo</h3>
              <p>Mirá tu viaje en el mapa en tiempo real, de la recogida al destino.</p>
            </div>

            {/* Compartí tu viaje — full-width row */}
            <div className="bento-tile bento-tile--row bento-4">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div>
                <h3>Compartí tu viaje</h3>
                <p>Compartí tu ubicación en vivo con tu familia y sumá contactos de confianza que pueden seguir tu recorrido hasta que llegás.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── TriciCoin (bento) ── */}
      <section className="section">
        <div className="container">
          <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto' }}>
            <span className="bento-eyebrow">TriciCoin</span>
            <h2 className="section-title">Pagá sin efectivo</h2>
            <p className="section-subtitle">
              TriciCoin es el saldo de la app. Cargás, pagás tus viajes en segundos y hasta le
              regalás saldo a quien quieras.
            </p>
          </div>

          <div className="bento">
            {/* 1:1 stat — primary, tall */}
            <div className="bento-tile bento-tile--primary bento-2 bento-tall">
              <Image
                src="/images/coins/tricoin-small.png"
                alt="Moneda TriciCoin"
                width={64}
                height={64}
                style={{ width: 64, height: 64, objectFit: 'contain', marginBottom: '1.25rem' }}
              />
              <div className="bento-stat">1 TriciCoin<br />= 1 CUP</div>
              <p style={{ marginTop: '0.75rem' }}>
                Sin conversiones raras: un TriciCoin vale exactamente un peso cubano. Lo que cargás es lo que vale.
              </p>
            </div>

            {/* Cargá */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4z" />
                </svg>
              </div>
              <h3>Cargá tu billetera</h3>
              <p>Sumá saldo y tenés tus créditos listos para viajar.</p>
            </div>

            {/* Pagá */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </div>
              <h3>Pagá en segundos</h3>
              <p>Sin buscar cambio: el viaje se descuenta solo del saldo.</p>
            </div>

            {/* Regalá — wide */}
            <div className="bento-tile bento-tile--row bento-2">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 12 20 22 4 22 4 12" /><rect x="2" y="7" width="20" height="5" /><line x1="12" y1="22" x2="12" y2="7" /><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" /><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
                </svg>
              </div>
              <div>
                <h3>Regalá saldo</h3>
                <p>Mandale TriciCoin a un familiar o a un amigo para sus próximos viajes, al instante.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Invitá y ganá (referidos) ── */}
      <section className="section section--gray">
        <div className="container">
          <div className="bento">
            <div className="bento-tile bento-tile--primary bento-tile--row bento-4" style={{ alignItems: 'center' }}>
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" />
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <h3 style={{ fontSize: '1.4rem' }}>Invitá y ganá</h3>
                <p>
                  Compartí tu código de invitación. Cuando tu amigo se registra y hace su primer viaje,
                  los dos ganan saldo TriciCoin para moverse. Tu código está en la app, en la sección de referidos.
                </p>
                <div style={{ marginTop: '1.1rem' }}>
                  <div className="hero__store-buttons">
                    <StoreButtons variant="white" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── TriciGo para empresas (bento) ── */}
      <section className="section">
        <div className="container">
          <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto' }}>
            <span className="bento-eyebrow">Para empresas</span>
            <h2 className="section-title">Movilidad para tu empresa</h2>
            <p className="section-subtitle">
              Mové a tu personal o a tus clientes por las 16 provincias, con todo facturado y bajo control.
            </p>
          </div>

          <div className="bento">
            {/* CTA — dark, tall */}
            <div className="bento-tile bento-tile--dark bento-2 bento-tall">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 21h18" /><path d="M5 21V7l8-4v18" /><path d="M19 21V11l-6-4" /><line x1="9" y1="9" x2="9" y2="9.01" /><line x1="9" y1="12" x2="9" y2="12.01" /><line x1="9" y1="15" x2="9" y2="15.01" />
                </svg>
              </div>
              <h3 style={{ fontSize: '1.4rem' }}>Cuenta corporativa, sin mensualidad</h3>
              <p>Pagás solo los viajes que tu empresa consume. Una factura mensual, todo el equipo en una sola cuenta.</p>
              <div className="bento-spacer" />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', marginTop: '1.25rem' }}>
                <Link href="/empresas" className="bento-btn bento-btn--white">Conocer TriciGo Empresas</Link>
                <Link href="/empresas/registro" className="bento-btn bento-btn--ghost">Solicitar cuenta</Link>
              </div>
            </div>

            {/* Presupuesto */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
                </svg>
              </div>
              <h3>Control de presupuesto</h3>
              <p>Límite mensual, tope por viaje y horarios permitidos.</p>
            </div>

            {/* Reportes */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
                </svg>
              </div>
              <h3>Reportes por empleado</h3>
              <p>Quién viaja, cuánto y a dónde, mes a mes.</p>
            </div>

            {/* Facturas */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><line x1="10" y1="9" x2="8" y2="9" />
                </svg>
              </div>
              <h3>Facturas en PDF</h3>
              <p>Descargá cada mes el desglose por empleado y servicio.</p>
            </div>

            {/* Flota */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 17h14M5 17a2 2 0 0 1-2-2v-3l2-5a2 2 0 0 1 1.9-1.4h10.2A2 2 0 0 1 19 5l2 5v3a2 2 0 0 1-2 2" /><circle cx="7.5" cy="17" r="1.5" /><circle cx="16.5" cy="17" r="1.5" />
                </svg>
              </div>
              <h3>Flota exclusiva (opcional)</h3>
              <p>Si tenés conductores propios, los viajes van solo a ellos.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Para conductores (bento) ── */}
      <section className="section section--gray">
        <div className="container">
          <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto' }}>
            <span className="bento-eyebrow">Para conductores</span>
            <h2 className="section-title">¿Tenés moto, triciclo o auto?</h2>
            <p className="section-subtitle">
              Convertí tu vehículo en una fuente de ingreso. Manejás cuando querés, cobrás en pesos
              y aceptás solo los viajes que te convienen.
            </p>
          </div>

          <div className="bento">
            {/* CTA — primary, tall */}
            <div className="bento-tile bento-tile--primary bento-2 bento-tall">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </div>
              <h3 style={{ fontSize: '1.4rem' }}>Generá ingresos con tu vehículo</h3>
              <p>Precio claro y sin regateo en la calle. Vos elegís cuándo manejás y cuánto.</p>
              <div className="bento-spacer" />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', marginTop: '1.25rem' }}>
                <a href="https://play.google.com/store/apps/details?id=app.tricigo.driver" target="_blank" rel="noopener noreferrer" className="bento-btn bento-btn--white">
                  Descargá TriciGo Conductor
                </a>
                <Link href="/blog/motorina-cuba-conductor-mensajero" className="bento-btn bento-btn--ghost">Cómo funciona</Link>
              </div>
            </div>

            {/* Showcase — motorina */}
            <div className="bento-tile bento-tile--showcase bento-2">
              <Image
                src="/images/vehicles/moto.png"
                alt="Motorina para conductores TriciGo"
                width={120}
                height={120}
                style={{ width: 120, height: 120, objectFit: 'contain', marginBottom: '0.75rem' }}
              />
              <h3>Tu moto, tu negocio</h3>
              <p>Miles de motorinas en Cuba ya generan ingresos a su ritmo.</p>
            </div>

            {/* Benefit — horarios */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <h3>A tu ritmo</h3>
              <p>Manejás cuando querés, sin horarios fijos.</p>
            </div>

            {/* Benefit — cobrás en pesos */}
            <div className="bento-tile">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </div>
              <h3>Cobrás en pesos</h3>
              <p>En efectivo o TriciCoin, según prefieras.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Guías (bento) ── */}
      <section className="section">
        <div className="container">
          <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto' }}>
            <span className="bento-eyebrow">Guías</span>
            <h2 className="section-title">Aprendé a moverte por Cuba</h2>
            <p className="section-subtitle">
              Consejos prácticos para moverte mejor y pagar lo justo, en lenguaje cubano de a pie.
            </p>
          </div>

          <div className="bento">
            {/* Featured — cómo moverse (tall) */}
            <Link href="/blog/como-moverse-en-la-habana" className="bento-tile bento-tile--glow bento-2 bento-tall">
              <span className="bento-eyebrow" style={{ background: 'var(--primary-alpha-10)' }}>Guía destacada</span>
              <h3 style={{ fontSize: '1.4rem' }}>Cómo moverse en La Habana</h3>
              <p>Todas las formas de moverte por la capital —guagua, almendrón, bicitaxi, motorina— y cuál te conviene en cada caso.</p>
              <span className="bento-link">Leer la guía &rarr;</span>
            </Link>

            {/* Glosario */}
            <Link href="/blog/glosario-transporte-cubano" className="bento-tile">
              <h3>Glosario del transporte cubano</h3>
              <p>Bicitaxi, almendrón, botero, motorina… qué es cada uno.</p>
              <span className="bento-link">Leer &rarr;</span>
            </Link>

            {/* Tarifas */}
            <Link href="/blog/tarifas-transporte-cuba-2026" className="bento-tile">
              <h3>Tarifas de transporte 2026</h3>
              <p>Cuánto cuesta moverse hoy, modo por modo, en CUP.</p>
              <span className="bento-link">Leer &rarr;</span>
            </Link>

            {/* No te claven — wide */}
            <Link href="/blog/no-te-estafen-precio-taxi-cuba" className="bento-tile bento-tile--row bento-2">
              <div className="bento-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <div>
                <h3>Para que no te estafen</h3>
                <p>Cómo saber el precio justo y defenderte del sobrecobro.</p>
                <span className="bento-link" style={{ paddingTop: '0.4rem' }}>Leer &rarr;</span>
              </div>
            </Link>
          </div>

          <div style={{ textAlign: 'center', marginTop: '2rem' }}>
            <Link href="/blog" style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--primary)', textDecoration: 'none' }}>
              Ver todo el blog &rarr;
            </Link>
          </div>
        </div>
      </section>

      {/* ── Preguntas frecuentes ── */}
      <section className="section section--gray">
        <div className="container">
          <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto' }}>
            <span className="bento-eyebrow">Dudas</span>
            <h2 className="section-title">Preguntas frecuentes</h2>
            <p className="section-subtitle">
              Lo que más nos preguntan sobre cómo viajar con TriciGo.
            </p>
          </div>

          <div className="faq-list">
            {HOME_FAQS.map((f, i) => (
              <details key={i} className="faq-item">
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
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
