import type { Metadata } from 'next';
import './globals.css';
import { I18nProvider } from './providers';
import { WebHeader } from './web-header';
import { WebFooter } from './web-footer';
import { JsonLd } from '../components/JsonLd';

export const metadata: Metadata = {
  title: {
    default: 'TriciGo — Taxi en La Habana | Pide triciclos, motos y autos',
    template: '%s | TriciGo',
  },
  description:
    'Pide un taxi en La Habana con TriciGo. Triciclos, motos y autos disponibles 24/7. La app de transporte #1 en Cuba. Descarga gratis.',
  keywords: ['taxi La Habana', 'transporte Cuba', 'triciclo taxi', 'pedir taxi Cuba', 'TriciGo', 'ride hailing Havana', 'taxi app Cuba', 'triciclo La Habana'],
  icons: { icon: '/favicon.ico' },
  openGraph: {
    type: 'website',
    locale: 'es_CU',
    url: 'https://tricigo.com',
    siteName: 'TriciGo',
    title: 'TriciGo — Pide tu viaje en La Habana',
    description:
      'Solicita un viaje en La Habana con TriciGo. Triciclos, motos y autos al mejor precio.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TriciGo — Pide tu viaje en La Habana',
    description:
      'Solicita un viaje en La Habana con TriciGo. Rápido, seguro y al mejor precio.',
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
  url: 'https://tricigo.com',
  logo: 'https://tricigo.com/logo.png',
  description:
    'Plataforma de transporte en La Habana. Solicita triciclos, motos y autos de forma rapida y segura.',
  address: {
    '@type': 'PostalAddress',
    addressLocality: 'La Habana',
    addressCountry: 'CU',
  },
  contactPoint: {
    '@type': 'ContactPoint',
    email: 'soporte@tricigo.app',
    contactType: 'customer service',
    availableLanguage: ['Spanish', 'English'],
  },
};

const localBusinessJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'LocalBusiness',
  name: 'TriciGo',
  url: 'https://tricigo.com',
  description:
    'Servicio de transporte bajo demanda en La Habana, Cuba. Triciclos, motos y autos.',
  address: {
    '@type': 'PostalAddress',
    addressLocality: 'La Habana',
    addressCountry: 'CU',
  },
  geo: {
    '@type': 'GeoCoordinates',
    latitude: 23.1136,
    longitude: -82.3666,
  },
  priceRange: '$',
  areaServed: {
    '@type': 'City',
    name: 'La Habana',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        <JsonLd data={organizationJsonLd} />
        <JsonLd data={localBusinessJsonLd} />
      </head>
      <body className="font-sans antialiased bg-white text-neutral-900">
        <I18nProvider>
          <WebHeader />
          {children}
          <WebFooter />
        </I18nProvider>
      </body>
    </html>
  );
}
