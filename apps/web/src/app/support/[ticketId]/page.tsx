'use client';

/**
 * Support ticket detail (web) — parity con apps/client/app/profile/ticket-detail.
 * Loads a ticket + its message thread (supportService) and lets the rider reply
 * until the ticket is resolved/closed. Reached from the /support ticket list.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { getSupabaseClient, supportService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { SupportTicket, TicketMessage } from '@tricigo/types';

const STATUS_LABELS: Record<string, string> = {
  open: 'Abierto',
  in_progress: 'En progreso',
  waiting_user: 'Esperando tu respuesta',
  resolved: 'Resuelto',
  closed: 'Cerrado',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'var(--info, #3B82F6)',
  in_progress: 'var(--warning, #F59E0B)',
  waiting_user: 'var(--warning, #F59E0B)',
  resolved: 'var(--success, #10B981)',
  closed: 'var(--text-tertiary, #6B7280)',
};

export default function TicketDetailPage() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const router = useRouter();
  const { t } = useTranslation();

  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!authLoading && !userId) router.replace('/login');
  }, [authLoading, userId, router]);

  const fetchData = useCallback(async () => {
    if (!ticketId) return;
    try {
      const [ticketData, messagesData] = await Promise.all([
        supportService.getTicket(ticketId),
        supportService.getMessages(ticketId),
      ]);
      setTicket(ticketData);
      setMessages(messagesData);
    } catch {
      /* silent — empty state covers it */
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    if (userId) fetchData();
  }, [userId, fetchData]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || !ticketId || !messageText.trim() || sending) return;
    setSending(true);
    const body = messageText.trim();
    setMessageText('');
    try {
      await supportService.sendMessage({ ticket_id: ticketId, sender_id: userId, message: body });
      await fetchData();
    } catch {
      setMessageText(body); // restore so the user can retry
    } finally {
      setSending(false);
    }
  }

  if (authLoading || !userId) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>Cargando...</p>
        </div>
      </div>
    );
  }

  const status = ticket?.status ?? 'open';
  const isClosed = status === 'closed' || status === 'resolved';

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1rem', borderBottom: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
        <Link href="/support" style={{ color: 'var(--text-primary)', textDecoration: 'none' }} aria-label="Volver a soporte">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: '1rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ticket?.subject ?? 'Ticket'}
          </h1>
          <span style={{ fontSize: '0.78rem', fontWeight: 600, color: STATUS_COLORS[status] ?? 'var(--text-tertiary)' }}>
            {STATUS_LABELS[status] ?? status}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {loading ? (
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', textAlign: 'center', padding: '2rem' }}>
            {t('common.loading', { defaultValue: 'Cargando...' })}
          </p>
        ) : (
          <>
            {/* Original ticket description as the first bubble */}
            {ticket?.description && (
              <div style={{ alignSelf: 'flex-end', maxWidth: '80%' }}>
                <div style={{ padding: '0.75rem 1rem', borderRadius: '1rem 1rem 0.25rem 1rem', background: 'var(--primary)', color: 'white' }}>
                  <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.4 }}>{ticket.description}</p>
                </div>
              </div>
            )}
            {messages.length === 0 && !ticket?.description ? (
              <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', textAlign: 'center', padding: '2rem' }}>
                {t('profile.ticket_no_messages', { defaultValue: 'Sin mensajes todavía.' })}
              </p>
            ) : (
              messages.map((m) => {
                const isOwn = m.sender_id === userId && !m.is_admin;
                return (
                  <div key={m.id} style={{ alignSelf: isOwn ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                    <div style={{
                      padding: '0.75rem 1rem',
                      borderRadius: isOwn ? '1rem 1rem 0.25rem 1rem' : '1rem 1rem 1rem 0.25rem',
                      background: isOwn ? 'var(--primary)' : m.is_admin ? 'rgba(59,130,246,0.12)' : 'var(--bg-card)',
                      color: isOwn ? 'white' : 'var(--text-primary)',
                      border: isOwn ? 'none' : '1px solid var(--border-light)',
                    }}>
                      {m.is_admin && (
                        <p style={{ margin: '0 0 0.2rem', fontSize: '0.7rem', fontWeight: 700, color: 'var(--info, #3B82F6)' }}>
                          {t('profile.support_label', { defaultValue: 'Soporte TriciGo' })}
                        </p>
                      )}
                      <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.4 }}>{m.message}</p>
                    </div>
                    <p style={{ margin: '0.2rem 0.25rem 0', fontSize: '0.7rem', color: 'var(--text-tertiary)', textAlign: isOwn ? 'right' : 'left' }}>
                      {new Date(m.created_at).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Havana' })}
                    </p>
                  </div>
                );
              })
            )}
          </>
        )}
        <div ref={endRef} />
      </div>

      {/* Reply input or closed notice */}
      {isClosed ? (
        <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border-light)', background: 'var(--bg-page)', textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-tertiary)' }}>
            {/* The key exists in common.json with a {{status}} placeholder —
                without passing the variable the literal "{{status}}" rendered. */}
            {t('profile.ticket_closed_message', { status: STATUS_LABELS[status]?.toLowerCase() ?? 'cerrado', defaultValue: `Este ticket está ${STATUS_LABELS[status]?.toLowerCase() ?? 'cerrado'}.` })}
          </p>
        </div>
      ) : (
        <form onSubmit={handleSend} style={{ display: 'flex', gap: '0.5rem', padding: '0.75rem 1rem', borderTop: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
          <input
            type="text"
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            placeholder={t('profile.ticket_message_placeholder', { defaultValue: 'Escribe un mensaje...' })}
            aria-label={t('type_message', { defaultValue: 'Escribe un mensaje' })}
            style={{ flex: 1, padding: '0.75rem 1rem', borderRadius: '1.5rem', border: '1px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' }}
          />
          <button
            type="submit"
            disabled={!messageText.trim() || sending}
            style={{ width: 44, height: 44, borderRadius: '50%', border: 'none', background: messageText.trim() ? 'var(--primary)' : 'var(--border)', color: 'white', cursor: messageText.trim() ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            aria-label="Enviar mensaje"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
          </button>
        </form>
      )}
    </main>
  );
}
