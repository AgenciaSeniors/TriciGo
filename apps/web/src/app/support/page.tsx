'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';

type Ticket = {
  id: string;
  subject: string;
  description: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  category: string;
  created_at: string;
  updated_at: string;
};

const STATUS_COLORS: Record<string, string> = {
  open: '#3B82F6',
  in_progress: '#F59E0B',
  resolved: '#10B981',
  closed: '#6B7280',
};

const STATUS_LABELS: Record<string, string> = {
  open: 'Abierto',
  in_progress: 'En progreso',
  resolved: 'Resuelto',
  closed: 'Cerrado',
};

const CATEGORIES = [
  { value: 'ride_issue', label: 'Problema con viaje' },
  { value: 'payment', label: 'Pago / Facturación' },
  { value: 'account', label: 'Mi cuenta' },
  { value: 'safety', label: 'Seguridad' },
  { value: 'other', label: 'Otro' },
];

export default function SupportPage() {
  const { t } = useTranslation();
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('ride_issue');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!userId) return;
    fetchTickets();
  }, [userId]);

  async function fetchTickets() {
    try {
      const supabase = getSupabaseClient();
      const { data } = await supabase
        .from('support_tickets')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      setTickets((data as Ticket[]) ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || !subject.trim() || !description.trim()) return;
    setSubmitting(true);
    try {
      const supabase = getSupabaseClient();
      await supabase.from('support_tickets').insert({
        user_id: userId,
        subject: subject.trim(),
        description: description.trim(),
        category,
        status: 'open',
      });
      setSubject('');
      setDescription('');
      setShowForm(false);
      fetchTickets();
    } catch {
      // silent
    } finally {
      setSubmitting(false);
    }
  }

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>{t('common.loading', { defaultValue: 'Cargando...' })}</p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Inicia sesión para ver tus tickets</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>Iniciar sesión</Link>
      </div>
    );
  }

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </Link>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
            {t('web.support', { defaultValue: 'Soporte' })}
          </h1>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '0.75rem',
            border: 'none',
            background: 'var(--primary)',
            color: 'white',
            fontWeight: 600,
            fontSize: '0.875rem',
            cursor: 'pointer',
          }}
        >
          {showForm ? 'Cancelar' : '+ Nuevo ticket'}
        </button>
      </div>

      {/* New Ticket Form */}
      {showForm && (
        <form onSubmit={handleSubmit} style={{
          background: 'var(--bg-card)',
          borderRadius: '1rem',
          border: '1px solid var(--border-light)',
          padding: '1.5rem',
          marginBottom: '2rem',
        }}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>
              Categoría
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{
                width: '100%',
                padding: '0.75rem',
                borderRadius: '0.5rem',
                border: '1px solid var(--border)',
                background: 'var(--bg-page)',
                color: 'var(--text-primary)',
                fontSize: '0.95rem',
              }}
            >
              {CATEGORIES.map((cat) => (
                <option key={cat.value} value={cat.value}>{cat.label}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>
              Asunto
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Describe brevemente tu problema"
              required
              style={{
                width: '100%',
                padding: '0.75rem',
                borderRadius: '0.5rem',
                border: '1px solid var(--border)',
                background: 'var(--bg-page)',
                color: 'var(--text-primary)',
                fontSize: '0.95rem',
              }}
            />
          </div>

          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>
              Descripción
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Detalla tu problema con toda la información posible"
              required
              rows={4}
              style={{
                width: '100%',
                padding: '0.75rem',
                borderRadius: '0.5rem',
                border: '1px solid var(--border)',
                background: 'var(--bg-page)',
                color: 'var(--text-primary)',
                fontSize: '0.95rem',
                resize: 'vertical',
              }}
            />
          </div>

          <button
            type="submit"
            disabled={submitting || !subject.trim() || !description.trim()}
            style={{
              width: '100%',
              padding: '0.875rem',
              borderRadius: '0.75rem',
              border: 'none',
              background: subject.trim() && description.trim() ? 'var(--primary)' : 'var(--border)',
              color: subject.trim() && description.trim() ? 'white' : 'var(--text-tertiary)',
              fontWeight: 600,
              fontSize: '0.95rem',
              cursor: subject.trim() && description.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            {submitting ? 'Enviando...' : 'Enviar ticket'}
          </button>
        </form>
      )}

      {/* Ticket List */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', padding: '1.25rem' }}>
              <div style={{ width: '60%', height: 16, background: 'var(--border)', borderRadius: 4, marginBottom: '0.5rem' }} />
              <div style={{ width: '40%', height: 12, background: 'var(--border)', borderRadius: 4 }} />
            </div>
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" style={{ margin: '0 auto 1rem' }}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>No tienes tickets de soporte</p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>Crea uno si necesitas ayuda</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {tickets.map((ticket) => (
            <div
              key={ticket.id}
              style={{
                background: 'var(--bg-card)',
                borderRadius: '1rem',
                border: '1px solid var(--border-light)',
                padding: '1.25rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    padding: '0.2rem 0.6rem',
                    borderRadius: '1rem',
                    background: `${STATUS_COLORS[ticket.status]}20`,
                    color: STATUS_COLORS[ticket.status],
                  }}
                >
                  {STATUS_LABELS[ticket.status] ?? ticket.status}
                </span>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                  {new Date(ticket.created_at).toLocaleDateString()}
                </span>
              </div>
              <p style={{ margin: 0, fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                {ticket.subject}
              </p>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
                {ticket.category === 'ride_issue' ? 'Viaje' : ticket.category === 'payment' ? 'Pago' : ticket.category === 'safety' ? 'Seguridad' : ticket.category === 'account' ? 'Cuenta' : 'Otro'}
              </p>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
