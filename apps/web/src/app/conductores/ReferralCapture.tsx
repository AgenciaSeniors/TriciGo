'use client';

// Referral capture for the /conductores landing: ?ref=CODE
// 1. Stashes the code in sessionStorage under the SAME key the login page
//    and /refer/[code] use (tricigo_pending_referral) — if the candidate
//    creates a web account, the code applies automatically post-login.
// 2. Shows the code prominently with a copy button — most driver candidates
//    will register in the MOBILE app, where they must type the code in the
//    onboarding personal-info step (or Perfil → Referidos before approval).

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const PENDING_REFERRAL_KEY = 'tricigo_pending_referral';
const CODE_RE = /^[A-Za-z0-9]{4,20}$/;

export function ReferralCapture() {
  const searchParams = useSearchParams();
  const raw = searchParams.get('ref') ?? '';
  const code = useMemo(() => {
    const c = raw.trim().toUpperCase();
    return CODE_RE.test(c) ? c : '';
  }, [raw]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!code) return;
    try {
      sessionStorage.setItem(PENDING_REFERRAL_KEY, code);
    } catch {
      /* private mode — the visible code + copy button still work */
    }
  }, [code]);

  if (!code) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the code is visible to copy by hand */
    }
  };

  return (
    <div
      style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem',
        background: 'var(--bg-card)', border: '1px solid var(--primary)',
        borderRadius: '0.85rem', padding: '0.9rem 1.1rem', marginBottom: '1.5rem',
      }}
    >
      <span style={{ fontSize: '1.2rem' }}>🎁</span>
      <div style={{ flex: 1, minWidth: 220 }}>
        <p style={{ margin: 0, fontWeight: 700, fontSize: '0.92rem', color: 'var(--text-primary)' }}>
          Te invitaron con el código <span style={{ fontFamily: 'monospace', letterSpacing: '0.06em' }}>{code}</span>
        </p>
        <p style={{ margin: '0.15rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Ingrésalo en el registro de la app de conductor (paso de datos personales) para que
          quien te invitó reciba su bono.
        </p>
      </div>
      <button
        type="button"
        onClick={copy}
        style={{
          padding: '0.5rem 1rem', borderRadius: '0.6rem', border: '1px solid var(--primary)',
          background: copied ? 'var(--primary)' : 'transparent',
          color: copied ? '#fff' : 'var(--primary)', fontWeight: 700, fontSize: '0.85rem',
          cursor: 'pointer',
        }}
      >
        {copied ? '¡Copiado!' : 'Copiar código'}
      </button>
    </div>
  );
}
