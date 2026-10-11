import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Server Component that carries the metadata of the team digest opt-out page (the page itself is
// a client component). The URL holds a personal token, so the page stays out of search engines and
// never sends its address as a Referer.
export const metadata: Metadata = {
  title: 'Resumen diario',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function TeamDigestUnsubscribeLayout({ children }: { children: ReactNode }) {
  return children;
}
