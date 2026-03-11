import type { Metadata } from 'next';
import './globals.css';
import { I18nProvider } from './providers';
import { WebHeader } from './web-header';
import { WebFooter } from './web-footer';

export const metadata: Metadata = {
  title: {
    default: 'TriciGo — Pide tu viaje en La Habana',
    template: '%s | TriciGo',
  },
  description:
    'Solicita un viaje en La Habana con TriciGo. Triciclos, motos y autos al mejor precio. Rápido, seguro y confiable.',
  keywords: ['TriciGo', 'viaje', 'La Habana', 'Cuba', 'triciclo', 'transporte', 'taxi'],
  icons: { icon: '/favicon.ico' },
  openGraph: {
    type: 'website',
    locale: 'es_CU',
    url: 'https://tricigo.app',
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
  metadataBase: new URL('https://tricigo.app'),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
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
