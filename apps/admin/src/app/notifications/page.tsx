'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { notificationService } from '@tricigo/api';
import { adminService } from '@tricigo/api';
import { getSupabaseClient } from '@tricigo/api';
import type { User, AppNotification } from '@tricigo/types';
import { formatAdminDate } from '@/lib/formatDate';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { useSortableTable } from '@/hooks/useSortableTable';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';

type NotificationLog = {
  id: string;
  title: string;
  body: string;
  target_type: string;
  target_user_id: string | null;
  sent_by: string;
  sent_count: number;
  created_at: string;
};

const TARGET_LABELS: Record<string, { es: string; en: string }> = {
  all: { es: 'Todos', en: 'Everyone' },
  customers: { es: 'Pasajeros', en: 'Riders' },
  drivers: { es: 'Conductores', en: 'Drivers' },
  user: { es: 'Usuario específico', en: 'Specific user' },
};

export default function NotificationsPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [error, setError] = useState<string | null>(null);

  // Compose form state
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [targetType, setTargetType] = useState<'all' | 'customers' | 'drivers' | 'user'>('all');
  const [targetUserId, setTargetUserId] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [userResults, setUserResults] = useState<User[]>([]);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ success: number; error: number } | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  function validateNotificationForm() {
    const errors: Record<string, string> = {};
    if (!title.trim()) errors.title = 'Campo requerido';
    if (!body.trim()) errors.body = 'Campo requerido';
    if (targetType === 'user' && !targetUserId) errors.target = 'Debe seleccionar un usuario';
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  // History state
  const [history, setHistory] = useState<NotificationLog[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const { sortedData: sortedHistory, toggleSort, sortKey, sortDirection } = useSortableTable(history, 'created_at');

  // Inbox stats state
  const [inboxStats, setInboxStats] = useState<{
    totalToday: number;
    totalUnread: number;
    byType: Record<string, number>;
    recent: AppNotification[];
  } | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    loadHistory();
    loadInboxStats();
  }, []);

  const loadHistory = async () => {
    try {
      const data = await notificationService.getNotificationHistory(0, 50);
      setHistory(data);
    } catch (err) {
      console.error('Error loading notification history:', err);
      setError(err instanceof Error ? err.message : 'Error al cargar historial');
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadInboxStats = async () => {
    setStatsLoading(true);
    try {
      const supabase = getSupabaseClient();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // Parallel queries: total today, total unread, by type, recent
      const [todayRes, unreadRes, typeRes, recentRes] = await Promise.all([
        supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', todayStart.toISOString()),
        supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('read', false),
        supabase
          .from('notifications')
          .select('type')
          .gte('created_at', todayStart.toISOString()),
        supabase
          .from('notifications')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      const byType: Record<string, number> = {};
      if (typeRes.data) {
        for (const row of typeRes.data) {
          byType[row.type] = (byType[row.type] || 0) + 1;
        }
      }

      setInboxStats({
        totalToday: todayRes.count ?? 0,
        totalUnread: unreadRes.count ?? 0,
        byType,
        recent: (recentRes.data ?? []) as AppNotification[],
      });
    } catch (err) {
      console.error('Error loading inbox stats:', err);
    } finally {
      setStatsLoading(false);
    }
  };

  const handleUserSearch = async (query: string) => {
    setUserSearch(query);
    if (query.length < 2) {
      setUserResults([]);
      return;
    }
    try {
      const users = await adminService.getUsers(0, 10);
      setUserResults(
        users.filter(
          (u) =>
            u.full_name?.toLowerCase().includes(query.toLowerCase()) ||
            u.phone?.includes(query) ||
            u.email?.toLowerCase().includes(query.toLowerCase()),
        ),
      );
    } catch {
      setUserResults([]);
    }
  };

  const handleSend = async () => {
    if (!validateNotificationForm()) return;

    setSending(true);
    setSendResult(null);

    try {
      let result: { successCount: number; errorCount: number };

      if (targetType === 'user') {
        result = await notificationService.sendToUser(
          targetUserId,
          title,
          body,
          'admin', // Will be replaced with actual admin ID in production
        );
      } else {
        result = await notificationService.broadcastPush(
          title,
          body,
          targetType,
          'admin',
        );
      }

      setSendResult({ success: result.successCount, error: result.errorCount });
      setTitle('');
      setBody('');
      setTargetUserId('');
      setUserSearch('');
      setFormErrors({});
      loadHistory();
    } catch (err) {
      console.error('Error sending notification:', err);
      showToast('error', 'Error al enviar notificación');
      setSendResult({ success: 0, error: -1 });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-4xl">
      <h1 className="text-3xl font-bold mb-8">{t('notifications.title')}</h1>

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); loadHistory(); loadInboxStats(); }}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Compose Form */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
        <h2 className="text-lg font-bold mb-4">{t('notifications.compose')}</h2>

        <div className="space-y-4">
          {/* Target audience */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              {t('notifications.audience')}<span className="text-red-500 ml-1">*</span>
            </label>
            <select
              value={targetType}
              onChange={(e) => {
                setTargetType(e.target.value as typeof targetType);
                setTargetUserId('');
                setUserSearch('');
                setFormErrors((prev) => { const { target, ...rest } = prev; return rest; });
              }}
              className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
            >
              <option value="all">{t('notifications.audience_all')}</option>
              <option value="customers">{t('notifications.audience_riders')}</option>
              <option value="drivers">{t('notifications.audience_drivers')}</option>
              <option value="user">{t('notifications.audience_specific')}</option>
            </select>
          </div>

          {/* User search (when targeting specific user) */}
          {targetType === 'user' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                {t('notifications.select_user')}
              </label>
              <input
                type="text"
                value={userSearch}
                onChange={(e) => handleUserSearch(e.target.value)}
                placeholder={t('notifications.search_user_placeholder')}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
              />
              {userResults.length > 0 && (
                <div className="mt-1 border border-neutral-200 rounded-lg max-h-32 overflow-y-auto">
                  {userResults.map((u) => (
                    <button
                      key={u.id}
                      onClick={() => {
                        setTargetUserId(u.id);
                        setUserSearch(u.full_name || u.phone);
                        setUserResults([]);
                      }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-neutral-50 border-b border-neutral-100 last:border-b-0"
                    >
                      {u.full_name || '\u2014'} \u00b7 {u.phone}
                    </button>
                  ))}
                </div>
              )}
              {targetUserId && (
                <p className="text-xs text-green-600 mt-1">
                  {t('notifications.user_selected')}
                </p>
              )}
              {formErrors.target && <p className="text-red-500 text-xs mt-1">{formErrors.target}</p>}
            </div>
          )}

          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              {t('notifications.label_title')}<span className="text-red-500 ml-1">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setFormErrors((prev) => { const { title, ...rest } = prev; return rest; }); }}
              placeholder={t('notifications.title_placeholder')}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 ${formErrors.title ? 'border-red-500' : 'border-neutral-200'}`}
            />
            {formErrors.title && <p className="text-red-500 text-xs mt-1">{formErrors.title}</p>}
          </div>

          {/* Body */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              {t('notifications.label_body')}<span className="text-red-500 ml-1">*</span>
            </label>
            <textarea
              value={body}
              onChange={(e) => { setBody(e.target.value); setFormErrors((prev) => { const { body, ...rest } = prev; return rest; }); }}
              placeholder={t('notifications.body_placeholder')}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500 ${formErrors.body ? 'border-red-500' : 'border-neutral-200'}`}
              rows={3}
            />
            {formErrors.body && <p className="text-red-500 text-xs mt-1">{formErrors.body}</p>}
          </div>

          {/* Send result */}
          {sendResult && (
            <div className={`p-3 rounded-lg text-sm ${
              sendResult.error === -1
                ? 'bg-red-50 text-red-700'
                : 'bg-green-50 text-green-700'
            }`}>
              {sendResult.error === -1
                ? t('notifications.send_error')
                : t('notifications.send_success', {
                    success: sendResult.success,
                    errors: sendResult.error,
                  })}
            </div>
          )}

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={sending || !title.trim() || !body.trim() || (targetType === 'user' && !targetUserId)}
            className="px-6 py-2.5 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50"
          >
            {sending ? t('common.processing') : t('notifications.send')}
          </button>
        </div>
      </div>

      {/* Inbox Stats */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-8">
        <h2 className="text-lg font-bold mb-4">{t('notifications.inbox_stats')}</h2>

        {statsLoading ? (
          <AdminTableSkeleton rows={3} columns={3} />
        ) : inboxStats ? (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-blue-50 rounded-lg p-4">
                <p className="text-xs text-blue-600 font-medium mb-1">{t('notifications.total_today')}</p>
                <p className="text-2xl font-bold text-blue-700">{inboxStats.totalToday}</p>
              </div>
              <div className="bg-orange-50 rounded-lg p-4">
                <p className="text-xs text-orange-600 font-medium mb-1">{t('notifications.total_unread')}</p>
                <p className="text-2xl font-bold text-orange-700">{inboxStats.totalUnread}</p>
              </div>
            </div>

            {/* By type breakdown */}
            {Object.keys(inboxStats.byType).length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-semibold text-neutral-700 mb-2">{t('notifications.by_type')}</h3>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(inboxStats.byType)
                    .sort(([, a], [, b]) => b - a)
                    .map(([type, count]) => (
                      <span
                        key={type}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-700"
                      >
                        {type} <span className="text-neutral-500">{count}</span>
                      </span>
                    ))}
                </div>
              </div>
            )}

            {/* Recent inbox notifications table */}
            <h3 className="text-sm font-semibold text-neutral-700 mb-2">{t('notifications.recent_inbox')}</h3>
            {inboxStats.recent.length === 0 ? (
              <p className="text-sm text-neutral-400">{t('notifications.inbox_no_data')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-neutral-100">
                      <th className="text-left px-3 py-2 text-xs font-semibold text-neutral-500">{t('notifications.col_date')}</th>
                      <th className="text-left px-3 py-2 text-xs font-semibold text-neutral-500">{t('notifications.col_type')}</th>
                      <th className="text-left px-3 py-2 text-xs font-semibold text-neutral-500">{t('notifications.col_title')}</th>
                      <th className="text-left px-3 py-2 text-xs font-semibold text-neutral-500">{t('notifications.col_user')}</th>
                      <th className="text-left px-3 py-2 text-xs font-semibold text-neutral-500">{t('notifications.col_read')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inboxStats.recent.map((n) => (
                      <tr key={n.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                        <td className="px-3 py-2 text-xs text-neutral-600">{formatAdminDate(n.created_at)}</td>
                        <td className="px-3 py-2">
                          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-neutral-100 text-neutral-600">
                            {n.type}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <p className="text-xs font-medium">{n.title}</p>
                          <p className="text-[10px] text-neutral-400 truncate max-w-[200px]">{n.body}</p>
                        </td>
                        <td className="px-3 py-2 text-xs text-neutral-500 font-mono">{n.user_id.slice(0, 8)}…</td>
                        <td className="px-3 py-2">
                          {n.read ? (
                            <span className="inline-block w-2 h-2 rounded-full bg-green-400" title="Read" />
                          ) : (
                            <span className="inline-block w-2 h-2 rounded-full bg-orange-400" title="Unread" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-neutral-400">{t('notifications.inbox_no_data')}</p>
        )}
      </div>

      {/* Notification History */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
        <h2 className="text-lg font-bold mb-4">{t('notifications.history')}</h2>

        {historyLoading ? (
          <AdminTableSkeleton rows={5} columns={4} />
        ) : history.length === 0 ? (
          <p className="text-sm text-neutral-400">{t('notifications.no_notifications')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-neutral-100">
                  <SortableHeader label={t('notifications.col_date')} sortKey="created_at" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="text-left px-4 py-3 text-xs font-semibold text-neutral-500" />
                  <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500">{t('notifications.col_title')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500">{t('notifications.col_audience')}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-500">{t('notifications.col_sent')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedHistory.map((n) => (
                  <tr key={n.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                    <td className="px-4 py-3 text-sm text-neutral-600">
                      {formatAdminDate(n.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium">{n.title}</p>
                      <p className="text-xs text-neutral-500 mt-0.5">{n.body}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                        {TARGET_LABELS[n.target_type]?.es ?? n.target_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-neutral-600">
                      {n.sent_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
