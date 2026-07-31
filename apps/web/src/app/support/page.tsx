'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient, supportService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { SupportTicket, TicketCategory } from '@tricigo/types';

const STATUS_COLORS: Record<string, string> = {
  open: 'var(--info, #3B82F6)',
  in_progress: 'var(--warning, #F59E0B)',
  waiting_user: 'var(--warning, #F59E0B)',
  resolved: 'var(--success, #10B981)',
  closed: 'var(--text-tertiary, #6B7280)',
};

const CATEGORY_VALUES: TicketCategory[] = [
  'ride_issue',
  'payment_issue',
  'driver_complaint',
  'account_issue',
  'app_bug',
  'other',
];

export default function SupportPage() {
  const { t } = useTranslation('web');
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<TicketCategory>('ride_issue');
  const [submitting, setSubmitting] = useState(false);

  const STATUS_LABELS: Record<string, string> = {
    open: t('support.status_open', { defaultValue: 'Abierto' }),
    in_progress: t('support.status_in_progress', { defaultValue: 'En progreso' }),
    waiting_user: t('support.status_waiting_user', { defaultValue: 'Esperando respuesta' }),
    resolved: t('support.status_resolved', { defaultValue: 'Resuelto' }),
    closed: t('support.status_closed', { defaultValue: 'Cerrado' }),
  };

  const CATEGORY_LABELS: Record<TicketCategory, string> = {
    ride_issue: t('support.category_ride_issue', { defaultValue: 'Problema con viaje' }),
    payment_issue: t('support.category_payment_issue', { defaultValue: 'Pago / Facturación' }),
    driver_complaint: t('support.category_driver_complaint', { defaultValue: 'Queja sobre conductor' }),
    passenger_complaint: t('support.category_other', { defaultValue: 'Otro' }),
    account_issue: t('support.category_account_issue', { defaultValue: 'Mi cuenta' }),
    app_bug: t('support.category_app_bug', { defaultValue: 'Error en la app' }),
    feature_request: t('support.category_other', { defaultValue: 'Otro' }),
    other: t('support.category_other', { defaultValue: 'Otro' }),
  };

  const dateFormatter = new Intl.DateTimeFormat('es', {
    timeZone: 'America/Havana',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

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
    if (!userId) return;
    try {
      const data = await supportService.getUserTickets(userId);
      setTickets(data ?? []);
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
      await supportService.createTicket({
        user_id: userId,
        category,
        subject: subject.trim(),
        description: description.trim(),
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
        <p style={{ color: 'var(--text-secondary)' }}>{t('support.login_prompt', { defaultValue: 'Inicia sesión para ver tus tickets' })}</p>
        <Link href="/login?return=/support" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>{t('support.login_link', { defaultValue: 'Iniciar sesión' })}</Link>
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
            {t('support.title', { defaultValue: 'Soporte' })}
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
          {showForm ? t('support.cancel', { defaultValue: 'Cancelar' }) : t('support.new_ticket', { defaultValue: '+ Nuevo ticket' })}
        </button>
      </div>

      {/* Contacto directo — parity con el hub de contacto del /support móvil
          (WhatsApp + correo). El FAQ vive en /help. */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '2rem' }}>
        {/* Canonical support WhatsApp — the old value was the +53 5555 5555
            placeholder (invalid). Same target the mobile hubs use
            (apps/client/app/support.tsx). */}
        <a
          href="https://wa.me/5545998622511"
          target="_blank"
          rel="noopener noreferrer"
          style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, padding: '0.9rem 1rem', background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: '0.85rem', textDecoration: 'none', color: 'var(--text-primary)' }}
        >
          <span style={{ fontSize: '0.95rem', fontWeight: 700 }}>WhatsApp</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{t('support.contact_whatsapp_desc', { defaultValue: 'Chatea con nuestro equipo' })}</span>
        </a>
        <a
          href="mailto:soporte@tricigo.com?subject=Soporte%20TriciGo"
          style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, padding: '0.9rem 1rem', background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: '0.85rem', textDecoration: 'none', color: 'var(--text-primary)' }}
        >
          <span style={{ fontSize: '0.95rem', fontWeight: 700 }}>{t('support.contact_email_title', { defaultValue: 'Correo' })}</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>soporte@tricigo.com</span>
        </a>
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
              {t('support.category_label', { defaultValue: 'Categoría' })}
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as TicketCategory)}
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
              {CATEGORY_VALUES.map((value) => (
                <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>
              {t('support.subject_label', { defaultValue: 'Asunto' })}
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t('support.subject_placeholder', { defaultValue: 'Describe brevemente tu problema' })}
              required
              // Matches the mobile help screens (100) and stays under the
              // createTicketSchema ceiling (500), which createTicket now
              // enforces — the input must never be able to build a payload
              // the service will reject.
              maxLength={100}
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
              {t('support.description_label', { defaultValue: 'Descripción' })}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('support.description_placeholder', { defaultValue: 'Detalla tu problema con toda la información posible' })}
              required
              // createTicketSchema caps description at 5000; without this a
              // pasted wall of text would be rejected by validate() instead of
              // simply not fitting.
              maxLength={5000}
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
            {submitting ? t('support.submitting', { defaultValue: 'Enviando...' }) : t('support.submit', { defaultValue: 'Enviar ticket' })}
          </button>
        </form>
      )}

      {/* Ticket List */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', padding: '1.25rem' }}>
              <div style={{ width: '60%', height: 16, background: 'var(--border)', borderRadius: 4, marginBottom: '0.5rem', animation: 'pulse 1.5s ease-in-out infinite' }} />
              <div style={{ width: '40%', height: 12, background: 'var(--border)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out 0.2s infinite' }} />
            </div>
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" style={{ margin: '0 auto 1rem' }}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{t('support.empty_title', { defaultValue: 'No tienes tickets de soporte' })}</p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>{t('support.empty_desc', { defaultValue: 'Crea uno si necesitas ayuda' })}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {tickets.map((ticket) => (
            <Link
              key={ticket.id}
              href={`/support/${ticket.id}`}
              style={{
                display: 'block',
                background: 'var(--bg-card)',
                borderRadius: '1rem',
                border: '1px solid var(--border-light)',
                padding: '1.25rem',
                textDecoration: 'none',
                color: 'inherit',
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
                  {dateFormatter.format(new Date(ticket.created_at))}
                </span>
              </div>
              <p style={{ margin: 0, fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                {ticket.subject}
              </p>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
                {CATEGORY_LABELS[ticket.category] ?? CATEGORY_LABELS.other}
              </p>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
