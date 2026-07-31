import type { Metadata } from 'next';

/**
 * The /v subtree is the business-facing counter surface. Every page that can
 * actually validate anything is addressed by a business's SECRET token
 * (/v/<token>), so this subtree must never be indexed: a crawled token is a
 * leaked token, and whoever holds it can spend a stranger's coupon and pin
 * that shop's rate-limit bucket.
 *
 * Same treatment /transporte and /uber-cuba already get, and for a stronger
 * reason. robots.ts only disallows /api/ and /login, so the noindex has to be
 * declared here.
 */
export const metadata: Metadata = {
  // Bare, no brand suffix: the root layout's template is '%s | TriciGo', so
  // spelling TriciGo out here would render "… — TriciGo | TriciGo".
  title: 'Validar cupón',
  description: 'Valida los cupones TriciGo de tus clientes.',
  robots: { index: false, follow: false },
};

export default function ValidationLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
