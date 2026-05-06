import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Blog | TriciGo',
  description: 'Lee las últimas noticias y artículos sobre movilidad urbana y transporte.',
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
