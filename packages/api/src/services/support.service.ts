// ============================================================
// TriciGo — Support Service
// Support ticket CRUD and messaging.
// ============================================================

import type {
  SupportTicket,
  TicketMessage,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const supportService = {
  // ==================== TICKETS ====================

  /**
   * Create a new support ticket.
   */
  async createTicket(params: {
    user_id: string;
    ride_id?: string;
    category: TicketCategory;
    subject: string;
    description?: string;
  }): Promise<SupportTicket> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('support_tickets')
      .insert({
        user_id: params.user_id,
        ride_id: params.ride_id ?? null,
        category: params.category,
        subject: params.subject,
        description: params.description ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return data as SupportTicket;
  },

  /**
   * Get tickets for a user.
   */
  async getUserTickets(userId: string): Promise<SupportTicket[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as SupportTicket[];
  },

  /**
   * Get all tickets (admin).
   */
  async getAllTickets(params?: {
    status?: TicketStatus;
    limit?: number;
  }): Promise<SupportTicket[]> {
    const supabase = getSupabaseClient();
    let query = supabase
      .from('support_tickets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(params?.limit ?? 50);

    if (params?.status) {
      query = query.eq('status', params.status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data as SupportTicket[];
  },

  /**
   * Get a single ticket by ID.
   */
  async getTicket(ticketId: string): Promise<SupportTicket | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .maybeSingle();
    if (error) throw error;
    return data as SupportTicket | null;
  },

  /**
   * Update ticket status, priority, or assignment (admin).
   */
  async updateTicket(
    ticketId: string,
    updates: Partial<Pick<SupportTicket, 'status' | 'priority' | 'assigned_to'>>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const payload: Record<string, unknown> = { ...updates, updated_at: new Date().toISOString() };
    if (updates.status === 'resolved' || updates.status === 'closed') {
      payload.resolved_at = new Date().toISOString();
    }
    const { error } = await supabase
      .from('support_tickets')
      .update(payload)
      .eq('id', ticketId);
    if (error) throw error;
  },

  // ==================== MESSAGES ====================

  /**
   * Get messages for a ticket.
   */
  async getMessages(ticketId: string): Promise<TicketMessage[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ticket_messages')
      .select('*')
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data as TicketMessage[];
  },

  /**
   * Send a message on a ticket.
   */
  async sendMessage(params: {
    ticket_id: string;
    sender_id: string;
    message: string;
    is_admin?: boolean;
  }): Promise<TicketMessage> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ticket_messages')
      .insert({
        ticket_id: params.ticket_id,
        sender_id: params.sender_id,
        message: params.message,
        is_admin: params.is_admin ?? false,
      })
      .select()
      .single();
    if (error) throw error;
    return data as TicketMessage;
  },
};
