import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Seguimiento de viaje — TriciGo',
  description: 'Sigue el recorrido de tu viaje en tiempo real con TriciGo.',
  openGraph: {
    title: 'Seguimiento de viaje — TriciGo',
    description: 'Sigue el recorrido de tu viaje en tiempo real.',
    siteName: 'TriciGo',
    type: 'website',
    locale: 'es_ES',
  },
  twitter: {
    card: 'summary',
    title: 'Seguimiento de viaje — TriciGo',
    description: 'Sigue el recorrido de tu viaje en tiempo real con TriciGo.',
  },
};

export default function SharedTrackingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
