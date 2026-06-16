import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/JsonLd';
import { getPostBySlugServer, getPublishedPostsServer } from '@/lib/blog-server';
import { sanitizeHtml } from '@/lib/sanitize';

// Server-rendered article: crawlers receive the title, body and structured data
// in the initial HTML (previously this was a 'use client' page that fetched in
// useEffect → empty for bots). Spanish is the canonical locale (Cuba).
export const revalidate = 3600;

const SITE = 'https://tricigo.com';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Havana',
  });
}

export async function generateStaticParams() {
  const posts = await getPublishedPostsServer(100);
  return posts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlugServer(slug);
  if (!post) {
    return { title: 'Artículo no encontrado', robots: { index: false } };
  }
  const url = `${SITE}/blog/${post.slug}`;
  return {
    title: post.title_es,
    description: post.excerpt_es,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      title: post.title_es,
      description: post.excerpt_es,
      url,
      siteName: 'TriciGo',
      ...(post.published_at ? { publishedTime: post.published_at } : {}),
      ...(post.cover_image_url ? { images: [{ url: post.cover_image_url }] } : {}),
    },
    twitter: {
      // Every post now has a 1200x630 image: its cover_image_url when set,
      // otherwise the dynamic branded card from blog/[slug]/opengraph-image.tsx.
      card: 'summary_large_image',
      title: post.title_es,
      description: post.excerpt_es,
    },
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPostBySlugServer(slug);
  if (!post) notFound();

  const related = (await getPublishedPostsServer(7))
    .filter((r) => r.slug !== post.slug)
    .slice(0, 3);

  const url = `${SITE}/blog/${post.slug}`;

  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title_es,
    description: post.excerpt_es,
    ...(post.cover_image_url ? { image: [post.cover_image_url] } : {}),
    ...(post.published_at ? { datePublished: post.published_at } : {}),
    dateModified: post.updated_at ?? post.published_at ?? undefined,
    author: { '@type': 'Organization', name: 'TriciGo', url: SITE },
    publisher: {
      '@type': 'Organization',
      name: 'TriciGo',
      logo: { '@type': 'ImageObject', url: `${SITE}/logo-wordmark.png` },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
  };

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE}/blog` },
      { '@type': 'ListItem', position: 3, name: post.title_es, item: url },
    ],
  };

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <JsonLd data={articleJsonLd} />
      <JsonLd data={breadcrumbJsonLd} />

      {/* Breadcrumb (matches the BreadcrumbList JSON-LD above) */}
      <nav aria-label="Migas" style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '1.5rem' }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Inicio</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <Link href="/blog" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>Blog</Link>
        <span style={{ margin: '0 0.4rem' }}>/</span>
        <span style={{ color: 'var(--text-secondary)' }}>{post.title_es}</span>
      </nav>

      {post.cover_image_url && (
        <div style={{ position: 'relative', width: '100%', height: 300, marginBottom: '1.5rem' }}>
          <Image
            src={post.cover_image_url}
            alt={post.title_es}
            fill
            style={{ objectFit: 'cover', borderRadius: '1rem' }}
            sizes="(max-width: 800px) 100vw, 800px"
            priority
          />
        </div>
      )}

      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem' }}>{post.title_es}</h1>

      {post.published_at && (
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', marginBottom: '2rem' }}>
          {formatDate(post.published_at)}
        </p>
      )}

      <div
        style={{ lineHeight: 1.8, color: 'var(--text-primary)', fontSize: '1rem' }}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(post.body_es) }}
      />

      {/* Related posts — internal linking + dwell time */}
      {related.length > 0 && (
        <section style={{ marginTop: '3rem', paddingTop: '2rem', borderTop: '1px solid var(--border-light)' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: '1rem', color: 'var(--text-primary)' }}>
            Seguí leyendo
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
            {related.map((r) => (
              <Link
                key={r.id}
                href={`/blog/${r.slug}`}
                style={{ textDecoration: 'none', color: 'inherit', display: 'block', border: '1px solid var(--border-light)', borderRadius: '0.75rem', padding: '1.1rem' }}
              >
                <h3 style={{ fontSize: '0.98rem', fontWeight: 700, marginBottom: '0.4rem', color: 'var(--text-primary)', lineHeight: 1.35 }}>
                  {r.title_es}
                </h3>
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary)' }}>Leer &rarr;</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
