'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { getSupabaseClient } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';

type ChatMessage = {
  id: string;
  ride_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  sender_role: 'rider' | 'driver';
};

export default function ChatPage() {
  const { rideId } = useParams<{ rideId: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [driverName, setDriverName] = useState('Conductor');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // BUG-011 fix: Auth guard
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!authLoading && !userId) router.replace('/login');
  }, [authLoading, userId, router]);

  const fetchMessages = useCallback(async () => {
    if (!rideId) return;
    try {
      const supabase = getSupabaseClient();
      const { data } = await supabase
        .from('chat_messages')
        .select('*')
        .eq('ride_id', rideId)
        .order('created_at', { ascending: true });
      setMessages((data as ChatMessage[]) ?? []);

      // Get driver name from ride
      const { data: ride } = await supabase
        .from('rides')
        .select('driver:driver_profiles(user:users(full_name))')
        .eq('id', rideId)
        .single();
      if (ride?.driver?.user?.full_name) {
        setDriverName(ride.driver.user.full_name);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [rideId]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // Realtime subscription
  useEffect(() => {
    if (!rideId) return;
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel(`chat:${rideId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'chat_messages',
        filter: `ride_id=eq.${rideId}`,
      }, (payload) => {
        setMessages((prev) => [...prev, payload.new as ChatMessage]);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [rideId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !userId || !rideId || sending) return;
    setSending(true);
    const content = text.trim();
    setText('');
    try {
      const supabase = getSupabaseClient();
      await supabase.from('chat_messages').insert({
        ride_id: rideId,
        sender_id: userId,
        content,
        sender_role: 'rider',
      });
    } catch {
      setText(content); // restore on error
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
                  }}
                >
                  <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.4 }}>{msg.content}</p>
                  <p style={{
                    margin: '0.25rem 0 0',
                    fontSize: '0.7rem',
                    opacity: 0.7,
                    textAlign: 'right',
                  }}>
                    {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

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
          onChange={(e) => setText(e.target.value)}
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
