import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Blog — TriciGo',
  description:
    'Noticias, consejos y actualizaciones sobre transporte en La Habana. Lee el blog de TriciGo.',
  alternates: {
    canonical: 'https://tricigo.com/blog',
  },
  openGraph: {
    title: 'Blog — TriciGo',
    description:
      'Noticias, consejos y actualizaciones sobre transporte en La Habana.',
    url: 'https://tricigo.com/blog',
  },
};

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return children;
}
