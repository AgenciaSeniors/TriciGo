import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Términos de Servicio',
  description: 'Términos y condiciones de uso de TriciGo. Lee nuestras políticas antes de usar el servicio de transporte.',
  openGraph: {
    title: 'Términos de Servicio — TriciGo',
    description: 'Términos y condiciones de uso de TriciGo.',
  },
};

export default function TermsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
