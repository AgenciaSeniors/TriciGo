'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient } from '@tricigo/api';

export default function ReferralPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [copied]);

  const referralCode = userId ? userId.substring(0, 8).toUpperCase() : '';
  const shareLink = `https://tricigo.com/refer/${referralCode}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
    } catch {
      // Fallback
      const input = document.createElement('input');
      input.value = shareLink;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
    }
  };

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>Cargando...</p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Inicia sesion para ver tu codigo de referido</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          Iniciar sesion
        </Link>
      </div>
    );
  }

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>Programa de referidos</h1>
      </div>

      {/* Promo Banner */}
      <div style={{
        background: 'linear-gradient(135deg, var(--primary), #ff8c00)',
        borderRadius: '1rem',
        padding: '2rem 1.5rem',
        color: '#fff',
        textAlign: 'center',
        marginBottom: '2rem',
      }}>
        <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
          </svg>
        </div>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.5rem' }}>
          Invita amigos y gana TriciCoins
        </h2>
        <p style={{ fontSize: '0.9rem', opacity: 0.9, margin: 0 }}>
          Comparte tu codigo y ambos reciben 500 CUP en TriciCoins cuando tu amigo complete su primer viaje.
        </p>
      </div>

      {/* Referral Code */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          Tu codigo de referido
        </h2>
        <div style={{
          background: 'var(--bg-page)',
          borderRadius: '0.75rem',
          padding: '1.25rem',
          textAlign: 'center',
          border: '2px dashed var(--border)',
        }}>
          <p style={{
            fontSize: '1.75rem',
            fontWeight: 800,
            letterSpacing: '0.15em',
            color: 'var(--primary)',
            margin: 0,
            fontFamily: 'monospace',
          }}>
            {referralCode}
          </p>
        </div>
      </div>

      {/* Share Link */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          Enlace para compartir
        </h2>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
        }}>
          <div style={{
            flex: 1,
            padding: '0.75rem 1rem',
            background: 'var(--bg-page)',
            borderRadius: '0.75rem',
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {shareLink}
          </div>
          <button
            onClick={handleCopy}
            style={{
              padding: '0.75rem 1.25rem',
              background: copied ? 'var(--success)' : 'var(--primary)',
              color: '#fff',
              border: 'none',
              borderRadius: '0.75rem',
              fontSize: '0.9rem',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'background 0.2s',
            }}
          >
            {copied ? 'Copiado!' : 'Copiar'}
          </button>
        </div>
      </div>

      {/* How it works */}
      <div style={{
        background: 'var(--bg-card)',
        borderRadius: '1rem',
        border: '1px solid var(--border-light)',
        padding: '1.5rem',
      }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 1rem', color: 'var(--text-primary)' }}>
          Como funciona
        </h2>
        {[
          { num: '1', text: 'Comparte tu codigo o enlace con un amigo' },
          { num: '2', text: 'Tu amigo se registra y hace su primer viaje' },
          { num: '3', text: 'Ambos reciben 500 CUP en TriciCoins' },
        ].map((step) => (
          <div key={step.num} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            marginBottom: step.num === '3' ? 0 : '1rem',
          }}>
            <div style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'var(--primary)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: '0.85rem',
              flexShrink: 0,
            }}>
              {step.num}
            </div>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{step.text}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
