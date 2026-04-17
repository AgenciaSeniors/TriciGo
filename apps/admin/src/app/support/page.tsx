'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Headphones, Send } from 'lucide-react';
import { supportService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { useToast } from '@/components/ui/AdminToast';
import type { SupportTicket, TicketMessage, TicketStatus } from '@tricigo/types';
import { useAdminUser } from '@/lib/useAdminUser';
import { formatAdminDate } from '@/lib/formatDate';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { DataEmptyState } from '@/components/data/DataEmptyState';

type Filter = TicketStatus | 'all';

const PRIORITY_CLASS: Record<string, string> = {
  low: 'bg-surface-sunken text-ink-muted',
  normal: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  high: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  urgent: 'bg-red-600 text-white',
};

export default function SupportPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<Filter>('open');
  const [selected, setSelected] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const TABS: StatusTab<Filter>[] = useMemo(() => [
    { id: 'all', label: t('support.filter_all', { defaultValue: 'Todos' }) },
    { id: 'open', label: t('support.filter_open', { defaultValue: 'Abiertos' }), tone: 'info' },
    { id: 'in_progress', label: t('support.filter_in_progress', { defaultValue: 'En progreso' }), tone: 'warning' },
    { id: 'waiting_user', label: t('support.filter_waiting_user', { defaultValue: 'Esperando usuario' }), tone: 'warning' },
    { id: 'resolved', label: t('support.filter_resolved', { defaultValue: 'Resueltos' }), tone: 'success' },
    { id: 'closed', label: t('support.filter_closed', { defaultValue: 'Cerrados' }) },
  ], [t]);

  const priorityLabel = useCallback((p: string): string => {
    const fallbacks: Record<string, string> = { low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
    return t(`support.priority_${p}`, { defaultValue: fallbacks[p] ?? p });
  }, [t]);

  const categoryLabel = useCallback((c: string): string => {
    const fallbacks: Record<string, string> = {
      ride_issue: 'Problema con viaje', payment_issue: 'Pago', driver_complaint: 'Queja conductor',
      passenger_complaint: 'Queja pasajero', account_issue: 'Cuenta', app_bug: 'Bug en la app',
      feature_request: 'Sugerencia', other: 'Otro',
    };
    return t(`support.category_${c}`, { defaultValue: fallbacks[c] ?? c });
  }, [t]);

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await supportService.getAllTickets({
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 100,
      });
      setTickets(data);
    } catch (err) {
      setTickets([]);
      setError(err instanceof Error ? err.message : t('support.load_error', { defaultValue: 'No pudimos cargar los tickets.' }));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  useEffect(() => {
    void fetchTickets();
  }, [fetchTickets]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const openTicketDetail = async (ticket: SupportTicket) => {
    setSelected(ticket);
    try {
      const msgs = await supportService.getMessages(ticket.id);
      setMessages(msgs);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('support.messages_error', { defaultValue: 'No pudimos cargar los mensajes.' }));
    }
  };

  const handleReply = async () => {
    if (!selected || !reply.trim()) return;
    setSending(true);
    try {
      const msg = await supportService.sendMessage({
        ticket_id: selected.id,
        sender_id: adminUserId,
        message: reply.trim(),
        is_admin: true,
      });
      setMessages((prev) => [...prev, msg]);
      setReply('');
      showToast('success', t('support.toast_sent', { defaultValue: 'Respuesta enviada' }));

      if (selected.status === 'open') {
        await supportService.updateTicket(selected.id, { status: 'in_progress' });
        setSelected((prev) => (prev ? { ...prev, status: 'in_progress' } : null));
        setTickets((prev) =>
          prev.map((x) =>
            x.id === selected.id ? { ...x, status: 'in_progress' as TicketStatus } : x,
          ),
        );
      }
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('support.send_error', { defaultValue: 'No pudimos enviar la respuesta.' }));
    } finally {
      setSending(false);
    }
  };

  const handleStatusChange = async (ticketId: string, newStatus: TicketStatus) => {
    try {
      await supportService.updateTicket(ticketId, { status: newStatus });
      setTickets((prev) =>
        prev.map((x) => (x.id === ticketId ? { ...x, status: newStatus } : x)),
      );
      if (selected?.id === ticketId) {
        setSelected((prev) => (prev ? { ...prev, status: newStatus } : null));
      }
      showToast('success', t('support.toast_status_updated', { defaultValue: 'Estado actualizado' }));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('support.status_error', { defaultValue: 'No pudimos cambiar el estado.' }));
    }
  };

  const renderList = () => {
    if (loading) {
      return (
        <div className="space-y-3 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl bg-surface-sunken p-3">
              <div className="h-9 w-9 animate-pulse rounded-xl bg-surface-elevated" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-3/4 animate-pulse rounded bg-surface-elevated" />
                <div className="h-2.5 w-1/3 animate-pulse rounded bg-surface-elevated" />
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (error) {
      return (
        <div className="p-6">
          <DataEmptyState
            icon={Headphones}
            tone="danger"
            title={t('support.load_error_title', { defaultValue: 'No pudimos cargar los tickets' })}
            body={error}
            action={{ label: t('support.retry', { defaultValue: 'Reintentar' }), onClick: () => void fetchTickets() }}
          />
        </div>
      );
    }
    if (tickets.length === 0) {
      return (
        <div className="p-6">
          <DataEmptyState
            icon={Headphones}
            title={t('support.empty_title', { defaultValue: 'Sin tickets' })}
            body={t('support.empty_body', { defaultValue: 'Nada pendiente en este alcance. Buen trabajo.' })}
          />
        </div>
      );
    }
    return (
      <ul className="divide-y divide-line">
        {tickets.map((ticket) => {
          const active = selected?.id === ticket.id;
          const priorityClass = PRIORITY_CLASS[ticket.priority] ?? PRIORITY_CLASS.normal!;
          return (
            <li key={ticket.id}>
              <button
                type="button"
                onClick={() => void openTicketDetail(ticket)}
                aria-current={active ? 'true' : undefined}
                className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                  active ? 'bg-primary-500/8' : 'hover:bg-surface-sunken'
                }`}
              >
                <span
                  className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${
                    active ? 'bg-primary-500/15 text-primary-500' : 'bg-surface-sunken text-ink-muted'
                  }`}
                >
                  <Headphones className="h-4 w-4" strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {ticket.subject}
                    </span>
                    <StatusBadge domain="support" status={ticket.status} />
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-subtle">
                    <span className="truncate">
                      {categoryLabel(ticket.category)}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${priorityClass}`}
                    >
                      {priorityLabel(ticket.priority)}
                    </span>
                    <span className="ml-auto">{formatAdminDate(ticket.created_at)}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('support.page_eyebrow', { defaultValue: 'Gente · soporte' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('support.title', { defaultValue: 'Soporte' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('support.page_description', { defaultValue: 'Conversaciones con pasajeros y conductores. Respondé rápido, resolvé mejor.' })}
          </p>
        </div>
      </div>

      <FilterBar<Filter>
        sticky
        tabs={TABS}
        activeTab={statusFilter}
        onTabChange={(id) => {
          setStatusFilter(id);
          setSelected(null);
          setMessages([]);
        }}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="admin-card overflow-hidden lg:col-span-2">
          <div className="border-b border-line px-4 py-2.5">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
              {t('support.tray_eyebrow', { defaultValue: 'Bandeja' })}
            </p>
            <h2 className="font-display text-[15px] font-semibold text-ink">
              {t('support.tray_title', { defaultValue: 'Tickets' })} ({tickets.length})
            </h2>
          </div>
          <div className="max-h-[660px] overflow-y-auto">{renderList()}</div>
        </div>

        <div className="admin-card lg:col-span-3">
          {!selected ? (
            <div className="flex min-h-[480px] items-center justify-center p-6">
              <DataEmptyState
                icon={Headphones}
                title={t('support.pick_title', { defaultValue: 'Elegí un ticket' })}
                body={t('support.pick_body', { defaultValue: 'Seleccioná uno en la bandeja para ver la conversación y responder.' })}
              />
            </div>
          ) : (
            <div className="flex h-[660px] flex-col">
              <div className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                    {categoryLabel(selected.category)}
                  </p>
                  <h2 className="font-display text-[17px] font-semibold text-ink">
                    {selected.subject}
                  </h2>
                  {selected.description && (
                    <p className="mt-1 text-[12.5px] text-ink-muted">{selected.description}</p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <StatusBadge domain="support" status={selected.status} size="md" />
                  <div className="flex gap-1.5">
                    {selected.status !== 'resolved' && (
                      <button
                        onClick={() => void handleStatusChange(selected.id, 'resolved')}
                        className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400"
                      >
                        {t('support.btn_resolve', { defaultValue: 'Resolver' })}
                      </button>
                    )}
                    {selected.status !== 'closed' && (
                      <button
                        onClick={() => void handleStatusChange(selected.id, 'closed')}
                        className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11px] font-medium text-ink-muted hover:text-ink"
                      >
                        {t('support.btn_close', { defaultValue: 'Cerrar' })}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4">
                <div className="flex flex-col gap-3">
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex flex-col gap-1 ${
                        msg.is_admin ? 'items-end' : 'items-start'
                      }`}
                    >
                      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-subtle">
                        {msg.is_admin
                          ? t('support.sender_support', { defaultValue: 'Soporte' })
                          : t('support.sender_user', { defaultValue: 'Usuario' })} · {formatAdminDate(msg.created_at)}
                      </p>
                      <div
                        className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-[13px] ${
                          msg.is_admin
                            ? 'bg-primary-500/10 text-ink'
                            : 'border border-line bg-surface-sunken text-ink'
                        }`}
                      >
                        {msg.message}
                      </div>
                    </div>
                  ))}
                  {messages.length === 0 && (
                    <p className="py-6 text-center text-[12.5px] italic text-ink-subtle">
                      {t('support.no_messages', { defaultValue: 'Sin mensajes todavía.' })}
                    </p>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              </div>

              <div className="flex items-center gap-2 border-t border-line px-4 py-3">
                <input
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && reply.trim()) {
                      e.preventDefault();
                      void handleReply();
                    }
                  }}
                  placeholder={t('support.reply_placeholder', { defaultValue: 'Escribí tu respuesta y apretá Enter…' })}
                  aria-label={t('support.reply_aria', { defaultValue: 'Respuesta' })}
                  className="h-10 flex-1 rounded-full border border-line bg-surface px-4 text-[13px] text-ink placeholder:text-ink-subtle focus:border-primary-500 focus:outline-none"
                />
                <button
                  onClick={() => void handleReply()}
                  disabled={sending || !reply.trim()}
                  className="inline-flex h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-[12px] font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                  {sending
                    ? t('support.sending', { defaultValue: 'Enviando…' })
                    : t('support.send', { defaultValue: 'Enviar' })}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
