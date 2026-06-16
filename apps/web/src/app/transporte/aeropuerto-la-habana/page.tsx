// Hub for the José Martí airport transfer routes. Links each origin->destination
// page. Static folder takes precedence over the /transporte/[provincia] dynamic
// segment, so this resolves correctly. Server-rendered + in the sitemap.

import type { Metadata } from 'next';
import Link from 'next/link';
import { JsonLd } from '@/components/JsonLd';
import { AIRPORT, AIRPORT_ROUTES } from '@/lib/airport-routes';

const SITE = 'https://tricigo.com';

export const metadata: Metadata = {
  title: 'Taxi del aeropuerto de La Habana (José Martí): precios y cómo llegar al centro',
  description:
    'Cómo llegar del Aeropuerto José Martí a El Vedado, La Habana Vieja, Miramar o las Playas del Este sin que te claven. Reserva con TriciGo y mira el precio en CUP antes de subir.',
  alternates: { canonical: `${SITE}${AIRPORT.hubPath}` },
  openGraph: {
    title: 'Taxi del aeropuerto de La Habana — precios y rutas al centro',
    description:
      'Del Aeropuerto José Martí al Vedado, Habana Vieja, Miramar o Playas del Este. Precio en CUP antes de subir, sin sobrecobro.',
    url: `${SITE}${AIRPORT.hubPath}`,
  },
};

export default function AirportHubPage() {
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'Transporte en Cuba', item: `${SITE}/transporte` },
      { '@type': 'ListItem', position: 3, name: 'Aeropuerto de La Habana', item: `${SITE}${AIRPORT.hubPath}` },
    ],
  };

  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <JsonLd data={breadcrumbJsonLd} />

      <nav aria-label="Migas" style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '1.25rem' }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Inicio</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <Link href="/transporte" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Transporte en Cuba</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <span style={{ color: 'var(--text-secondary)' }}>Aeropuerto de La Habana</span>
      </nav>

      <h1 style={{ fontSize: '2.25rem', fontWeight: 800, lineHeight: 1.2, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>
        Taxi del aeropuerto de La Habana
      </h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '2rem' }}>
        Salir del <strong>Aeropuerto Internacional José Martí</strong> es donde más se intenta el sobrecobro al recién llegado.
        Elige tu destino y mira cómo llegar pagando lo justo, con el precio en CUP claro antes de subir —sin tarifa de turista
        ni cobros en divisa.
      </p>

      <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1rem', color: 'var(--text-primary)' }}>
        Rutas desde el aeropuerto
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.75rem' }}>
        {AIRPORT_ROUTES.map((r) => (
          <Link
            key={r.slug}
            href={`${AIRPORT.hubPath}/${r.slug}`}
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
            Al {r.destino}
            <span style={{ display: 'block', fontSize: '0.78rem', fontWeight: 400, color: 'var(--text-tertiary)', marginTop: '0.2rem' }}>
              {r.distancia}
            </span>
          </Link>
        ))}
      </div>

      <div style={{ marginTop: '2.5rem' }}>
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
          }}
        >
          Pedir mi viaje
        </Link>
      </div>

      <p style={{ marginTop: '2rem', color: 'var(--text-secondary)', fontSize: '0.92rem', lineHeight: 1.6 }}>
        ¿Quieres más contexto antes de viajar? Lee <Link href="/blog/transporte-cuba-turistas" style={{ color: 'var(--primary)' }}>transporte en Cuba para turistas</Link>,
        las <Link href="/blog/tarifas-transporte-cuba-2026" style={{ color: 'var(--primary)' }}>tarifas de transporte 2026</Link> o
        cómo <Link href="/blog/no-te-estafen-precio-taxi-cuba" style={{ color: 'var(--primary)' }}>evitar que te estafen</Link>.
      </p>
    </main>
  );
}
