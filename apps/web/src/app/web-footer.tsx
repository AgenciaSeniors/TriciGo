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
          <div className="footer-social-label">{t('footer.follow_us', { defaultValue: 'Seguinos' })}</div>
          <div className="footer-social">
            <a
              href="https://facebook.com/tricigoapp"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="TriciGo en Facebook"
              className="footer-social-icon"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" /></svg>
            </a>
            <a
              href="https://www.instagram.com/tricigo_app"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="TriciGo en Instagram"
              className="footer-social-icon"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" /></svg>
            </a>
            <a
              href="mailto:soporte@tricigo.com"
              aria-label="Escribinos a soporte@tricigo.com"
              className="footer-social-icon"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1.5 8.67v8.58a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3V8.67l-8.928 5.493a3 3 0 0 1-3.144 0L1.5 8.67Z" /><path d="M22.5 6.908V6.75a3 3 0 0 0-3-3h-15a3 3 0 0 0-3 3v.158l9.714 5.978a1.5 1.5 0 0 0 1.572 0L22.5 6.908Z" /></svg>
            </a>
          </div>
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
          <div className="footer-section-title">{t('footer.services', { defaultValue: 'Servicios' })}</div>
          <a href="/triciclo" className="footer-link">Triciclo</a>
          <a href="/moto" className="footer-link">Moto</a>
          <a href="/auto" className="footer-link">Auto</a>
          <a href="/mensajeria" className="footer-link">Mensajería</a>
          <a href="/uber-cuba" className="footer-link">¿Hay Uber en Cuba?</a>
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
        TriciGo &copy; {new Date().getFullYear()} &middot;{' '}
        <a
          href="https://play.google.com/store/apps/details?id=app.tricigo.client"
          target="_blank"
          rel="noopener noreferrer"
          className="footer-link"
        >
          {t('footer.download')}
        </a>
      </div>
      <div className="footer-copy" style={{ marginTop: '0.5rem', fontSize: '0.75rem', opacity: 0.85 }}>
        TriciGo es un servicio operado por MACH DIGITAL TECH S.R.L. &middot; CUI 54552055 &middot; Nr. Reg. Com. J2026027319006 &middot; Str. Lungă nr. 149, Ap. P3, Brașov, Rumanía
      </div>
    </footer>
  );
}
