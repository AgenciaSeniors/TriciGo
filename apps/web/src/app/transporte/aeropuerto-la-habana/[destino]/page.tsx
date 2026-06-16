// Per-destination airport transfer page (e.g. /transporte/aeropuerto-la-habana/vedado).
// Targets "taxi del aeropuerto de La Habana al <destino>" — high transactional
// intent. Honest pricing (orientative only). Service + BreadcrumbList + FAQPage JSON-LD.

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/JsonLd';
import { AIRPORT, getAllRouteSlugs, getRouteBySlug } from '@/lib/airport-routes';

const SITE = 'https://tricigo.com';

export function generateStaticParams() {
  return getAllRouteSlugs().map((destino) => ({ destino }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ destino: string }>;
}): Promise<Metadata> {
  const { destino } = await params;
  const r = getRouteBySlug(destino);
  if (!r) return { title: 'Ruta no encontrada', robots: { index: false } };
  const url = `${SITE}${AIRPORT.hubPath}/${r.slug}`;
  const title = `Del aeropuerto de La Habana a ${r.destino} en taxi`;
  return {
    title,
    description: r.metaDescription,
    alternates: { canonical: url },
    openGraph: { title, description: r.metaDescription, url, siteName: 'TriciGo' },
  };
}

export default async function AirportRoutePage({
  params,
}: {
  params: Promise<{ destino: string }>;
}) {
  const { destino } = await params;
  const r = getRouteBySlug(destino);
  if (!r) notFound();

  const url = `${SITE}${AIRPORT.hubPath}/${r.slug}`;

  const serviceJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: 'Traslado de aeropuerto',
    name: `Taxi del ${AIRPORT.name} a ${r.destino}`,
    description: r.intro,
    provider: { '@type': 'Organization', name: 'TriciGo', url: SITE },
    areaServed: { '@type': 'AdministrativeArea', name: 'La Habana, Cuba' },
    offers: { '@type': 'Offer', availability: 'https://schema.org/InStock', priceCurrency: 'CUP' },
  };

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'Transporte en Cuba', item: `${SITE}/transporte` },
      { '@type': 'ListItem', position: 3, name: 'Aeropuerto de La Habana', item: `${SITE}${AIRPORT.hubPath}` },
      { '@type': 'ListItem', position: 4, name: r.destino, item: url },
    ],
  };

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: r.faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <JsonLd data={serviceJsonLd} />
      <JsonLd data={breadcrumbJsonLd} />
      <JsonLd data={faqJsonLd} />

      <nav aria-label="Migas" style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '1.25rem' }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Inicio</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <Link href="/transporte" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Transporte</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <Link href={AIRPORT.hubPath} style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Aeropuerto de La Habana</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <span style={{ color: 'var(--text-secondary)' }}>{r.destino}</span>
      </nav>

      <h1 style={{ fontSize: '2rem', fontWeight: 800, lineHeight: 1.2, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
        Del aeropuerto de La Habana a {r.destino}
      </h1>
      <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem', marginBottom: '1.25rem' }}>{r.distancia}</p>

      <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1.75rem' }}>
        {r.intro}
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
        Pedir mi viaje
      </Link>

      {r.bodyParagraphs.map((para, i) => (
        <p
          key={i}
          style={{ color: 'var(--text-secondary)', lineHeight: 1.75, fontSize: '0.98rem', marginBottom: '1.1rem' }}
          dangerouslySetInnerHTML={{ __html: para }}
        />
      ))}

      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.25rem 0 1rem', color: 'var(--text-primary)' }}>
        Preguntas frecuentes
      </h2>
      {r.faqs.map((f, i) => (
        <div key={i} style={{ marginBottom: '1.1rem' }}>
          <h3 style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.3rem' }}>{f.q}</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.92rem' }}>{f.a}</p>
        </div>
      ))}

      <div style={{ marginTop: '2.5rem', padding: '2rem', background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
          Reserva tu traslado a {r.destino}
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', fontSize: '0.95rem' }}>
          Mira el precio en CUP antes de confirmar y paga sin tarjeta extranjera.
        </p>
        <Link
          href="/book"
          style={{ display: 'inline-block', padding: '0.85rem 1.75rem', background: 'var(--primary)', color: '#fff', borderRadius: '0.75rem', fontSize: '0.95rem', fontWeight: 700, textDecoration: 'none' }}
        >
          Pedir mi viaje
        </Link>
      </div>

      <p style={{ marginTop: '2rem', color: 'var(--text-secondary)', fontSize: '0.92rem', lineHeight: 1.6 }}>
        Más rutas y consejos: <Link href={AIRPORT.hubPath} style={{ color: 'var(--primary)' }}>taxi del aeropuerto de La Habana</Link>,
        <Link href="/transporte/la-habana" style={{ color: 'var(--primary)' }}> transporte en La Habana</Link> y
        <Link href="/blog/transporte-cuba-turistas" style={{ color: 'var(--primary)' }}> transporte en Cuba para turistas</Link>.
      </p>
    </main>
  );
}
