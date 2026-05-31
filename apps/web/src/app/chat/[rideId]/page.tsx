'use client';

/**
 * In-ride chat page (web).
 *
 * Refactored to use the shared `useChat()` hook which:
 *   - Reads from the correct `ride_messages` table (the previous
 *     implementation was reading from `chat_messages`, which doesn't
 *     exist in the database — chat was effectively broken on web).
 *   - Adds polling fallback every 8s for when Supabase realtime drops.
 *   - Adds typing indicators (broadcast).
 *   - Adds an offline outgoing queue persisted to localStorage that
 *     drains automatically on `online` event.
 *
 * Mirrors mobile `apps/client/app/chat/[rideId].tsx`.
 */
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { getSupabaseClient } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { getQuickRepliesForRole } from '@tricigo/utils';
import { useChat } from '@/hooks/useChat';

const MAX_CHARS = 500;
const CHAR_WARN = 400;

export default function ChatPage() {
  const { rideId } = useParams<{ rideId: string }>();
  const router = useRouter();
  const { t } = useTranslation();

  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [driverName, setDriverName] = useState('Conductor');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  // Connectivity banner (parity con el banner offline del chat móvil).
  useEffect(() => {
    setIsOnline(navigator.onLine);
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const quickReplies = getQuickRepliesForRole('rider');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auth guard
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!authLoading && !userId) router.replace('/login');
  }, [authLoading, userId, router]);

  // Driver name lookup (one-shot, from the rides + driver_profiles + users join)
  useEffect(() => {
    if (!rideId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data: rideRaw } = await getSupabaseClient()
          .from('rides')
          .select('driver:driver_profiles(user:users(full_name))')
          .eq('id', rideId)
          .single();
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ride = rideRaw as any;
        if (ride?.driver?.user?.full_name) setDriverName(ride.driver.user.full_name);
      } catch {
        /* fallback to default driverName */
      }
    })();
    return () => { cancelled = true; };
  }, [rideId]);

  const { messages, loading, remoteTyping, sendMessage, notifyTyping } = useChat(rideId, userId);

  // Auto-scroll to bottom on new messages OR typing toggle
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, remoteTyping]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !userId || !rideId || sending) return;
    setSending(true);
    const content = text.trim().slice(0, MAX_CHARS);
    setText('');
    try {
      await sendMessage(content);
    } finally {
      setSending(false);
    }
  }

  const QUICK_REPLY_DEFAULTS: Record<string, string> = {
    five_more_min: '5 minutos más',
    on_my_way: 'Voy en camino',
    wait_please: 'Espérame por favor',
    thank_you: '¡Gracias!',
  };

  async function sendQuick(key: string) {
    if (!userId || !rideId || sending) return;
    const body = t('chat.quick_' + key, { defaultValue: QUICK_REPLY_DEFAULTS[key] ?? key });
    setSending(true);
    try {
      await sendMessage(body);
    } finally {
      setSending(false);
    }
  }

  // Auth gate — redirect handled in useEffect, show loading meanwhile
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

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '1rem',
        borderBottom: '1px solid var(--border-light)',
        background: 'var(--bg-card)',
      }}>
        <Link href="/rides" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <div>
          <h1 style={{ fontSize: '1rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>{driverName}</h1>
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
            {t('web.chat_ride', { defaultValue: 'Chat del viaje' })}
          </p>
        </div>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3rem', gap: '0.75rem' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
            </svg>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>
              {t('web.loading_messages', { defaultValue: 'Cargando mensajes...' })}
            </p>
          </div>
        ) : messages.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>
              {t('web.no_messages', { defaultValue: 'No hay mensajes aún. Envía el primero.' })}
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMine = msg.sender_id === userId;
            const isPending = !!msg._pending;
            return (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  justifyContent: isMine ? 'flex-end' : 'flex-start',
                }}
              >
                <div
                  style={{
                    maxWidth: '70%',
                    padding: '0.75rem 1rem',
                    borderRadius: isMine ? '1rem 1rem 0.25rem 1rem' : '1rem 1rem 1rem 0.25rem',
                    background: isMine ? 'var(--primary)' : 'var(--bg-card)',
                    color: isMine ? 'white' : 'var(--text-primary)',
                    border: isMine ? 'none' : '1px solid var(--border-light)',
                    opacity: isPending ? 0.6 : 1,
                  }}
                >
                  <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.4 }}>{msg.body}</p>
                  <p style={{
                    margin: '0.25rem 0 0',
                    fontSize: '0.7rem',
                    opacity: 0.7,
                    textAlign: 'right',
                  }}>
                    {isPending
                      ? t('web.message_pending', { defaultValue: 'Pendiente · sin red' })
                      : new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            );
          })
        )}

        {/* Typing indicator (the other party) — only visible when actively typing */}
        {remoteTyping && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div
              style={{
                padding: '0.5rem 0.875rem',
                borderRadius: '1rem 1rem 1rem 0.25rem',
                background: 'var(--bg-card)',
                color: 'var(--text-tertiary)',
                border: '1px solid var(--border-light)',
                fontSize: '0.875rem',
                fontStyle: 'italic',
              }}
              aria-live="polite"
            >
              {t('web.typing', { defaultValue: 'escribiendo…' })}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Offline banner — honest about manual retry (parity con chat móvil) */}
      {!isOnline && (
        <div style={{ padding: '0.5rem 1rem', background: 'rgba(245,158,11,0.12)', color: '#b45309', fontSize: '0.8rem', textAlign: 'center', borderTop: '1px solid rgba(245,158,11,0.3)' }}>
          {t('web.chat_offline', { defaultValue: 'Sin conexión — los mensajes se enviarán al reconectar.' })}
        </div>
      )}

      {/* Quick replies — visible cuando el input está vacío */}
      {!text.trim() && quickReplies.length > 0 && (
        <div style={{ display: 'flex', gap: '0.4rem', padding: '0.5rem 1rem 0', overflowX: 'auto', background: 'var(--bg-card)' }}>
          {quickReplies.map((qr) => (
            <button
              key={qr.key}
              type="button"
              disabled={sending}
              onClick={() => sendQuick(qr.key)}
              style={{
                whiteSpace: 'nowrap', padding: '0.4rem 0.8rem', borderRadius: '999px',
                border: '1px solid var(--border)', background: 'var(--bg-page)',
                color: 'var(--text-secondary)', fontSize: '0.8rem', cursor: sending ? 'not-allowed' : 'pointer', flexShrink: 0,
              }}
            >
              {t('chat.quick_' + qr.key, { defaultValue: QUICK_REPLY_DEFAULTS[qr.key] ?? qr.key })}
            </button>
          ))}
        </div>
      )}

      {/* Char counter — near limit */}
      {text.length >= CHAR_WARN && (
        <div style={{ padding: '0.25rem 1rem 0', textAlign: 'right', fontSize: '0.7rem', color: text.length >= MAX_CHARS ? 'var(--error, #dc2626)' : 'var(--text-tertiary)', background: 'var(--bg-card)' }}>
          {text.length}/{MAX_CHARS}
        </div>
      )}

      {/* Input */}
      <form
        onSubmit={handleSend}
        style={{
          display: 'flex',
          gap: '0.5rem',
          padding: '0.75rem 1rem',
          borderTop: '1px solid var(--border-light)',
          background: 'var(--bg-card)',
        }}
      >
        <input
          type="text"
          value={text}
          maxLength={MAX_CHARS}
          onChange={(e) => {
            setText(e.target.value.slice(0, MAX_CHARS));
            // Notify typing on every keystroke; the hook debounces
            // broadcasts to once every 2s so we don't spam the channel.
            notifyTyping();
          }}
          placeholder={t('web.type_message', { defaultValue: 'Escribe un mensaje...' })}
          style={{
            flex: 1,
            padding: '0.75rem 1rem',
            borderRadius: '1.5rem',
            border: '1px solid var(--border)',
            background: 'var(--bg-page)',
            color: 'var(--text-primary)',
            fontSize: '0.9rem',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={!text.trim() || sending}
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            border: 'none',
            background: text.trim() ? 'var(--primary)' : 'var(--border)',
            color: 'white',
            cursor: text.trim() ? 'pointer' : 'not-allowed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>
    </main>
  );
}
