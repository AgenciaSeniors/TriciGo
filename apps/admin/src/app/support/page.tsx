'use client';

import { useEffect, useState } from 'react';
import { supportService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { useToast } from '@/components/ui/AdminToast';
import type { SupportTicket, TicketMessage, TicketStatus } from '@tricigo/types';
import { useAdminUser } from '@/lib/useAdminUser';
import { formatAdminDate } from '@/lib/formatDate';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';

const statusBadge: Record<string, string> = {
  open: 'bg-blue-50 text-blue-700',
  in_progress: 'bg-yellow-50 text-yellow-700',
  waiting_user: 'bg-purple-50 text-purple-700',
  resolved: 'bg-green-50 text-green-700',
  closed: 'bg-neutral-100 text-neutral-500',
};

const statusLabelKeys: Record<string, string> = {
  open: 'support.status_open',
  in_progress: 'support.status_in_progress',
  waiting_user: 'support.status_waiting_user',
  resolved: 'support.status_resolved',
  closed: 'support.status_closed',
};

const priorityBadge: Record<string, string> = {
  low: 'bg-neutral-100 text-neutral-600',
  normal: 'bg-blue-50 text-blue-600',
  high: 'bg-orange-50 text-orange-600',
  urgent: 'bg-red-50 text-red-600',
};

const categoryLabelKeys: Record<string, string> = {
  ride_issue: 'support.category_ride_issue',
  payment_issue: 'support.category_payment_issue',
  driver_complaint: 'support.category_driver_complaint',
  passenger_complaint: 'support.category_passenger_complaint',
  account_issue: 'support.category_account_issue',
  app_bug: 'support.category_app_bug',
  feature_request: 'support.category_feature_request',
  other: 'support.category_other',
};


export default function SupportPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('open');
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const fetchTickets = async () => {
    setLoading(true);
    try {
      const data = await supportService.getAllTickets({
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 100,
      });
      setTickets(data);
    } catch (err) {
      // Error handled by UI
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTickets();
  }, [statusFilter]);

  const openTicketDetail = async (ticket: SupportTicket) => {
    setSelectedTicket(ticket);
    try {
      const msgs = await supportService.getMessages(ticket.id);
      setMessages(msgs);
    } catch (err) {
      // Error handled by UI
    }
  };

  const handleReply = async () => {
    if (!selectedTicket || !reply.trim()) return;
    setSending(true);
    try {
      const msg = await supportService.sendMessage({
        ticket_id: selectedTicket.id,
        sender_id: adminUserId,
        message: reply.trim(),
        is_admin: true,
      });
      setMessages((prev) => [...prev, msg]);
      setReply('');
      showToast('success', t('support.reply_sent', { defaultValue: 'Respuesta enviada' }));

      // Update status to in_progress if it was open
      if (selectedTicket.status === 'open') {
        await supportService.updateTicket(selectedTicket.id, { status: 'in_progress' });
        setSelectedTicket((prev) => prev ? { ...prev, status: 'in_progress' } : null);
        setTickets((prev) =>
          prev.map((t) => t.id === selectedTicket.id ? { ...t, status: 'in_progress' as TicketStatus } : t),
        );
      }
    } catch (err) {
      // Error handled by UI
    } finally {
      setSending(false);
    }
  };

  const handleStatusChange = async (ticketId: string, newStatus: TicketStatus) => {
    try {
      await supportService.updateTicket(ticketId, { status: newStatus });
      setTickets((prev) =>
        prev.map((t) => (t.id === ticketId ? { ...t, status: newStatus } : t)),
      );
      if (selectedTicket?.id === ticketId) {
        setSelectedTicket((prev) => prev ? { ...prev, status: newStatus } : null);
      }
    } catch (err) {
      // Error handled by UI
    }
  };

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6">{t('support.title')}</h1>

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {(['all', 'open', 'in_progress', 'waiting_user', 'resolved', 'closed'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            aria-pressed={statusFilter === s}
            aria-label={s === 'all' ? t('support.filter_all') : (statusLabelKeys[s] ? t(statusLabelKeys[s]) : s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === s
                ? 'bg-primary-500 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {s === 'all' ? t('support.filter_all') : (statusLabelKeys[s] ? t(statusLabelKeys[s]) : s)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Ticket list */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
          <div className="max-h-[600px] overflow-y-auto">
            {loading ? (
              <div className="px-4 py-4">
                <AdminTableSkeleton rows={5} columns={4} />
              </div>
            ) : tickets.length === 0 ? (
              <div className="text-center py-12 text-neutral-400">
                {t('support.no_tickets')}
              </div>
            ) : (
              tickets.map((ticket) => (
                <button
                  key={ticket.id}
                  onClick={() => openTicketDetail(ticket)}
                  aria-label={`${ticket.subject} - ${statusLabelKeys[ticket.status] ? t(statusLabelKeys[ticket.status]!) : ticket.status}`}
                  className={`w-full text-left px-4 py-3 border-b border-neutral-50 hover:bg-neutral-50 transition-colors ${
                    selectedTicket?.id === ticket.id ? 'bg-orange-50' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium truncate pr-2">{ticket.subject}</span>
                    <span className={`shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                      statusBadge[ticket.status] ?? 'bg-neutral-100'
                    }`}>
                      {statusLabelKeys[ticket.status] ? t(statusLabelKeys[ticket.status]!) : ticket.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-neutral-400">
                      {categoryLabelKeys[ticket.category] ? t(categoryLabelKeys[ticket.category]!) : ticket.category}
                    </span>
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      priorityBadge[ticket.priority] ?? ''
                    }`}>
                      {ticket.priority}
                    </span>
                    <span className="text-xs text-neutral-400 ml-auto">
                      {formatAdminDate(ticket.created_at)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Ticket detail */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6" aria-label={t('support.ticket_detail', { defaultValue: 'Ticket detail' })}>
          {selectedTicket ? (
            <div className="flex flex-col h-[600px]">
              {/* Header */}
              <div className="mb-4 pb-4 border-b border-neutral-100">
                <h2 className="text-lg font-bold">{selectedTicket.subject}</h2>
                <div className="flex items-center gap-2 mt-2">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                    statusBadge[selectedTicket.status] ?? ''
                  }`}>
                    {statusLabelKeys[selectedTicket.status] ? t(statusLabelKeys[selectedTicket.status]!) : selectedTicket.status}
                  </span>
                  <span className="text-xs text-neutral-400">
                    {categoryLabelKeys[selectedTicket.category] ? t(categoryLabelKeys[selectedTicket.category]!) : selectedTicket.category}
                  </span>
                </div>
                {selectedTicket.description && (
                  <p className="text-sm text-neutral-600 mt-2">{selectedTicket.description}</p>
                )}
                {/* Status change */}
                <div className="flex gap-2 mt-3">
                  {selectedTicket.status !== 'resolved' && (
                    <button
                      onClick={() => handleStatusChange(selectedTicket.id, 'resolved')}
                      className="px-3 py-1 rounded-lg text-xs font-medium bg-green-100 text-green-700 hover:bg-green-200"
                    >
                      {t('support.resolve')}
                    </button>
                  )}
                  {selectedTicket.status !== 'closed' && (
                    <button
                      onClick={() => handleStatusChange(selectedTicket.id, 'closed')}
                      className="px-3 py-1 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                    >
                      {t('support.close')}
                    </button>
                  )}
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto space-y-3 mb-4">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`rounded-lg p-3 text-sm ${
                      msg.is_admin
                        ? 'bg-primary-500/10 ml-8'
                        : 'bg-neutral-50 mr-8'
                    }`}
                  >
                    <p className="text-xs text-neutral-400 mb-1">
                      {msg.is_admin ? t('support.support_label') : t('support.user_label')} · {formatAdminDate(msg.created_at)}
                    </p>
                    <p>{msg.message}</p>
                  </div>
                ))}
              </div>

              {/* Reply */}
              <div className="flex gap-2">
                <input
                  className="flex-1 border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                  placeholder={t('support.reply_placeholder')}
                  aria-label={t('support.reply_placeholder')}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleReply()}
                />
                <button
                  onClick={handleReply}
                  disabled={sending || !reply.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50"
                >
                  {t('support.send')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[600px] text-neutral-400">
              {t('support.select_ticket')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
