// ============================================================
// TriciGo — Support Service
// Support ticket CRUD, messaging and the support WhatsApp numbers.
// ============================================================

import type {
  SupportTicket,
  TicketMessage,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '@tricigo/types';
import { resolveSupportPhones, SUPPORT_PHONES_CONFIG_KEY, SUPPORT_WHATSAPP_PHONES } from '@tricigo/utils';
import { getSupabaseClient } from '../client';
import { validate, createTicketSchema } from '../schemas';

export const supportService = {
  // ==================== TICKETS ====================

  /**
   * Create a new support ticket.
   *
   * Validates against `createTicketSchema` first: `support_tickets.category`
   * is free TEXT with no CHECK constraint and `getSupabaseClient()` is
   * untyped, so nothing else stops a category outside the `TicketCategory`
   * union (or a malformed id) from being written verbatim and then rendering
   * as unknown in the admin filters and label map.
   */
  async createTicket(params: {
    user_id: string;
    ride_id?: string;
    category: TicketCategory;
    subject: string;
    description?: string;
  }): Promise<SupportTicket> {
    const validParams = validate(createTicketSchema, params);
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('support_tickets')
      .insert({
        user_id: validParams.user_id,
        ride_id: validParams.ride_id ?? null,
        category: validParams.category,
        subject: validParams.subject,
        description: validParams.description ?? null,
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

  // ==================== CONTACT ====================

  /**
   * The support WhatsApp numbers, in order, from platform_config
   * (support_whatsapp_phones, 00682). Never throws and never empty: a missing
   * key, an invalid value or a failed read gives the built-in numbers, so a
   * help screen always has one to open.
   */
  async getWhatsAppPhones(): Promise<string[]> {
    try {
      const { data, error } = await getSupabaseClient()
        .from('platform_config')
        .select('value')
        .eq('key', SUPPORT_PHONES_CONFIG_KEY)
        .maybeSingle();
      if (error) return [...SUPPORT_WHATSAPP_PHONES];
      return resolveSupportPhones(data?.value);
    } catch {
      return [...SUPPORT_WHATSAPP_PHONES];
    }
  },
};
