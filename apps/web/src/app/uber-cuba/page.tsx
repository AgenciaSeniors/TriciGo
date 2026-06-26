// "¿Hay Uber en Cuba?" landing page. Honest, fact-checked answer (Uber and the
// other global apps do NOT operate in Cuba) that positions TriciGo as the real
// alternative. Targets "uber en cuba", "¿hay uber en cuba?", "app de transporte
// en cuba", "alternativa a La Nave". Server-rendered with FAQPage + BreadcrumbList.

import type { Metadata } from 'next';
import Link from 'next/link';
import { JsonLd } from '@/components/JsonLd';
import { UBER_CUBA } from '@/lib/uber-cuba-content';

const SITE = 'https://tricigo.com';
const URL = `${SITE}/uber-cuba`;

export const metadata: Metadata = {
  title: UBER_CUBA.metaTitle,
  description: UBER_CUBA.metaDescription,
  // Cuba-forward SEO landing — excluded from search/crawlers to keep the public
  // surface region-neutral. Reachable only by direct URL.
  robots: { index: false, follow: false },
  alternates: { canonical: URL },
  openGraph: {
    title: UBER_CUBA.metaTitle,
    description: UBER_CUBA.metaDescription,
    url: URL,
    siteName: 'TriciGo',
  },
};

export default function UberCubaPage() {
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: UBER_CUBA.faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITE },
      { '@type': 'ListItem', position: 2, name: '¿Hay Uber en Cuba?', item: URL },
    ],
  };

  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <JsonLd data={faqJsonLd} />
      <JsonLd data={breadcrumbJsonLd} />

      {/* Breadcrumb */}
      <nav aria-label="Migas" style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '1.25rem' }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Inicio</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <span style={{ color: 'var(--text-secondary)' }}>¿Hay Uber en Cuba?</span>
      </nav>

      {/* Hero */}
      <h1 style={{ fontSize: '2.25rem', fontWeight: 800, lineHeight: 1.2, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>
        {UBER_CUBA.h1}
      </h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1.75rem' }}>
        {UBER_CUBA.intro}
      </p>

      <Link
        href="/book"
        style={{
          display: 'inline-block',
          padding: '0.85rem 1.75rem',
          background: 'var(--primary)',
          color: '#fff',
          borderRadius: '0.75rem',
          fontSize: '0.95rem',
          fontWeight: 700,
          textDecoration: 'none',
          marginBottom: '2.5rem',
        }}
      >
        Pedir un viaje con TriciGo
      </Link>

      {/* Body */}
      {UBER_CUBA.bodyParagraphs.map((para, i) => (
        <p key={i} style={{ color: 'var(--text-secondary)', lineHeight: 1.75, fontSize: '0.98rem', marginBottom: '1.1rem' }}>
          {para}
        </p>
      ))}

      {/* FAQ */}
      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.5rem 0 1rem', color: 'var(--text-primary)' }}>
        Preguntas frecuentes
      </h2>
      {UBER_CUBA.faqs.map((f, i) => (
        <div key={i} style={{ marginBottom: '1.1rem' }}>
          <h3 style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.3rem' }}>{f.q}</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.92rem' }}>{f.a}</p>
        </div>
      ))}

      {/* Internal links */}
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.7, marginTop: '2rem' }}>
        Conocé los servicios de TriciGo —{' '}
        <Link href="/triciclo" style={{ color: 'var(--primary)', fontWeight: 600 }}>triciclo</Link>,{' '}
        <Link href="/moto" style={{ color: 'var(--primary)', fontWeight: 600 }}>moto</Link>,{' '}
        <Link href="/auto" style={{ color: 'var(--primary)', fontWeight: 600 }}>auto</Link> y{' '}
        <Link href="/mensajeria" style={{ color: 'var(--primary)', fontWeight: 600 }}>mensajería</Link>
        {' '}— o mirá la{' '}
        <Link href="/transporte" style={{ color: 'var(--primary)', fontWeight: 600 }}>cobertura por provincia</Link>
        {' '}y la guía de{' '}
        <Link href="/blog/transporte-cuba-turistas" style={{ color: 'var(--primary)', fontWeight: 600 }}>transporte en Cuba para turistas</Link>.
      </p>

      {/* CTA */}
      <div style={{ marginTop: '2.75rem', padding: '2rem', background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
          No hay Uber, pero sí TriciGo
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', fontSize: '0.95rem' }}>
          Descargá la app cubana de transporte y consultá la disponibilidad en tu zona.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="https://play.google.com/store/apps/details?id=app.tricigo.client" target="_blank" rel="noopener noreferrer"
            style={{ padding: '0.75rem 1.4rem', background: 'var(--primary)', color: '#fff', borderRadius: '0.75rem', fontSize: '0.9rem', fontWeight: 700, textDecoration: 'none' }}>
            Google Play
          </a>
          <a href="https://apps.apple.com/app/tricigo" target="_blank" rel="noopener noreferrer"
            style={{ padding: '0.75rem 1.4rem', background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)', borderRadius: '0.75rem', fontSize: '0.9rem', fontWeight: 700, textDecoration: 'none' }}>
            App Store
          </a>
        </div>
      </div>
    </main>
  );
}
