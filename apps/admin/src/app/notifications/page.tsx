'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, Send, X } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { notificationService } from '@tricigo/api';
import { adminService } from '@tricigo/api';
import { getSupabaseClient } from '@tricigo/api';
import type { User, AppNotification } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatAdminDate } from '@/lib/formatDate';

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

export default function NotificationsPage() {
  const { t } = useTranslation('admin');
  const audienceLabel = (a: string): string => {
    const fallbacks: Record<string, string> = {
      all: 'Todos', customers: 'Pasajeros', drivers: 'Conductores', user: 'Usuario específico',
    };
    return t(`notifications.audience_${a}`, { defaultValue: fallbacks[a] ?? a });
  };
  const { showToast } = useToast();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [targetType, setTargetType] = useState<'all' | 'customers' | 'drivers' | 'user'>('all');
  const [targetUserId, setTargetUserId] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [userResults, setUserResults] = useState<User[]>([]);
  const [sending, setSending] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const [history, setHistory] = useState<NotificationLog[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });

  const [inboxStats, setInboxStats] = useState<{
    totalToday: number;
    totalUnread: number;
    byType: Record<string, number>;
    recent: AppNotification[];
  } | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await notificationService.getNotificationHistory(0, 50);
      setHistory(data);
    } catch (err) {
      setHistory([]);
      setHistoryError(err instanceof Error ? err.message : t('notifications.history_error', { defaultValue: 'No pudimos cargar el historial.' }));
    } finally {
      setHistoryLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadInboxStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const supabase = getSupabaseClient();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

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
        supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(10),
      ]);

      const byType: Record<string, number> = {};
      for (const row of typeRes.data ?? []) {
        byType[row.type] = (byType[row.type] || 0) + 1;
      }

      setInboxStats({
        totalToday: todayRes.count ?? 0,
        totalUnread: unreadRes.count ?? 0,
        byType,
        recent: (recentRes.data ?? []) as AppNotification[],
      });
    } catch {
      setInboxStats(null);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    void loadInboxStats();
  }, [loadHistory, loadInboxStats]);

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

  const validateForm = () => {
    const errors: Record<string, string> = {};
    const required = t('notifications.required', { defaultValue: 'Requerido' });
    if (!title.trim()) errors.title = required;
    if (!body.trim()) errors.body = required;
    if (targetType === 'user' && !targetUserId) errors.target = t('notifications.choose_user_error', { defaultValue: 'Elegí un usuario' });
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSend = async () => {
    if (!validateForm()) return;
    setSending(true);
    try {
      let result: { successCount: number; errorCount: number };
      if (targetType === 'user') {
        result = await notificationService.sendToUser(targetUserId, title, body, 'admin');
      } else {
        result = await notificationService.broadcastPush(title, body, targetType, 'admin');
      }
      setTitle('');
      setBody('');
      setTargetUserId('');
      setUserSearch('');
      setFormErrors({});
      await loadHistory();
      const sentLabel = t('notifications.sent_result', { defaultValue: 'Enviadas' });
      const failedSuffix = t('notifications.failed_suffix', { defaultValue: 'fallidas' });
      showToast(
        'success',
        `${sentLabel} ${result.successCount}${result.errorCount > 0 ? ` · ${result.errorCount} ${failedSuffix}` : ''}`,
      );
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('notifications.sent_error', { defaultValue: 'No pudimos enviar el push.' }));
    } finally {
      setSending(false);
    }
  };

  const historyColumns: DataColumn<NotificationLog>[] = useMemo(
    () => [
      {
        id: 'title',
        header: t('notifications.col_message', { defaultValue: 'Mensaje' }),
        cell: (n) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-ink">{n.title}</span>
            <span className="truncate text-[11.5px] text-ink-muted">{n.body}</span>
          </span>
        ),
        primary: true,
      },
      {
        id: 'target_type',
        header: t('notifications.col_audience', { defaultValue: 'Audiencia' }),
        cell: (n) => (
          <span className="inline-flex items-center rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
            {audienceLabel(n.target_type)}
          </span>
        ),
        width: '150px',
      },
      {
        id: 'sent_count',
        header: t('notifications.col_sent', { defaultValue: 'Enviados' }),
        cell: (n) => <span className="tabular" data-tabular>{n.sent_count.toLocaleString('es-CU')}</span>,
        align: 'right',
        mono: true,
        width: '120px',
        secondary: true,
      },
      {
        id: 'created_at',
        header: t('notifications.col_date', { defaultValue: 'Fecha' }),
        cell: (n) => <span className="text-ink-muted">{formatAdminDate(n.created_at)}</span>,
        sortKey: 'created_at',
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  const inboxColumns: DataColumn<AppNotification>[] = [
    {
      id: 'title',
      header: t('notifications.col_notification', { defaultValue: 'Notificación' }),
      cell: (n) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-ink">{n.title}</span>
          <span className="truncate text-[11.5px] text-ink-muted">{n.body}</span>
        </span>
      ),
      primary: true,
    },
    {
      id: 'type',
      header: t('notifications.col_type', { defaultValue: 'Tipo' }),
      cell: (n) => (
        <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 font-mono text-[10px] text-ink-muted">
          {n.type}
        </span>
      ),
      width: '130px',
    },
    {
      id: 'user_id',
      header: t('notifications.col_user', { defaultValue: 'Usuario' }),
      cell: (n) => `${n.user_id.slice(0, 8)}…`,
      mono: true,
      hideBelow: 'md',
      width: '120px',
    },
    {
      id: 'read',
      header: t('notifications.col_status', { defaultValue: 'Estado' }),
      cell: (n) =>
        n.read ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            {t('notifications.status_read', { defaultValue: 'Leída' })}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            {t('notifications.status_unread', { defaultValue: 'Sin leer' })}
          </span>
        ),
      width: '110px',
    },
    {
      id: 'created_at',
      header: t('notifications.col_date', { defaultValue: 'Fecha' }),
      cell: (n) => <span className="text-ink-muted">{formatAdminDate(n.created_at)}</span>,
      hideBelow: 'lg',
      width: '170px',
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('notifications.page_eyebrow', { defaultValue: 'Contenido · push' })}
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          {t('notifications.title', { defaultValue: 'Notificaciones' })}
        </h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          {t('notifications.page_description', { defaultValue: 'Mandá avisos a toda Cuba, a un segmento de usuarios o a una persona puntual.' })}
        </p>
      </div>

      {/* Compose */}
      <SectionCard
        eyebrow={t('notifications.section_compose_eyebrow', { defaultValue: 'Redactar' })}
        title={t('notifications.section_compose_title', { defaultValue: 'Nuevo aviso push' })}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              {t('notifications.field_audience', { defaultValue: 'Audiencia' })} <span className="text-red-500">*</span>
            </span>
            <select
              value={targetType}
              onChange={(e) => {
                setTargetType(e.target.value as typeof targetType);
                setTargetUserId('');
                setUserSearch('');
                setFormErrors(({ target: _t, ...rest }) => rest);
              }}
              className={inputCls}
            >
              <option value="all">{t('notifications.audience_all', { defaultValue: 'Todos' })}</option>
              <option value="customers">{t('notifications.audience_customers', { defaultValue: 'Pasajeros' })}</option>
              <option value="drivers">{t('notifications.audience_drivers', { defaultValue: 'Conductores' })}</option>
              <option value="user">{t('notifications.audience_user', { defaultValue: 'Usuario específico' })}</option>
            </select>
          </label>

          {targetType === 'user' && (
            <label className="relative flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('notifications.field_choose_user', { defaultValue: 'Elegir usuario' })}
              </span>
              <input
                value={userSearch}
                onChange={(e) => void handleUserSearch(e.target.value)}
                placeholder={t('notifications.placeholder_user_search', { defaultValue: 'Buscar por nombre, teléfono o email…' })}
                className={inputCls}
              />
              {userResults.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded-lg border border-line bg-surface-elevated shadow-elev-2">
                  {userResults.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => {
                        setTargetUserId(u.id);
                        setUserSearch(u.full_name || u.phone || u.id);
                        setUserResults([]);
                      }}
                      className="flex w-full items-center justify-between gap-2 border-b border-line px-3 py-2 text-left text-[12.5px] last:border-b-0 hover:bg-surface-sunken"
                    >
                      <span className="truncate">{u.full_name || '—'}</span>
                      <span className="flex-shrink-0 font-mono text-[10px] text-ink-subtle">{u.phone}</span>
                    </button>
                  ))}
                </div>
              )}
              {targetUserId && (
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
                  {t('notifications.user_selected', { defaultValue: 'Usuario seleccionado' })}
                </span>
              )}
              {formErrors.target && <span className="text-[11px] text-red-500">{formErrors.target}</span>}
            </label>
          )}

          <label className="flex flex-col gap-1 md:col-span-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              {t('notifications.field_title', { defaultValue: 'Título' })} <span className="text-red-500">*</span>
            </span>
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setFormErrors(({ title: _t, ...rest }) => rest);
              }}
              placeholder={t('notifications.placeholder_title', { defaultValue: 'Lo que aparece en la notificación' })}
              className={errorInputCls(!!formErrors.title)}
            />
            {formErrors.title && <span className="text-[11px] text-red-500">{formErrors.title}</span>}
          </label>

          <label className="flex flex-col gap-1 md:col-span-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              {t('notifications.field_body', { defaultValue: 'Cuerpo' })} <span className="text-red-500">*</span>
            </span>
            <textarea
              rows={3}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setFormErrors(({ body: _b, ...rest }) => rest);
              }}
              placeholder={t('notifications.placeholder_body', { defaultValue: 'Mensaje que va a leer el usuario' })}
              className={errorTextareaCls(!!formErrors.body)}
            />
            {formErrors.body && <span className="text-[11px] text-red-500">{formErrors.body}</span>}
          </label>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={() => void handleSend()}
            disabled={sending || !title.trim() || !body.trim() || (targetType === 'user' && !targetUserId)}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary-500 px-4 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            {sending
              ? t('notifications.sending', { defaultValue: 'Enviando…' })
              : t('notifications.send_push', { defaultValue: 'Enviar push' })}
          </button>
        </div>
      </SectionCard>

      {/* Inbox stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label={t('notifications.kpi_sent_today', { defaultValue: 'Enviadas hoy' })}
          value={statsLoading ? '—' : String(inboxStats?.totalToday ?? 0)}
          tone="info"
          loading={statsLoading}
        />
        <KpiCard
          label={t('notifications.kpi_unread', { defaultValue: 'Sin leer' })}
          value={statsLoading ? '—' : String(inboxStats?.totalUnread ?? 0)}
          tone={inboxStats && inboxStats.totalUnread > 0 ? 'warning' : 'default'}
          loading={statsLoading}
        />
        <KpiCard
          label={t('notifications.kpi_types_today', { defaultValue: 'Tipos únicos hoy' })}
          value={statsLoading ? '—' : String(Object.keys(inboxStats?.byType ?? {}).length)}
          loading={statsLoading}
        />
      </div>

      {inboxStats && Object.keys(inboxStats.byType).length > 0 && (
        <SectionCard
          eyebrow={t('notifications.today_distribution_eyebrow', { defaultValue: 'Hoy' })}
          title={t('notifications.today_distribution_title', { defaultValue: 'Distribución por tipo' })}
        >
          <div className="flex flex-wrap gap-2">
            {Object.entries(inboxStats.byType)
              .sort(([, a], [, b]) => b - a)
              .map(([type, count]) => (
                <span
                  key={type}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px]"
                >
                  <span className="font-mono font-medium text-ink">{type}</span>
                  <span className="font-mono font-semibold text-ink-muted">{count}</span>
                </span>
              ))}
          </div>
        </SectionCard>
      )}

      {inboxStats?.recent && (
        <SectionCard
          eyebrow={t('notifications.inbox_eyebrow', { defaultValue: 'Inbox' })}
          title={t('notifications.inbox_title', { defaultValue: 'Últimas notificaciones entregadas' })}
        >
          <DataTable<AppNotification>
            columns={inboxColumns}
            rows={inboxStats.recent}
            keyField="id"
            loading={statsLoading}
            empty={{
              icon: Bell,
              title: t('notifications.empty_inbox_title', { defaultValue: 'Sin notificaciones recientes' }),
              body: t('notifications.empty_inbox_body', { defaultValue: 'Todavía no llegó ninguna a los usuarios.' }),
            }}
          />
        </SectionCard>
      )}

      {/* History */}
      <SectionCard
        eyebrow={t('notifications.history_eyebrow', { defaultValue: 'Historial' })}
        title={t('notifications.history_title', { defaultValue: 'Pushes enviados' })}
      >
        <DataTable<NotificationLog>
          columns={historyColumns}
          rows={history}
          keyField="id"
          loading={historyLoading}
          error={historyError}
          onRetry={() => void loadHistory()}
          empty={{
            icon: Bell,
            title: t('notifications.empty_history_title', { defaultValue: 'Sin historial' }),
            body: t('notifications.empty_history_body', { defaultValue: 'Todavía no se envió ninguna notificación desde este panel.' }),
          }}
          sort={sort}
          onSortChange={setSort}
        />
      </SectionCard>
    </div>
  );
}

const inputCls =
  'h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink focus:border-primary-500 focus:outline-none';

function errorInputCls(hasError: boolean) {
  return `h-9 rounded-lg border bg-surface px-2.5 text-[13px] text-ink focus:outline-none ${
    hasError ? 'border-red-500 focus:border-red-500' : 'border-line focus:border-primary-500'
  }`;
}

function errorTextareaCls(hasError: boolean) {
  return `rounded-lg border bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:outline-none ${
    hasError ? 'border-red-500 focus:border-red-500' : 'border-line focus:border-primary-500'
  }`;
}
