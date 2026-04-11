'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useTranslation } from '@tricigo/i18n';
import { blogService } from '@tricigo/api';
import type { BlogPost } from '@tricigo/api';
import { sanitizeHtml } from '@/lib/sanitize';

export default function BlogPostPage() {
  const { t, i18n } = useTranslation('web');
  const params = useParams();
  const slug = params?.slug as string;
  const [post, setPost] = useState<BlogPost | null>(null);
  const [loading, setLoading] = useState(true);
  const locale = i18n.language === 'en' ? 'en' : 'es';

  useEffect(() => {
    if (!slug) return;
    blogService
      .getPostBySlug(slug)
      .then((p) => {
        if (p && p.is_published) setPost(p);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <main style={{ maxWidth: 800, margin: '0 auto', padding: '2rem 1.5rem' }}>
        <p style={{ color: '#888' }}>{t('blog.loading')}</p>
      </main>
    );
  }

  if (!post) {
    return (
      <main style={{ maxWidth: 800, margin: '0 auto', padding: '2rem 1.5rem' }}>
        <p style={{ color: '#888', marginBottom: '1rem' }}>{t('blog.not_found')}</p>
        <Link href="/blog" style={{ color: 'var(--primary)', textDecoration: 'none', fontWeight: 600 }}>
          {t('blog.back_to_blog')}
        </Link>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <Link
        href="/blog"
        style={{ color: 'var(--primary)', textDecoration: 'none', fontWeight: 600, fontSize: '0.9rem', display: 'inline-block', marginBottom: '1.5rem' }}
      >
        {t('blog.back_to_blog')}
      </Link>

      {post.cover_image_url && (
        <div style={{ position: 'relative', width: '100%', height: 300, marginBottom: '1.5rem' }}>
          <Image
            src={post.cover_image_url}
            alt={locale === 'en' ? post.title_en : post.title_es}
            fill
            style={{ objectFit: 'cover', borderRadius: '1rem' }}
            sizes="(max-width: 800px) 100vw, 800px"
          />
        </div>
      )}

      <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem' }}>
        {locale === 'en' ? post.title_en : post.title_es}
      </h1>

      {post.published_at && (
        <p style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '2rem' }}>
          {new Date(post.published_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'es-CU', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        </p>
      )}

      <div
        style={{ lineHeight: 1.8, color: '#333', fontSize: '1rem' }}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(locale === 'en' ? post.body_en : post.body_es) }}
      />
    </main>
  );
}
