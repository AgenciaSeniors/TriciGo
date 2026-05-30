import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Política de Privacidad',
  description:
    'Conoce cómo TriciGo protege tus datos personales. Política de privacidad y tratamiento de datos.',
  alternates: {
    canonical: 'https://tricigo.com/privacy',
  },
  openGraph: {
    title: 'Política de Privacidad — TriciGo',
    description:
      'Conoce cómo TriciGo protege tus datos personales.',
    url: 'https://tricigo.com/privacy',
  },
};

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
