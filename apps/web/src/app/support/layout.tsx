import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Soporte',
  description: 'Centro de ayuda y soporte de TriciGo. Contacta con nuestro equipo para resolver cualquier problema con tu viaje.',
  openGraph: {
    title: 'Soporte — TriciGo',
    description: 'Centro de ayuda y soporte de TriciGo.',
  },
};

export default function SupportLayout({ children }: { children: React.ReactNode }) {
  return children;
}
