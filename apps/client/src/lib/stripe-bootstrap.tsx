// ============================================================
// TriciGo — StripeBootstrap (deprecated pass-through)
//
// Stripe was retired on 2026-05-20 (see PROGRESS.md). NETOPIA is
// now the sole payment provider, and its hosted-payment-page flow
// does not need a native SDK provider on mobile — the mobile
// wallet opens https://tricigo.com/wallet in the browser, where
// the redirect-based NETOPIA flow runs.
//
// This component is kept as a no-op for one release so `_layout.tsx`
// can continue to wrap children with `<StripeBootstrap>` without an
// import-removal commit. A follow-up cleanup PR drops both the
// wrapper and this file.
// ============================================================

import React from 'react';

export function StripeBootstrap({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
