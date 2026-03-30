'use client';

import { useTranslation } from '@tricigo/i18n';

export function WebFooter() {
  const { t } = useTranslation('web');

  return (
    <footer className="footer-enhanced">
      <div className="footer-grid">
        <div>
          <div className="footer-brand-name">
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p className="footer-brand-desc">
            {t('footer.location')}
          </p>
        </div>

        <div>
          <div className="footer-section-title">{t('footer.quick_links', { defaultValue: 'Links' })}</div>
          <a href="/book" className="footer-link">{t('footer.book_ride')}</a>
          <a href="/login" className="footer-link">{t('footer.login')}</a>
          <a href="/blog" className="footer-link">{t('footer.blog')}</a>
        </div>

        <div>
          <div className="footer-section-title">{t('footer.legal', { defaultValue: 'Legal' })}</div>
          <a href="/privacy" className="footer-link">{t('footer.privacy')}</a>
          <a href="/terms" className="footer-link">{t('footer.terms')}</a>
        </div>
      </div>

      <div className="footer-copy">
        TriciGo &copy; {new Date().getFullYear()} &middot; {t('footer.download')}
      </div>
    </footer>
  );
}
