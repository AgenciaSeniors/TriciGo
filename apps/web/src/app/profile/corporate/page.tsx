'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient, corporateService } from '@tricigo/api';
import type { CorporateAccount } from '@tricigo/types';

export default function CorporatePage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [accounts, setAccounts] = useState<CorporateAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!userId) return;
    corporateService.getMyAccounts(userId).then((data) => {
      setAccounts(data);
      setLoading(false);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : 'Error desconocido');
      setLoading(false);
    });
  }, [userId]);

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>Cargando...</p>
      </div>
    );
  }

  if (!userId) {
    router.replace('/login');
    return null;
  }

  const statusColor = (status: string) => {
    if (status === 'active') return { bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' };
    if (status === 'suspended') return { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' };
    return { bg: '#fffbeb', color: '#d97706', border: '#fde68a' };
  };

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>Cuentas corporativas</h1>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.75rem', padding: '1rem', marginBottom: '1.5rem' }}>
          <p style={{ color: '#c53030', margin: 0, fontSize: '0.9rem' }}>{error}</p>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: '2rem 0' }}>Cargando cuentas...</p>
      ) : accounts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem 1rem', background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--border)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
          <p style={{ color: 'var(--text-tertiary)', margin: '1rem 0 0', fontSize: '0.9rem' }}>
            No estas asociado a ninguna cuenta corporativa.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {accounts.map((acc) => {
            const sc = statusColor(acc.status);
            const budgetRemaining = acc.monthly_budget_trc - acc.current_month_spent;
            const budgetPercent = acc.monthly_budget_trc > 0
              ? Math.max(0, Math.min(100, (budgetRemaining / acc.monthly_budget_trc) * 100))
              : 0;

            return (
              <div key={acc.id} style={{
                background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', padding: '1.5rem',
              }}>
                {/* Name & Status */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                  <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{acc.name}</h2>
                  <span style={{
                    fontSize: '0.75rem', fontWeight: 600, padding: '0.2rem 0.6rem', borderRadius: '999px',
                    background: sc.bg, color: sc.color, border: `1px solid ${sc.border}`,
                  }}>
                    {(acc.status as string) === 'active' ? 'Activa' : (acc.status as string) === 'suspended' ? 'Suspendida' : acc.status}
                  </span>
                </div>

                {/* Contact */}
                <div style={{ marginBottom: '0.75rem' }}>
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>Contacto</p>
                  <p style={{ margin: '0.2rem 0 0', fontSize: '0.9rem', color: 'var(--text-primary)' }}>{acc.contact_phone}</p>
                  {acc.contact_email && (
                    <p style={{ margin: '0.15rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{acc.contact_email}</p>
                  )}
                </div>

                {/* Budget */}
                {acc.monthly_budget_trc > 0 && (
                  <div style={{ marginBottom: '0.75rem' }}>
                    <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>Presupuesto</p>
                    <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginTop: '0.4rem', background: 'var(--border-light)' }}>
                      <div style={{ width: `${budgetPercent}%`, background: 'var(--primary)', borderRadius: 3 }} />
                    </div>
                    <p style={{ margin: '0.3rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {budgetRemaining.toFixed(2)} / {acc.monthly_budget_trc.toFixed(2)} TRC restante
                    </p>
                  </div>
                )}

                {/* Per-ride cap */}
                {acc.per_ride_cap_trc > 0 && (
                  <div style={{ marginBottom: '0.75rem' }}>
                    <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>Maximo por viaje</p>
                    <p style={{ margin: '0.2rem 0 0', fontSize: '0.9rem', color: 'var(--text-primary)' }}>{acc.per_ride_cap_trc.toFixed(2)} TRC</p>
                  </div>
                )}

                {/* Allowed services */}
                {acc.allowed_service_types && acc.allowed_service_types.length > 0 && (
                  <div style={{ marginBottom: '0.75rem' }}>
                    <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>Servicios permitidos</p>
                    <p style={{ margin: '0.2rem 0 0', fontSize: '0.9rem', color: 'var(--text-primary)' }}>{acc.allowed_service_types.join(', ')}</p>
                  </div>
                )}

                {/* Allowed hours */}
                {acc.allowed_hours_start && acc.allowed_hours_end && (
                  <div>
                    <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>Horario permitido</p>
                    <p style={{ margin: '0.2rem 0 0', fontSize: '0.9rem', color: 'var(--text-primary)' }}>{acc.allowed_hours_start} - {acc.allowed_hours_end}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
