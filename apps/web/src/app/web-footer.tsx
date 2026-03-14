'use client';

import { useTranslation } from '@tricigo/i18n';

export function WebFooter() {
  const { t } = useTranslation('web');

  return (
    <footer
      style={{
        borderTop: '1px solid #eee',
        padding: '2rem',
        textAlign: 'center',
        color: '#999',
        fontSize: '0.8rem',
      }}
    >
      <div style={{ marginBottom: '0.75rem' }}>
        <span style={{ fontWeight: 700, color: '#111' }}>
          Trici<span style={{ color: 'var(--primary)' }}>Go</span>
        </span>
        {' · '}{t('footer.location')}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '1.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <a href="/book" style={{ color: '#666', textDecoration: 'none', fontSize: '0.8rem' }}>
          {t('footer.book_ride')}
        </a>
        <a href="/login" style={{ color: '#666', textDecoration: 'none', fontSize: '0.8rem' }}>
          {t('footer.login')}
        </a>
        <a href="/privacy" style={{ color: '#666', textDecoration: 'none', fontSize: '0.8rem' }}>
          {t('footer.privacy')}
        </a>
        <a href="/terms" style={{ color: '#666', textDecoration: 'none', fontSize: '0.8rem' }}>
          {t('footer.terms')}
        </a>
        <a href="/blog" style={{ color: '#666', textDecoration: 'none', fontSize: '0.8rem' }}>
          {t('footer.blog')}
        </a>
      </div>
      <p>TriciGo &copy; {new Date().getFullYear()} &middot; {t('footer.download')}</p>
    </footer>
  );
}
