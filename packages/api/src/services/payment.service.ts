// ============================================================
// TriciGo — Payment Service
// Client-side service for payment operations.
// Tracks payment intents and history.
// TODO: Replace with Stripe PaymentIntent creation
// ============================================================

import type { PaymentIntent } from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const paymentService = {
  /**
   * Get a single payment intent by ID (to check status after redirect).
   */
  async getPaymentIntent(intentId: string): Promise<PaymentIntent | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('payment_intents')
      .select('*')
      .eq('id', intentId)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data as PaymentIntent | null;
  },

  /**
   * Get payment history for a user (paginated, newest first).
   */
  async getPaymentHistory(
    userId: string,
    page = 0,
    pageSize = 20,
  ): Promise<PaymentIntent[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('payment_intents')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as PaymentIntent[];
  },

  /**
   * Get pending/created intents for a user (useful for checking
   * if there's an open payment link the user hasn't completed).
   */
  async getPendingIntents(userId: string): Promise<PaymentIntent[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('payment_intents')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['created', 'pending'])
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    return data as PaymentIntent[];
  },

};
