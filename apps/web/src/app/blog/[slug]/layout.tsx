import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Blog | TriciGo',
  description: 'Lee las últimas noticias y artículos sobre transporte en Cuba.',
  alternates: {
    canonical: 'https://tricigo.com/blog',
  },
};

export default function BlogPostLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
