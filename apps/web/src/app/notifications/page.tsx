'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { getSupabaseClient, notificationService } from '@tricigo/api';
import type { AppNotification } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

function getNotificationIcon(type: string) {
  switch (type) {
    case 'ride_update':
    case 'ride_completed':
    case 'ride_canceled':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case 'driver_assigned':
    case 'driver_arriving':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38a169" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
          <circle cx="9" cy="7" r="4" />
        </svg>
      );
    case 'wallet_credit':
    case 'wallet_debit':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d69e2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="1" x2="12" y2="23" />
          <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
        </svg>
      );
    case 'promo':
    case 'referral_reward':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e53e3e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 12 20 22 4 22 4 12" />
          <rect x="2" y="7" width="20" height="5" />
          <line x1="12" y1="22" x2="12" y2="7" />
          <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z" />
          <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" />
        </svg>
      );
    default:
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#718096" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
      );
  }
}

function formatTime(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Ahora';
  if (diffMins < 60) return `Hace ${diffMins} min`;
  if (diffHours < 24) return `Hace ${diffHours}h`;
  if (diffDays < 7) return `Hace ${diffDays}d`;
  return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

function formatDateGroup(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const notifDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (notifDate.getTime() === today.getTime()) return 'Hoy';
  if (notifDate.getTime() === yesterday.getTime()) return 'Ayer';
  return date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

export default function NotificationsPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
  }, []);

  const fetchNotifications = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await notificationService.getInboxNotifications(userId, { limit: 50 });
      setNotifications(data);
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
      setError('Error al cargar notificaciones');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) {
      fetchNotifications();
    }
  }, [userId, fetchNotifications]);

  const handleMarkAllRead = async () => {
    if (!userId) return;
    try {
      await notificationService.markAllAsRead(userId);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch {
      // Silently fail
    }
  };

  const handleMarkRead = async (notificationId: string) => {
    try {
      await notificationService.markAsRead(notificationId);
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, read: true } : n)),
      );
    } catch {
      // Silently fail
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
        <p style={{ color: 'var(--text-secondary)' }}>Inicia sesion para ver tus notificaciones</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          Iniciar sesion
        </Link>
      </div>
    );
  }

  // Group notifications by date
  const grouped: Record<string, AppNotification[]> = {};
  for (const notif of notifications) {
    const key = formatDateGroup(notif.created_at);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(notif);
  }

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Link href="/" aria-label="Volver al inicio" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </Link>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
            Notificaciones
            {unreadCount > 0 && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginLeft: '0.5rem',
                minWidth: 22,
                height: 22,
                borderRadius: 11,
                background: 'var(--primary)',
                color: '#fff',
                fontSize: '0.7rem',
                fontWeight: 700,
                padding: '0 6px',
              }}>
                {unreadCount}
              </span>
            )}
          </h1>
        </div>
        {unreadCount > 0 && (
          <button
            onClick={handleMarkAllRead}
            aria-label="Marcar todas las notificaciones como leidas"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--primary)',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Marcar todas leidas
          </button>
        )}
      </div>

      {/* Loading */}
      {loading && <WebSkeletonList count={4} />}

      {/* Error */}
      {error && (
        <div style={{
          padding: '1rem',
          background: '#fef2f2',
          borderRadius: '0.75rem',
          marginBottom: '1rem',
          textAlign: 'center',
        }}>
          <p style={{ color: '#e53e3e', fontSize: '0.9rem', margin: 0 }}>{error}</p>
          <button
            onClick={fetchNotifications}
            style={{
              marginTop: '0.5rem',
              background: 'none',
              border: 'none',
              color: 'var(--primary)',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && notifications.length === 0 && (
        <WebEmptyState
          icon="🔔"
          title="No tienes notificaciones"
          description="Aqui veras las actualizaciones de tus viajes y promociones."
        />
      )}

      {/* Notification Groups */}
      {!loading && !error && Object.entries(grouped).map(([dateLabel, items]) => (
        <div key={dateLabel} style={{ marginBottom: '1.5rem' }}>
          <h2 style={{
            fontSize: '0.8rem',
            fontWeight: 600,
            color: 'var(--text-tertiary)',
            textTransform: 'capitalize',
            marginBottom: '0.5rem',
          }}>
            {dateLabel}
          </h2>
          <div style={{
            background: 'var(--bg-card)',
            borderRadius: '1rem',
            border: '1px solid var(--border-light)',
            overflow: 'hidden',
          }}>
            {items.map((notif, index) => (
              <button
                key={notif.id}
                onClick={() => !notif.read && handleMarkRead(notif.id)}
                aria-label={`${notif.read ? '' : 'Marcar como leida: '}${notif.title}`}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.75rem',
                  padding: '1rem 1.25rem',
                  width: '100%',
                  background: notif.read ? 'transparent' : '#fffbf0',
                  border: 'none',
                  borderBottom: index < items.length - 1 ? '1px solid var(--border-light)' : 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: 'var(--bg-hover)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {getNotificationIcon(notif.type)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                    <p style={{
                      margin: 0,
                      fontSize: '0.9rem',
                      fontWeight: notif.read ? 500 : 700,
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {notif.title}
                    </p>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {formatTime(notif.created_at)}
                    </span>
                  </div>
                  <p style={{
                    margin: '0.2rem 0 0',
                    fontSize: '0.85rem',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}>
                    {notif.body}
                  </p>
                </div>
                {!notif.read && (
                  <div style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'var(--primary)',
                    flexShrink: 0,
                    marginTop: '0.4rem',
                  }} />
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </main>
  );
}
