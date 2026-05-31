'use client';

/**
 * Gift deep-link landing (web) — parity con apps/client/app/gift/[code].
 * The code identifies the *recipient* (NOT a referral redemption): resolve it
 * by sending the user to the send-gift screen with the code pre-loaded.
 */
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function GiftCodeLanding() {
  const params = useParams();
  const router = useRouter();
  const code = params.code as string;

  useEffect(() => {
    router.replace(code ? `/wallet/gift?code=${encodeURIComponent(code)}` : '/wallet/gift');
  }, [code, router]);

  return (
    <main style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
        <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
          Trici<span style={{ color: 'var(--primary)' }}>Go</span>
        </div>
        <p style={{ fontSize: '0.875rem' }}>Abriendo regalo…</p>
      </div>
    </main>
  );
}
