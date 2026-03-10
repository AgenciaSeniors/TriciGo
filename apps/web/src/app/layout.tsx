import type { Metadata } from 'next';
import './globals.css';
import { I18nProvider } from './providers';
import { WebHeader } from './web-header';
import { WebFooter } from './web-footer';

export const metadata: Metadata = {
  title: 'TriciGo — Pide tu viaje',
  description: 'Solicita un viaje en La Habana con TriciGo',
  icons: { icon: '/favicon.ico' },
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
