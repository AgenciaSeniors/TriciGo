import type { Metadata } from 'next';
import Link from 'next/link';
import HomeClient from './HomeClient';
import { JsonLd } from '../components/JsonLd';
import { getAllProvinces } from '@/lib/coverage';
import { HOME_FAQS } from '@/lib/home-faq';

export const metadata: Metadata = {
  // `absolute` sets the exact <title> (bypasses the root "%s | TriciGo" template).
  title: { absolute: 'TriciGo — App de transporte en Cuba: triciclo, moto y auto' },
  description:
    'Pedí un triciclo, moto o auto con TriciGo, la app de transporte en Cuba. Mirá el precio en CUP antes de viajar, en las 16 provincias. Descarga gratis.',
  alternates: {
    canonical: 'https://tricigo.com',
  },
};

/* ── Structured data for SEO ── */

// Built from the shared HOME_FAQS so the structured data and the visible FAQ
// accordion in HomeClient always stay in sync.
const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: HOME_FAQS.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
};

const serviceJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Service',
  name: 'TriciGo - Servicio de Transporte',
  serviceType: 'Taxi Service',
  provider: {
    '@type': 'Organization',
    name: 'TriciGo',
    url: 'https://tricigo.com',
  },
  areaServed: { '@type': 'Country', name: 'Cuba' },
  description: 'Servicio de transporte bajo demanda en Cuba. Triciclos, motos y autos disponibles 24/7.',
  offers: {
    '@type': 'Offer',
    availability: 'https://schema.org/InStock',
  },
};

/* ── Coverage section: server-rendered, real internal links to the province
   landing pages. Gives the home genuine Cuba/province keyword content in the
   initial HTML and spreads link equity to /transporte/[provincia]. ── */

function CoverageSection() {
  const provinces = getAllProvinces();
  if (provinces.length === 0) return null;
  return (
    <section className="section section--gray">
      <div className="container">
        <h2 className="section-title text-center">TriciGo en toda Cuba</h2>
        <p
          className="section-subtitle text-center"
          style={{ maxWidth: 560, margin: '0.75rem auto 0' }}
        >
          Movilidad bajo demanda en las 16 provincias del país, de Pinar del Río a Guantánamo.
          Elegí tu provincia para ver cómo funciona el servicio de triciclos, motos y autos en tu zona.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: '0.6rem',
            maxWidth: 760,
            margin: '2rem auto 0',
          }}
        >
          {provinces.map((p) => (
            <Link
              key={p.value}
              href={`/transporte/${p.slug}`}
              style={{
                display: 'block',
                padding: '0.7rem 0.9rem',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-light)',
                borderRadius: '0.6rem',
                textDecoration: 'none',
                color: 'var(--text-primary)',
                fontWeight: 600,
                fontSize: '0.9rem',
                textAlign: 'center',
              }}
            >
              {p.name}
            </Link>
          ))}
        </div>

        <div style={{ textAlign: 'center', marginTop: '2rem' }}>
          <Link
            href="/transporte"
            style={{
              display: 'inline-block',
              padding: '0.8rem 1.6rem',
              background: 'var(--primary)',
              color: '#fff',
              borderRadius: '0.75rem',
              fontSize: '0.95rem',
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            Ver la cobertura por provincia
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <main>
      {/* Structured data */}
      <JsonLd data={faqJsonLd} />
      <JsonLd data={serviceJsonLd} />

      {/* Interactive marketing content (server-rendered since the i18n provider
          no longer gates SSR). Its hero <h1> is the single page heading. */}
      <HomeClient />

      {/* National coverage + internal links to the province landing pages */}
      <CoverageSection />
    </main>
  );
}
