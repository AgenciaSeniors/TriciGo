import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TriciGo — Pide tu viaje',
  description: 'Solicita un viaje en La Habana con TriciGo',
  icons: { icon: '/favicon.ico' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="font-sans antialiased bg-white text-neutral-900">
        {children}
      </body>
    </html>
  );
}
