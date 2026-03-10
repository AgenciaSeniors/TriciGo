'use client';

import { useEffect, useState } from 'react';
import { supportService } from '@tricigo/api';
import type { SupportTicket, TicketMessage, TicketStatus } from '@tricigo/types';

const statusBadge: Record<string, string> = {
  open: 'bg-blue-50 text-blue-700',
  in_progress: 'bg-yellow-50 text-yellow-700',
  waiting_user: 'bg-purple-50 text-purple-700',
  resolved: 'bg-green-50 text-green-700',
  closed: 'bg-neutral-100 text-neutral-500',
};

const statusLabels: Record<string, string> = {
  open: 'Abierto',
  in_progress: 'En progreso',
  waiting_user: 'Esperando usuario',
  resolved: 'Resuelto',
  closed: 'Cerrado',
};

const priorityBadge: Record<string, string> = {
  low: 'bg-neutral-100 text-neutral-600',
  normal: 'bg-blue-50 text-blue-600',
  high: 'bg-orange-50 text-orange-600',
  urgent: 'bg-red-50 text-red-600',
};

const categoryLabels: Record<string, string> = {
  ride_issue: 'Problema de viaje',
  payment_issue: 'Problema de pago',
  driver_complaint: 'Queja de conductor',
  passenger_complaint: 'Queja de pasajero',
  account_issue: 'Problema de cuenta',
  app_bug: 'Error de app',
  feature_request: 'Sugerencia',
  other: 'Otro',
};

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('es-CU', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SupportPage() {
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
      console.error('Error fetching tickets:', err);
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
      console.error('Error fetching messages:', err);
    }
  };

  const handleReply = async () => {
    if (!selectedTicket || !reply.trim()) return;
    setSending(true);
    try {
      const msg = await supportService.sendMessage({
        ticket_id: selectedTicket.id,
        sender_id: 'admin-placeholder',
        message: reply.trim(),
        is_admin: true,
      });
      setMessages((prev) => [...prev, msg]);
      setReply('');

      // Update status to in_progress if it was open
      if (selectedTicket.status === 'open') {
        await supportService.updateTicket(selectedTicket.id, { status: 'in_progress' });
        setSelectedTicket((prev) => prev ? { ...prev, status: 'in_progress' } : null);
        setTickets((prev) =>
          prev.map((t) => t.id === selectedTicket.id ? { ...t, status: 'in_progress' as TicketStatus } : t),
        );
      }
    } catch (err) {
      console.error('Error sending reply:', err);
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
      console.error('Error updating ticket:', err);
    }
  };

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Tickets de soporte</h1>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6">
        {(['all', 'open', 'in_progress', 'waiting_user', 'resolved', 'closed'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === s
                ? 'bg-[#FF4D00] text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {s === 'all' ? 'Todos' : statusLabels[s] ?? s}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Ticket list */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
          <div className="max-h-[600px] overflow-y-auto">
            {tickets.length === 0 ? (
              <div className="text-center py-12 text-neutral-400">
                {loading ? 'Cargando...' : 'Sin tickets'}
              </div>
            ) : (
              tickets.map((ticket) => (
                <button
                  key={ticket.id}
                  onClick={() => openTicketDetail(ticket)}
                  className={`w-full text-left px-4 py-3 border-b border-neutral-50 hover:bg-neutral-50 transition-colors ${
                    selectedTicket?.id === ticket.id ? 'bg-orange-50' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium truncate pr-2">{ticket.subject}</span>
                    <span className={`shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                      statusBadge[ticket.status] ?? 'bg-neutral-100'
                    }`}>
                      {statusLabels[ticket.status] ?? ticket.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-neutral-400">
                      {categoryLabels[ticket.category] ?? ticket.category}
                    </span>
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      priorityBadge[ticket.priority] ?? ''
                    }`}>
                      {ticket.priority}
                    </span>
                    <span className="text-xs text-neutral-400 ml-auto">
                      {formatDate(ticket.created_at)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Ticket detail */}
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6">
          {selectedTicket ? (
            <div className="flex flex-col h-[600px]">
              {/* Header */}
              <div className="mb-4 pb-4 border-b border-neutral-100">
                <h2 className="text-lg font-bold">{selectedTicket.subject}</h2>
                <div className="flex items-center gap-2 mt-2">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                    statusBadge[selectedTicket.status] ?? ''
                  }`}>
                    {statusLabels[selectedTicket.status] ?? selectedTicket.status}
                  </span>
                  <span className="text-xs text-neutral-400">
                    {categoryLabels[selectedTicket.category] ?? selectedTicket.category}
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
                      Resolver
                    </button>
                  )}
                  {selectedTicket.status !== 'closed' && (
                    <button
                      onClick={() => handleStatusChange(selectedTicket.id, 'closed')}
                      className="px-3 py-1 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                    >
                      Cerrar
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
                        ? 'bg-[#FF4D00]/10 ml-8'
                        : 'bg-neutral-50 mr-8'
                    }`}
                  >
                    <p className="text-xs text-neutral-400 mb-1">
                      {msg.is_admin ? 'Soporte' : 'Usuario'} · {formatDate(msg.created_at)}
                    </p>
                    <p>{msg.message}</p>
                  </div>
                ))}
              </div>

              {/* Reply */}
              <div className="flex gap-2">
                <input
                  className="flex-1 border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#FF4D00]"
                  placeholder="Escribir respuesta..."
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleReply()}
                />
                <button
                  onClick={handleReply}
                  disabled={sending || !reply.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-[#FF4D00] text-white hover:bg-[#e04400] disabled:opacity-50"
                >
                  Enviar
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[600px] text-neutral-400">
              Selecciona un ticket para ver los detalles
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
