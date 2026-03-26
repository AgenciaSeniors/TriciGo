import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Politica de Privacidad — TriciGo',
  description:
    'Conoce como TriciGo protege tus datos personales. Politica de privacidad y tratamiento de datos.',
  alternates: {
    canonical: 'https://tricigo.com/privacy',
  },
  openGraph: {
    title: 'Politica de Privacidad — TriciGo',
    description:
      'Conoce como TriciGo protege tus datos personales.',
    url: 'https://tricigo.com/privacy',
  },
};

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
