import type { Metadata } from 'next';

// The /transporte coverage subtree (province + city + airport landing pages) is
// intentionally excluded from search engines and unlinked from the public nav,
// keeping the public marketing surface region-neutral. Next.js merges metadata
// per field, so this `robots` value is inherited by every nested page that does
// not set its own `robots` — the pages stay reachable by direct URL but are not
// indexed or surfaced to crawlers.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function TransporteLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
