import type { Metadata } from 'next';
import { Suspense } from 'react';
import localFont from 'next/font/local';
import './globals.css';
import { I18nProvider } from './providers';
import { WebHeader } from './web-header';
import { WebFooter } from './web-footer';
import { JsonLd } from '../components/JsonLd';
import { DemoBanner } from '../components/DemoBanner';
import { WebOfflineBanner } from '../components/WebOfflineBanner';

// Self-hosted Montserrat (variable font, latin subset) instead of
// next/font/google. The deployed standalone build was NOT baking the Google
// fonts into .next/static, so the SSR server fetched fonts.gstatic.com at
// request time on every cold start — a big chunk of the GET / latency spikes
// (Sentry GET / regression, VPS investigation 2026-06-20). Bundling the woff2
// removes that runtime external dependency entirely.
const montserrat = localFont({
  src: './fonts/Montserrat-latin.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-montserrat',
  fallback: ['system-ui', 'sans-serif'],
});

export const metadata: Metadata = {
  title: {
    default: 'TriciGo — Pedí tu viaje | Triciclos, motos y autos',
    template: '%s | TriciGo',
  },
  description:
    'Pedí un viaje con TriciGo. Triciclos, motos y autos disponibles 24/7. Pago con saldo digital o efectivo. Descarga gratis.',
  keywords: ['taxi app', 'transporte', 'triciclo taxi', 'pedir taxi', 'TriciGo', 'ride hailing', 'pedicab', 'movilidad urbana'],
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.png', type: 'image/png', sizes: '32x32' },
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    type: 'website',
    locale: 'es',
    url: 'https://tricigo.com',
    siteName: 'TriciGo',
    title: 'TriciGo — Pedí tu viaje',
    description:
      'Solicita un viaje con TriciGo. Triciclos, motos y autos al mejor precio.',
    // og:image is provided by the file-based app/opengraph-image.tsx (dynamic,
    // uses the real wordmark logo). No explicit `images` here so it isn't
    // overridden by the old static /og-image.png.
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TriciGo — Pedí tu viaje',
    description:
      'Solicita un viaje con TriciGo. Rápido, seguro y al mejor precio.',
    // twitter:image also comes from app/opengraph-image.tsx (Next reuses it for Twitter).
  },
  metadataBase: new URL('https://tricigo.com'),
  alternates: {
    canonical: 'https://tricigo.com',
    // No `languages` hreflang map: there are no localized routes — every
    // language is served from the same URL (Spanish-first, <html lang="es">),
    // so pointing es/en at the same URL was misleading. Re-add real hreflang
    // only when localized /en routes exist.
  },
};

const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'TriciGo',
  legalName: 'MACH DIGITAL TECH S.R.L.',
  url: 'https://tricigo.com',
  logo: 'https://tricigo.com/logo-wordmark.png',
  // Official brand profiles — strengthens entity recognition / knowledge panel.
  sameAs: [
    'https://facebook.com/tricigoapp',
    'https://www.instagram.com/tricigo_app',
    'https://play.google.com/store/apps/details?id=app.tricigo.client',
  ],
  description:
    'Plataforma de transporte urbano. Solicita triciclos, motos y autos de forma rápida y segura.',
  taxID: '54552055',
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'Str. Lungă nr. 149, Ap. P3',
    addressLocality: 'Brașov',
    addressCountry: 'RO',
  },
  contactPoint: {
    '@type': 'ContactPoint',
    email: 'soporte@tricigo.com',
    contactType: 'customer service',
    availableLanguage: ['Spanish', 'English'],
  },
};

// WebSite schema: lets Google show the brand name in results and declares a
// sitewide search target (the blog supports ?q=). Enables the sitelinks
// searchbox when Google chooses to render it.
const webSiteJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'TriciGo',
  url: 'https://tricigo.com',
  inLanguage: 'es',
  publisher: { '@type': 'Organization', name: 'TriciGo', url: 'https://tricigo.com' },
  potentialAction: {
    '@type': 'SearchAction',
    target: {
      '@type': 'EntryPoint',
      urlTemplate: 'https://tricigo.com/blog?q={search_term_string}',
    },
    'query-input': 'required name=search_term_string',
  },
};

const localBusinessJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'LocalBusiness',
  name: 'TriciGo',
  legalName: 'MACH DIGITAL TECH S.R.L.',
  url: 'https://tricigo.com',
  description:
    'Servicio de transporte bajo demanda. Triciclos, motos y autos.',
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'Str. Lungă nr. 149, Ap. P3',
    addressLocality: 'Brașov',
    addressCountry: 'RO',
  },
  priceRange: '$',
};

// MobileApplication schema: declares the published Android app so Google can
// associate the brand entity with its Play listing (knowledge panel / app
// understanding). No aggregateRating yet — omitted on purpose rather than faked.
const appJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'MobileApplication',
  name: 'TriciGo',
  operatingSystem: 'ANDROID',
  applicationCategory: 'TravelApplication',
  url: 'https://play.google.com/store/apps/details?id=app.tricigo.client',
  installUrl: 'https://play.google.com/store/apps/details?id=app.tricigo.client',
  downloadUrl: 'https://play.google.com/store/apps/details?id=app.tricigo.client',
  description:
    'Pedí triciclos, motos y autos con TriciGo. Mirá el precio antes de viajar, en las ciudades donde estamos.',
  publisher: { '@type': 'Organization', name: 'TriciGo', url: 'https://tricigo.com' },
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'CUP' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={montserrat.variable}>
      <head>
        <JsonLd data={organizationJsonLd} />
        <JsonLd data={webSiteJsonLd} />
        <JsonLd data={localBusinessJsonLd} />
        <JsonLd data={appJsonLd} />
      </head>
      <body className="font-sans antialiased">
        {/* Demo-mode banner — fixed at top, only renders when
            NEXT_PUBLIC_DEMO_MODE=true. Mirrors the mobile DemoBanner. */}
        <DemoBanner />
        <I18nProvider>
          {/* Global "no connection" indicator (parity with the mobile
              OfflineBanner). Inside I18nProvider so it can use t(). */}
          <WebOfflineBanner />
          <WebHeader />
          {/* Suspense boundary so pages that read useSearchParams() (login,
              wallet, gift, corporate…) don't trigger the CSR-bailout build
              error now that the whole site is server-rendered. Pages that don't
              suspend (home, blog, transporte, legal) still render fully in the
              static HTML. */}
          <Suspense fallback={null}>{children}</Suspense>
          <WebFooter />
        </I18nProvider>
      </body>
    </html>
  );
}
