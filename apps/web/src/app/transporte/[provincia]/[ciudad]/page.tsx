// Per-city local-SEO landing page. Server-rendered with unique copy, plus
// Service (areaServed = city), BreadcrumbList (4 levels) and FAQPage JSON-LD.
// Targets city-level searches like "transporte en Santiago de Cuba" /
// "pedir un triciclo en Trinidad". Nested under the province for hierarchy.

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/JsonLd';
import { getAllCityParams, getCityBySlug } from '@/lib/cities';

const SITE = 'https://tricigo.com';

const SERVICES: { emoji: string; title: string; desc: string }[] = [
  { emoji: '🛺', title: 'Triciclo', desc: 'Económico y ecológico, ideal para distancias cortas dentro de la ciudad.' },
  { emoji: '🏍️', title: 'Moto', desc: 'Rápido y ágil para moverte sin demoras por el tránsito.' },
  { emoji: '🚗', title: 'Auto', desc: 'Cómodo y espacioso para viajes largos o en grupo.' },
  { emoji: '📦', title: 'Mensajería', desc: 'Envío de paquetes de un punto a otro, rápido y con seguimiento.' },
];

const ORIENTE = new Set(['las_tunas', 'holguin', 'granma', 'santiago_de_cuba', 'guantanamo', 'camaguey']);

function blogLinksFor(provinceValue: string): { href: string; label: string }[] {
  const links = [
    { href: '/blog/tarifas-transporte-cuba-2026', label: 'tarifas de transporte en Cuba 2026' },
    { href: '/blog/glosario-transporte-cubano', label: 'glosario del transporte cubano' },
  ];
  if (provinceValue === 'la_habana') {
    links.unshift({ href: '/blog/como-moverse-en-la-habana', label: 'cómo moverse en La Habana' });
  } else if (ORIENTE.has(provinceValue)) {
    links.unshift({ href: '/blog/como-pedir-carro-app-oriente-cuba', label: 'cómo pedir un carro por app en oriente' });
  }
  return links;
}

export function generateStaticParams() {
  return getAllCityParams();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ provincia: string; ciudad: string }>;
}): Promise<Metadata> {
  const { provincia, ciudad } = await params;
  const city = getCityBySlug(provincia, ciudad);
  if (!city) return { title: 'Ciudad no encontrada', robots: { index: false } };
  const url = `${SITE}/transporte/${city.provinceSlug}/${city.citySlug}`;
  // No "| TriciGo" here — the root layout's title template appends it.
  const title = `Transporte en ${city.cityName} (${city.provinceName}) — Triciclos, motos y autos`;
  return {
    title,
    description: city.content.metaDescription,
    alternates: { canonical: url },
    openGraph: {
      title,
      description: city.content.metaDescription,
      url,
      siteName: 'TriciGo',
    },
  };
}

export default async function CityPage({
  params,
}: {
  params: Promise<{ provincia: string; ciudad: string }>;
}) {
  const { provincia, ciudad } = await params;
  const city = getCityBySlug(provincia, ciudad);
  if (!city) notFound();

  const url = `${SITE}/transporte/${city.provinceSlug}/${city.citySlug}`;
  const provinceUrl = `${SITE}/transporte/${city.provinceSlug}`;
  const blogLinks = blogLinksFor(city.provinceValue);

  const serviceJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: 'Transporte bajo demanda',
    name: `TriciGo en ${city.cityName}`,
    description: city.content.intro,
    provider: { '@type': 'Organization', name: 'TriciGo', url: SITE },
    areaServed: { '@type': 'City', name: `${city.cityName}, ${city.provinceName}, Cuba` },
    offers: { '@type': 'Offer', availability: 'https://schema.org/InStock' },
  };

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'Transporte en Cuba', item: `${SITE}/transporte` },
      { '@type': 'ListItem', position: 3, name: city.provinceName, item: provinceUrl },
      { '@type': 'ListItem', position: 4, name: city.cityName, item: url },
    ],
  };

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: city.content.faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '3rem 1.5rem' }}>
      <JsonLd data={serviceJsonLd} />
      <JsonLd data={breadcrumbJsonLd} />
      <JsonLd data={faqJsonLd} />

      {/* Breadcrumb */}
      <nav aria-label="Migas" style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '1.25rem' }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Inicio</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <Link href="/transporte" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Transporte en Cuba</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <Link href={`/transporte/${city.provinceSlug}`} style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>{city.provinceName}</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <span style={{ color: 'var(--text-secondary)' }}>{city.cityName}</span>
      </nav>

      {/* Hero */}
      <h1 style={{ fontSize: '2.25rem', fontWeight: 800, lineHeight: 1.2, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>
        Transporte en {city.cityName} con TriciGo
      </h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1.75rem' }}>
        {city.content.intro}
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
        Pedir un viaje
      </Link>

      {/* Unique body copy */}
      {city.content.bodyParagraphs.map((para, i) => (
        <p key={i} style={{ color: 'var(--text-secondary)', lineHeight: 1.75, fontSize: '0.98rem', marginBottom: '1.1rem' }}>
          {para}
        </p>
      ))}

      {/* Services */}
      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.25rem 0 1rem', color: 'var(--text-primary)' }}>
        Servicios disponibles en {city.cityName}
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.85rem' }}>
        {SERVICES.map((s) => (
          <div key={s.title} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: '0.75rem', padding: '1.25rem' }}>
            <div style={{ fontSize: '1.6rem', marginBottom: '0.5rem' }}>{s.emoji}</div>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.4rem', color: 'var(--text-primary)' }}>{s.title}</h3>
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{s.desc}</p>
          </div>
        ))}
      </div>

      {/* How it works */}
      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.25rem 0 1rem', color: 'var(--text-primary)' }}>
        ¿Cómo funciona?
      </h2>
      <ol style={{ paddingLeft: '1.25rem', margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7, fontSize: '0.95rem' }}>
        <li style={{ marginBottom: '0.5rem' }}><strong>Elige tu destino</strong> — ingresa la recogida y el destino y verás el precio estimado al instante.</li>
        <li style={{ marginBottom: '0.5rem' }}><strong>Selecciona el vehículo</strong> — triciclo, moto o auto, según tu necesidad y presupuesto.</li>
        <li><strong>Viaja seguro</strong> — sigue el viaje en el mapa, comparte tu ubicación y paga en efectivo o con TriciCoin.</li>
      </ol>

      {/* FAQ */}
      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.5rem 0 1rem', color: 'var(--text-primary)' }}>
        Preguntas frecuentes — {city.cityName}
      </h2>
      {city.content.faqs.map((f, i) => (
        <div key={i} style={{ marginBottom: '1.1rem' }}>
          <h3 style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.3rem' }}>{f.q}</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.92rem' }}>{f.a}</p>
        </div>
      ))}

      {/* Internal links: province + guides */}
      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.5rem 0 1rem', color: 'var(--text-primary)' }}>
        Sigue leyendo
      </h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.7 }}>
        Mira todo el{' '}
        <Link href={`/transporte/${city.provinceSlug}`} style={{ color: 'var(--primary)', fontWeight: 600 }}>
          transporte en {city.provinceName}
        </Link>
        {blogLinks.map((b, i) => (
          <span key={b.href}>
            {i === 0 ? ', o lee sobre ' : ' y '}
            <Link href={b.href} style={{ color: 'var(--primary)', fontWeight: 600 }}>{b.label}</Link>
          </span>
        ))}
        .
      </p>

      {/* CTA */}
      <div style={{ marginTop: '2.75rem', padding: '2rem', background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
          Pide tu viaje en {city.cityName}
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', fontSize: '0.95rem' }}>
          Descarga TriciGo y solicita tu primer viaje en minutos.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="https://play.google.com/store/apps/details?id=app.tricigo.client" target="_blank" rel="noopener noreferrer"
            style={{ padding: '0.75rem 1.4rem', background: 'var(--primary)', color: '#fff', borderRadius: '0.75rem', fontSize: '0.9rem', fontWeight: 700, textDecoration: 'none' }}>
            Google Play
          </a>
          <a href="https://apps.apple.com/app/id6785157005" target="_blank" rel="noopener noreferrer"
            style={{ padding: '0.75rem 1.4rem', background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)', borderRadius: '0.75rem', fontSize: '0.9rem', fontWeight: 700, textDecoration: 'none' }}>
            App Store
          </a>
        </div>
      </div>
    </main>
  );
}
