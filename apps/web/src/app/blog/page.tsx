'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { blogService } from '@tricigo/api';
import type { BlogPost } from '@tricigo/api';

export default function BlogPage() {
  const { t, i18n } = useTranslation('web');
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const locale = i18n.language === 'en' ? 'en' : 'es';

  useEffect(() => {
    blogService.getPublishedPosts(0, 20).then(setPosts).catch(console.error).finally(() => setLoading(false));
  }, []);

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem' }}>{t('blog.title')}</h1>
      <p style={{ color: '#888', marginBottom: '2rem' }}>{t('blog.subtitle')}</p>
      {loading ? (
        <p style={{ color: '#888' }}>{t('blog.loading')}</p>
      ) : posts.length === 0 ? (
        <p style={{ color: '#888' }}>{t('blog.no_posts')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          {posts.map((post) => (
            <Link key={post.id} href={`/blog/${post.slug}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <article style={{ border: '1px solid #eee', borderRadius: '1rem', overflow: 'hidden' }}>
                {post.cover_image_url && (
                  <img src={post.cover_image_url} alt="" style={{ width: '100%', height: 200, objectFit: 'cover' }} />
                )}
                <div style={{ padding: '1.5rem' }}>
                  <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                    {locale === 'en' ? post.title_en : post.title_es}
                  </h2>
                  <p style={{ color: '#666', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                    {locale === 'en' ? post.excerpt_en : post.excerpt_es}
                  </p>
                  {post.published_at && (
                    <p style={{ color: '#aaa', fontSize: '0.8rem' }}>
                      {new Date(post.published_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'es-CU', { year: 'numeric', month: 'long', day: 'numeric' })}
                    </p>
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
