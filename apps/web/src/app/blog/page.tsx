import Link from 'next/link';
import Image from 'next/image';
import { getPublishedPostsServer } from '@/lib/blog-server';

// Server-rendered so crawlers get the full post list (titles, excerpts, links)
// in the initial HTML. ISR: revalidated hourly, matching the /blog Cache-Control
// in next.config.ts. Spanish is the canonical locale (<html lang="es">, Cuba).
export const revalidate = 3600;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Havana',
  });
}

export default async function BlogPage() {
  const posts = await getPublishedPostsServer(50);

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem' }}>Blog</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>
        Noticias y novedades de TriciGo
      </p>

      {posts.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)' }}>Sin publicaciones aún</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          {posts.map((post) => (
            <Link
              key={post.id}
              href={`/blog/${post.slug}`}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <article style={{ border: '1px solid var(--border-light)', borderRadius: '1rem', overflow: 'hidden' }}>
                {post.cover_image_url ? (
                  <div style={{ position: 'relative', width: '100%', height: 200 }}>
                    <Image
                      src={post.cover_image_url}
                      alt={post.title_es || ''}
                      fill
                      sizes="(max-width: 800px) 100vw, 800px"
                      style={{ objectFit: 'cover' }}
                    />
                  </div>
                ) : (
                  // Branded fallback header for posts without a cover image, so
                  // the listing stays uniform (mirrors the dynamic OG card).
                  <div
                    style={{
                      width: '100%',
                      height: 200,
                      background: 'var(--gradient-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Image
                      src="/logo-wordmark-white.png"
                      alt="TriciGo"
                      width={180}
                      height={43}
                      style={{ width: 180, height: 'auto', opacity: 0.95 }}
                    />
                  </div>
                )}
                <div style={{ padding: '1.5rem' }}>
                  <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                    {post.title_es}
                  </h2>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                    {post.excerpt_es}
                  </p>
                  {post.published_at && (
                    <time
                      dateTime={post.published_at}
                      style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem', display: 'block' }}
                    >
                      {formatDate(post.published_at)}
                    </time>
                  )}
                </div>
              </article>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
