// Coverage hub — lists the provinces and links to each local landing
// page. Internal-linking hub for the /transporte/[provincia] pages; linked from
// the footer and the home "Cobertura" section. Server-rendered + in the sitemap.

import type { Metadata } from 'next';
import Link from 'next/link';
import { JsonLd } from '@/components/JsonLd';
import { getAllProvinces } from '@/lib/coverage';

const SITE = 'https://tricigo.com';

export const metadata: Metadata = {
  title: 'Transporte con TriciGo — Cobertura por provincia',
  description:
    'Pide triciclos, motos y autos con TriciGo en múltiples ciudades. Elige tu zona y conoce el servicio de movilidad bajo demanda disponible.',
  alternates: { canonical: `${SITE}/transporte` },
  openGraph: {
    title: 'Transporte con TriciGo — Cobertura por provincia',
    description:
      'Triciclos, motos y autos bajo demanda en tu zona. Elige tu provincia o ciudad.',
    url: `${SITE}/transporte`,
  },
};

export default function TransporteHubPage() {
  const provinces = getAllProvinces();

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'Transporte', item: `${SITE}/transporte` },
    ],
  };

  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <JsonLd data={breadcrumbJsonLd} />

      <nav aria-label="Migas" style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '1.25rem' }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Inicio</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <span style={{ color: 'var(--text-secondary)' }}>Transporte</span>
      </nav>

      <h1 style={{ fontSize: '2.25rem', fontWeight: 800, lineHeight: 1.2, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>
        Transporte con TriciGo
      </h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '2.5rem' }}>
        TriciGo es la app de movilidad urbana: pide un triciclo, una moto o un auto, o un
        servicio de mensajería, y sigue tu viaje en tiempo real con precio claro antes de confirmar.
        Elige tu provincia para ver cómo funciona el servicio bajo demanda en tu zona.
      </p>

      <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1rem', color: 'var(--text-primary)' }}>
        Elige tu provincia
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: '0.75rem',
        }}
      >
        {provinces.map((p) => (
          <Link
            key={p.value}
            href={`/transporte/${p.slug}`}
            style={{
              display: 'block',
              padding: '1rem 1.1rem',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-light)',
              borderRadius: '0.75rem',
              textDecoration: 'none',
              color: 'var(--text-primary)',
              fontWeight: 600,
              fontSize: '0.95rem',
            }}
          >
            {p.name}
            <span style={{ display: 'block', fontSize: '0.78rem', fontWeight: 400, color: 'var(--text-tertiary)', marginTop: '0.2rem' }}>
              {p.municipios.length} {p.municipios.length === 1 ? 'municipio' : 'municipios'}
            </span>
          </Link>
        ))}
      </div>
    </main>
  );
}
