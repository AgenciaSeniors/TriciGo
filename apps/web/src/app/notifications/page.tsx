'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient, notificationService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { AppNotification } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

// Keyed by the real notification categories send-push writes to
// notifications.type (ride, ride_offer, announcement, blog, promo…) PLUS the
// legacy ride_update-style names, mirroring the mobile inbox icon map
// (apps/client/app/notifications/index.tsx buildIconMap). Unknown types
// still fall back to the bell below.
function getNotificationIcon(type: string) {
  switch (type) {
    case 'ride':
    case 'ride_offer':
    case 'ride_matching':
    case 'scheduled_ride':
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
    case 'proximity':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38a169" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
          <circle cx="9" cy="7" r="4" />
        </svg>
      );
    case 'payment':
    case 'wallet_recharge':
    case 'wallet_recharge_refund':
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
    case 'announcement':
    case 'campaign':
      // Megaphone — content category from admin announcements (Fase 4 #423).
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 11l18-5v12L3 14v-3z" />
          <path d="M11.6 16.8a3 3 0 11-5.8-1.6" />
        </svg>
      );
    case 'blog':
    case 'news':
      // Newspaper — blog/news content category.
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      );
    case 'chat':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      );
    case 'delivery':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
      );
    case 'sos':
    case 'dispute_update':
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
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

function useFormatTime(t: (key: string, options?: Record<string, unknown>) => string) {
  return (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('notifications.time_now');
    if (diffMins < 60) return t('notifications.time_mins_ago', { count: diffMins });
    if (diffHours < 24) return t('notifications.time_hours_ago', { count: diffHours });
    if (diffDays < 7) return t('notifications.time_days_ago', { count: diffDays });
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
}

/** Calendar day (YYYY-MM-DD) of a timestamp in Cuba time — server rows are
 *  UTC and grouping by the BROWSER's day shifted late-night notifications
 *  into the wrong "Hoy/Ayer" bucket for anyone outside Havana's timezone. */
function havanaDayKey(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Havana' });
}

function useFormatDateGroup(t: (key: string) => string) {
  return (dateStr: string) => {
    const date = new Date(dateStr);
    const now = Date.now();
    const todayKey = havanaDayKey(new Date(now));
    const yesterdayKey = havanaDayKey(new Date(now - 86400000));
    const notifKey = havanaDayKey(date);

    if (notifKey === todayKey) return t('notifications.date_today');
    if (notifKey === yesterdayKey) return t('notifications.date_yesterday');
    return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Havana' });
  };
}

export default function NotificationsPage() {
  const { t } = useTranslation('web');
  const router = useRouter();
  const formatTime = useFormatTime(t);
  const formatDateGroup = useFormatDateGroup(t);

  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Filter mirrors mobile (apps/client/app/notifications/index.tsx:51):
  // 'all' shows everything, 'unread' shows only unread = true.
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  // Infinite scroll state. PAGE_SIZE matches the mobile default of 20
  // (notification.service.ts:489) so both apps fetch the same shape.
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const PAGE_SIZE = 20;

  // Current list length for pagination. fetchNotifications is memoized on
  // [userId, t, filter] (NOT `notifications`), so reading notifications.length
  // from the closure always saw the INITIAL empty array → infinite scroll
  // requested offset=0 forever, duplicating page 1 and never reaching older
  // notifications. A ref reads the live length without re-memoizing.
  const notifCountRef = useRef(0);

  // Server-side unread count: the page badge counted only the LOADED rows
  // (filter over the 20-per-page array) and contradicted the header badge,
  // which already uses notificationService.getUnreadCount.
  const [serverUnread, setServerUnread] = useState(0);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  // Fetch a page. `reset=true` discards the current list (used when
  // toggling the filter or on first load); `reset=false` appends to
  // implement infinite scroll.
  const fetchNotifications = useCallback(async (reset: boolean = true) => {
    if (!userId) return;
    if (reset) {
      setLoading(true);
      setNotifications([]);
      notifCountRef.current = 0;
      setHasMore(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);
    try {
      const offset = reset ? 0 : notifCountRef.current;
      const data = await notificationService.getInboxNotifications(userId, {
        unreadOnly: filter === 'unread',
        limit: PAGE_SIZE,
        offset,
      });
      // Page exhausted when the API returned less than we asked for.
      setHasMore(data.length >= PAGE_SIZE);
      setNotifications((prev) => {
        // Dedupe: the realtime prepend can race a page fetch.
        const seen = new Set(reset ? [] : prev.map((n) => n.id));
        const fresh = data.filter((n) => !seen.has(n.id));
        const next = reset ? data : [...prev, ...fresh];
        notifCountRef.current = next.length;
        return next;
      });
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
      setError(t('notifications.error_loading'));
    } finally {
      if (reset) setLoading(false);
      else setLoadingMore(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, t, filter]);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !userId) router.replace('/login');
  }, [authLoading, userId, router]);

  // Re-fetch from page 1 whenever userId becomes available or the
  // filter changes — both invalidate the current list.
  useEffect(() => {
    if (userId) {
      fetchNotifications(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, filter]);

  // IntersectionObserver-based infinite scroll. When the sentinel div
  // (placed below the last group) enters the viewport, fetch the next
  // page. Mirrors the FlatList onEndReached pattern from mobile
  // (apps/client/app/notifications/index.tsx:132-139) but using the web
  // primitive that doesn't require a virtualised list to detect proximity
  // to the bottom.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || loading || loadingMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        fetchNotifications(false);
      }
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, fetchNotifications]);

  // Realtime subscription for new notifications
  useEffect(() => {
    if (!userId) return;

    const subscription = notificationService.subscribeToNotifications(
      userId,
      (newNotification: AppNotification) => {
        setNotifications((prev) => {
          if (prev.some((n) => n.id === newNotification.id)) return prev;
          const next = [newNotification, ...prev];
          notifCountRef.current = next.length;
          return next;
        });
        setServerUnread((c) => c + 1);
      },
    );

    return () => {
      subscription?.unsubscribe?.();
    };
  }, [userId]);

  // Server unread count, refreshed when the user/filter context changes.
  useEffect(() => {
    if (!userId) return;
    notificationService.getUnreadCount(userId).then(setServerUnread).catch(() => {});
  }, [userId, filter]);

  const handleMarkAllRead = async () => {
    if (!userId) return;
    try {
      await notificationService.markAllAsRead(userId);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setServerUnread(0);
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
      setServerUnread((c) => Math.max(0, c - 1));
    } catch {
      // Silently fail
    }
  };

  if (authLoading || !userId) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>Cargando...</p>
        </div>
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

  // Server-side total (matches the header badge), not just the loaded pages.
  const unreadCount = serverUnread;

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Link href="/" aria-label={t('notifications.back_home')} style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </Link>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
            {t('notifications.title')}
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
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--primary)',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t('notifications.mark_all_read')}
          </button>
        )}
      </div>

      {/* Filter chips — mirror mobile's all/unread toggle
          (apps/client/app/notifications/index.tsx:202-220). Tapping a
          chip resets the list and re-fetches with the new filter. */}
      <div role="tablist" aria-label={t('notifications.filter_label', { defaultValue: 'Filtrar notificaciones' })} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        {(['all', 'unread'] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={filter === option}
            onClick={() => setFilter(option)}
            style={{
              padding: '0.4rem 0.875rem',
              borderRadius: '999px',
              border: '1px solid var(--border)',
              background: filter === option ? 'var(--primary)' : 'var(--bg-page)',
              color: filter === option ? 'white' : 'var(--text-primary)',
              fontSize: '0.8rem',
              fontWeight: filter === option ? 600 : 500,
              cursor: 'pointer',
            }}
          >
            {option === 'all'
              ? t('notifications.filter_all', { defaultValue: 'Todas' })
              : t('notifications.filter_unread', { defaultValue: 'No leídas' })}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && <WebSkeletonList count={4} />}

      {/* Error */}
      {error && (
        <div style={{
          padding: '1rem',
          background: 'rgba(239,68,68,0.12)',
          borderRadius: '0.75rem',
          marginBottom: '1rem',
          textAlign: 'center',
        }}>
          <p style={{ color: '#e53e3e', fontSize: '0.9rem', margin: 0 }}>{error}</p>
          <button
            onClick={() => fetchNotifications(true)}
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
            {t('notifications.retry')}
          </button>
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && notifications.length === 0 && (
        <WebEmptyState
          icon="🔔"
          title={t('notifications.empty_title')}
          description={t('notifications.empty_description')}
        />
      )}

      {/* Notification Groups */}
      {!loading && !error && notifications.length > 0 && Object.entries(grouped).map(([dateLabel, items]) => (
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
                onClick={() => {
                  if (!notif.read) handleMarkRead(notif.id);
                  // Deep link parity with mobile handleTap (apps/client/app/
                  // notifications/index.tsx): ride_id wins, then wallet types
                  // → /wallet, content categories → their web surface.
                  const rid = notif.data && typeof (notif.data as Record<string, unknown>).ride_id === 'string'
                    ? (notif.data as Record<string, string>).ride_id
                    : null;
                  if (rid) {
                    router.push(`/rides/${rid}`);
                  } else if (['wallet', 'payment', 'wallet_recharge', 'wallet_recharge_refund', 'wallet_credit', 'wallet_debit'].includes(notif.type)) {
                    router.push('/wallet');
                  } else if (['blog', 'news'].includes(notif.type)) {
                    router.push('/blog');
                  } else if (['announcement', 'campaign', 'promo'].includes(notif.type)) {
                    // Campaigns render in the HomeDashboard inside /book.
                    router.push('/book');
                  }
                }}
                aria-label={notif.read ? notif.title : t('notifications.mark_read_aria', { title: notif.title })}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.75rem',
                  padding: '1rem 1.25rem',
                  width: '100%',
                  background: notif.read ? 'transparent' : 'var(--bg-accent, rgba(255,77,0,0.05))',
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

      {/* Infinite-scroll sentinel + loading-more indicator. The empty
          div is what the IntersectionObserver watches; when it scrolls
          into view (with a 200px rootMargin) we kick off the next page.
          The `hasMore` flag stops the loop once the API returns less
          than PAGE_SIZE. */}
      {!loading && !error && notifications.length > 0 && hasMore && (
        <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" />
      )}
      {loadingMore && (
        <div style={{ textAlign: 'center', padding: '0.75rem', color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>
          {t('notifications.loading_more', { defaultValue: 'Cargando más…' })}
        </div>
      )}
    </main>
  );
}
