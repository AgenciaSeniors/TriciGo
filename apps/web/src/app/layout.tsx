import type { Metadata } from 'next';
import { Montserrat } from 'next/font/google';
import './globals.css';
import { I18nProvider } from './providers';
import { WebHeader } from './web-header';
import { WebFooter } from './web-footer';
import { JsonLd } from '../components/JsonLd';
import { DemoBanner } from '../components/DemoBanner';

const montserrat = Montserrat({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-montserrat',
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
    languages: {
      'es': 'https://tricigo.com',
      'en': 'https://tricigo.com',
    },
  },
};

const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'TriciGo',
  legalName: 'MACH DIGITAL TECH S.R.L.',
  url: 'https://tricigo.com',
  logo: 'https://tricigo.com/logo-wordmark.png',
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={montserrat.variable}>
      <head>
        <JsonLd data={organizationJsonLd} />
        <JsonLd data={localBusinessJsonLd} />
      </head>
      <body className="font-sans antialiased">
        {/* Demo-mode banner — fixed at top, only renders when
            NEXT_PUBLIC_DEMO_MODE=true. Mirrors the mobile DemoBanner. */}
        <DemoBanner />
        <I18nProvider>
          <WebHeader />
          {children}
          <WebFooter />
        </I18nProvider>
      </body>
    </html>
  );
}
