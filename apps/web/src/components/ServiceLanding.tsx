// Shared renderer for the per-service landing pages (/triciclo, /moto, /auto,
// /mensajeria). Server component; mirrors transporte/[provincia]/page.tsx.
// The 4 route files each export buildServiceMetadata(slug) + <ServiceLanding slug>.

import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/JsonLd';
import { getService, getOtherServices } from '@/lib/services';

const SITE = 'https://tricigo.com';

export function buildServiceMetadata(slug: string): Metadata {
  const svc = getService(slug);
  if (!svc) return { title: 'Servicio', robots: { index: false } };
  const url = `${SITE}/${slug}`;
  // No "| TriciGo" — the root layout title template appends it.
  return {
    title: svc.content.metaTitle,
    description: svc.content.metaDescription,
    // The per-service landing copy (lib/services-content.ts) is still Cuba-forward.
    // Keep these pages out of search/crawlers until that copy is neutralized, to
    // hold the public surface region-neutral. Reachable by direct URL + footer.
    robots: { index: false, follow: false },
    alternates: { canonical: url },
    openGraph: {
      title: svc.content.metaTitle,
      description: svc.content.metaDescription,
      url,
      siteName: 'TriciGo',
    },
  };
}

export function ServiceLanding({ slug }: { slug: string }) {
  const svc = getService(slug);
  if (!svc) notFound();
  const { def, content } = svc;
  const url = `${SITE}/${slug}`;
  const others = getOtherServices(slug);

  const serviceJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: 'Transporte bajo demanda',
    name: `${def.label} con TriciGo`,
    description: content.intro,
    provider: { '@type': 'Organization', name: 'TriciGo', url: SITE },
    offers: { '@type': 'Offer', availability: 'https://schema.org/InStock' },
  };

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITE },
      { '@type': 'ListItem', position: 2, name: def.label, item: url },
    ],
  };

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: content.faqs.map((f) => ({
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
        <span style={{ color: 'var(--text-secondary)' }}>{def.label}</span>
      </nav>

      {/* Hero */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <Image
          src={def.img}
          alt={def.label}
          width={96}
          height={96}
          style={{ width: 96, height: 96, objectFit: 'contain' }}
        />
        <h1 style={{ fontSize: '2.25rem', fontWeight: 800, lineHeight: 1.2, color: 'var(--text-primary)', margin: 0 }}>
          {content.h1}
        </h1>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1.75rem' }}>
        {content.intro}
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
      {content.bodyParagraphs.map((para, i) => (
        <p key={i} style={{ color: 'var(--text-secondary)', lineHeight: 1.75, fontSize: '0.98rem', marginBottom: '1.1rem' }}>
          {para}
        </p>
      ))}

      {/* How it works */}
      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.25rem 0 1rem', color: 'var(--text-primary)' }}>
        ¿Cómo funciona?
      </h2>
      <ol style={{ paddingLeft: '1.25rem', margin: 0, color: 'var(--text-secondary)', lineHeight: 1.7, fontSize: '0.95rem' }}>
        <li style={{ marginBottom: '0.5rem' }}><strong>Elegí tu destino</strong> — ingresá la recogida y el destino y verás el precio estimado al instante.</li>
        <li style={{ marginBottom: '0.5rem' }}><strong>Confirmá el {def.label.toLowerCase()}</strong> — aceptás el precio antes de viajar, sin sorpresas al bajarte.</li>
        <li><strong>Viajá seguro</strong> — seguí el viaje en el mapa, compartí tu ubicación y pagá en efectivo o con TriciCoin.</li>
      </ol>

      {/* FAQ */}
      <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.5rem 0 1rem', color: 'var(--text-primary)' }}>
        Preguntas frecuentes
      </h2>
      {content.faqs.map((f, i) => (
        <div key={i} style={{ marginBottom: '1.1rem' }}>
          <h3 style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.3rem' }}>{f.q}</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.92rem' }}>{f.a}</p>
        </div>
      ))}

      {/* Other services */}
      {others.length > 0 && (
        <>
          <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '2.5rem 0 1rem', color: 'var(--text-primary)' }}>
            Otros servicios de TriciGo
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem' }}>
            {others.map((o) => (
              <Link
                key={o.slug}
                href={`/${o.slug}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  padding: '0.8rem 1rem',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-light)',
                  borderRadius: '0.75rem',
                  textDecoration: 'none',
                  color: 'var(--text-primary)',
                  fontWeight: 600,
                  fontSize: '0.92rem',
                }}
              >
                <Image src={o.img} alt={o.label} width={32} height={32} style={{ width: 32, height: 32, objectFit: 'contain' }} />
                {o.label}
              </Link>
            ))}
          </div>
        </>
      )}

      {/* Internal links */}
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.7, marginTop: '2rem' }}>
        Mirá la{' '}
        <Link href="/transporte" style={{ color: 'var(--primary)', fontWeight: 600 }}>cobertura por provincia</Link>
        {' '}o leé sobre{' '}
        <Link href={`/blog/${def.blogSlug}`} style={{ color: 'var(--primary)', fontWeight: 600 }}>{def.blogLabel}</Link>.
      </p>

      {/* CTA */}
      <div style={{ marginTop: '2.75rem', padding: '2rem', background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', textAlign: 'center' }}>
        <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
          Pedí tu {def.label.toLowerCase()} con TriciGo
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', fontSize: '0.95rem' }}>
          Descargá la app y solicitá tu viaje en minutos.
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
