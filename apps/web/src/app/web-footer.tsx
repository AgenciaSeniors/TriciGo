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
          <a href="/transporte" className="footer-link">{t('footer.coverage', { defaultValue: 'Cobertura' })}</a>
          <a href="/empresas" className="footer-link">{t('footer.empresas', { defaultValue: 'Empresas' })}</a>
        </div>

        <div>
          <div className="footer-section-title">{t('footer.legal', { defaultValue: 'Legal' })}</div>
          <a href="/privacy" className="footer-link">{t('footer.privacy')}</a>
          <a href="/terms" className="footer-link">{t('footer.terms')}</a>
          <a href="/refunds" className="footer-link">{t('footer.refunds', { defaultValue: 'Reembolsos' })}</a>
          <a href="/delivery-policy" className="footer-link">{t('footer.delivery_policy', { defaultValue: 'Prestación del servicio' })}</a>
          <a href="/account/delete" className="footer-link">{t('footer.delete_account', { defaultValue: 'Eliminar cuenta' })}</a>
          <a href="/aml" className="footer-link">{t('footer.aml', { defaultValue: 'Política AML' })}</a>
          <a href="/cookies" className="footer-link">{t('footer.cookies', { defaultValue: 'Cookies' })}</a>
          <a href="/contact" className="footer-link">{t('footer.contact', { defaultValue: 'Contacto' })}</a>
        </div>
      </div>

      {/* Payment processor + Romanian consumer-protection compliance row.
          Required by NETOPIA's POS enrollment checklist: the NETOPIA badge
          (official assets from their mediakit CDN, POS id 165079) and the
          ANPC SAL/SOL dispute-resolution links (MACH DIGITAL TECH S.R.L. is
          a Romanian company). */}
      <div className="footer-compliance">
        <a
          href="https://netopia-payments.com"
          target="_blank"
          rel="noopener noreferrer"
          title="NETOPIA Payments"
          aria-label="NETOPIA Payments"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://mny.ro/np-black-0.svg"
            alt="NETOPIA Payments"
            className="netopia-badge netopia-badge-light"
            loading="lazy"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://mny.ro/np-white-0.svg"
            alt="NETOPIA Payments"
            className="netopia-badge netopia-badge-dark"
            loading="lazy"
          />
        </a>
        <div className="footer-compliance-links">
          <a
            href="https://anpc.ro/ce-este-sal/"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-link"
          >
            ANPC — Soluționarea Alternativă a Litigiilor (SAL)
          </a>
          <a
            href="https://ec.europa.eu/consumers/odr"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-link"
          >
            Soluționarea Online a Litigiilor (SOL)
          </a>
        </div>
      </div>

      <div className="footer-copy">
        TriciGo &copy; {new Date().getFullYear()} &middot; {t('footer.download')}
      </div>
      <div className="footer-copy" style={{ marginTop: '0.5rem', fontSize: '0.75rem', opacity: 0.85 }}>
        TriciGo es un servicio operado por MACH DIGITAL TECH S.R.L. &middot; CUI 54552055 &middot; Nr. Reg. Com. J2026027319006 &middot; Str. Lungă nr. 149, Ap. P3, Brașov, Rumanía
      </div>
    </footer>
  );
}
