// Per-province local-SEO landing page. Server-rendered with unique copy +
// the province's real municipality list, plus Service (areaServed),
// BreadcrumbList and FAQPage JSON-LD. Targets local searches like
// "transporte en La Habana" / "pedir triciclo Santiago de Cuba".

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/JsonLd';
import { getAllProvinceSlugs, getProvinceBySlug } from '@/lib/coverage';

const SITE = 'https://tricigo.com';

const SERVICES: { emoji: string; title: string; desc: string }[] = [
  { emoji: '🛺', title: 'Triciclo', desc: 'Económico y ecológico, ideal para distancias cortas dentro de la ciudad.' },
  { emoji: '🏍️', title: 'Moto', desc: 'Rápido y ágil para moverte sin demoras por el tránsito.' },
  { emoji: '🚗', title: 'Auto', desc: 'Cómodo y espacioso para viajes largos o en grupo.' },
  { emoji: '📦', title: 'Mensajería', desc: 'Envío de paquetes de un punto a otro, rápido y con seguimiento.' },
];

export function generateStaticParams() {
  return getAllProvinceSlugs().map((provincia) => ({ provincia }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ provincia: string }>;
}): Promise<Metadata> {
  const { provincia } = await params;
  const p = getProvinceBySlug(provincia);
  if (!p) return { title: 'Provincia no encontrada', robots: { index: false } };
  const url = `${SITE}/transporte/${p.slug}`;
  // No "| TriciGo" here — the root layout's title template ('%s | TriciGo')
  // appends it. Including it would double the suffix in the <title>.
  const title = `Transporte en ${p.name} — Triciclos, motos y autos`;
  return {
    title,
    description: p.content.metaDescription,
    alternates: { canonical: url },
    openGraph: {
      title,
      description: p.content.metaDescription,
      url,
      siteName: 'TriciGo',
    },
  };
}

export default async function ProvincePage({
  params,
}: {
  params: Promise<{ provincia: string }>;
}) {
  const { provincia } = await params;
  const p = getProvinceBySlug(provincia);
  if (!p) notFound();

  const url = `${SITE}/transporte/${p.slug}`;

  const serviceJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: 'Transporte bajo demanda',
    name: `TriciGo en ${p.name}`,
    description: p.content.intro,
    provider: { '@type': 'Organization', name: 'TriciGo', url: SITE },
    areaServed: { '@type': 'AdministrativeArea', name: `${p.name}, Cuba` },
    offers: { '@type': 'Offer', availability: 'https://schema.org/InStock' },
  };

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'Transporte en Cuba', item: `${SITE}/transporte` },
      { '@type': 'ListItem', position: 3, name: p.name, item: url },
    ],
  };

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: p.content.faqs.map((f) => ({
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
        <span style={{ color: 'var(--text-secondary)' }}>{p.name}</span>
      </nav>

      {/* Hero */}
      <h1 style={{ fontSize: '2.25rem', fontWeight: 800, lineHeight: 1.2, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>
        Transporte en {p.name} con TriciGo
      </h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1.75rem' }}>
        {p.content.intro}
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
      {p.content.bodyParagraphs.map((para, i) => (
        <p key={i} style={{ color: 'var(--text-secondary)', lineHeight: 1.75, fontSize: '0.98rem', marginBottom: '1.1rem' }}>
          {para}
        </p>
      ))}

      {/* Services */}
      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.25rem 0 1rem', color: 'var(--text-primary)' }}>
        Servicios disponibles en {p.name}
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
        <li style={{ marginBottom: '0.5rem' }}><strong>Elegí tu destino</strong> — ingresá la recogida y el destino y verás el precio estimado al instante.</li>
        <li style={{ marginBottom: '0.5rem' }}><strong>Seleccioná el vehículo</strong> — triciclo, moto o auto, según tu necesidad y presupuesto.</li>
        <li><strong>Viajá seguro</strong> — seguí el viaje en el mapa, compartí tu ubicación y pagá en efectivo o con TriciCoin.</li>
      </ol>

      {/* Municipalities covered */}
      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.25rem 0 1rem', color: 'var(--text-primary)' }}>
        Municipios de {p.name}
      </h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.92rem', marginBottom: '0.85rem', lineHeight: 1.6 }}>
        TriciGo se despliega por zonas dentro de {p.name}. Consultá la disponibilidad en la app en estos municipios:
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
        {p.municipios.map((m) => (
          <span
            key={m.value}
            style={{
              fontSize: '0.82rem',
              padding: '0.35rem 0.7rem',
              borderRadius: '999px',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-light)',
              color: 'var(--text-secondary)',
            }}
          >
            {m.label}
          </span>
        ))}
      </div>

      {/* FAQ */}
      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.5rem 0 1rem', color: 'var(--text-primary)' }}>
        Preguntas frecuentes — {p.name}
      </h2>
      {p.content.faqs.map((f, i) => (
        <div key={i} style={{ marginBottom: '1.1rem' }}>
          <h3 style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.3rem' }}>{f.q}</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.92rem' }}>{f.a}</p>
        </div>
      ))}

      {/* CTA */}
      <div style={{ marginTop: '2.75rem', padding: '2rem', background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
          Pedí tu viaje en {p.name}
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', fontSize: '0.95rem' }}>
          Descargá TriciGo y solicitá tu primer viaje en minutos.
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
