// ============================================================
// TriciGo — Payment Service
// Client-side service for TropiPay payment operations.
// Creates payment links via edge function and tracks intents.
// ============================================================

import type { PaymentIntent } from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const paymentService = {
  /**
   * Create a TropiPay payment link for wallet recharge.
   * Calls the create-tropipay-link edge function which handles
   * TropiPay API authentication and payment card creation.
   */
  async createRechargeLink(
    userId: string,
    amountCup: number,
  ): Promise<{ paymentUrl: string; shortUrl: string; intentId: string }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke('create-tropipay-link', {
      body: { user_id: userId, amount_cup: amountCup },
    });
    if (error) throw error;
    return data as { paymentUrl: string; shortUrl: string; intentId: string };
  },

  /**
   * Create a TropiPay payment link for corporate wallet recharge.
   * Same flow as personal recharge but targets the corporate wallet.
   */
  async createCorporateRechargeLink(
    corporateAccountId: string,
    amountCup: number,
    userId: string,
  ): Promise<{ paymentUrl: string; shortUrl: string; intentId: string }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke('create-tropipay-link', {
      body: {
        user_id: userId,
        amount_cup: amountCup,
        corporate_account_id: corporateAccountId,
      },
    });
    if (error) throw error;
    return data as { paymentUrl: string; shortUrl: string; intentId: string };
  },

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

  /**
   * Create a TropiPay payment link for a completed ride.
   * Calls the create-ride-payment-link edge function which handles
   * TropiPay API authentication and payment card creation.
   */
  async createRidePaymentLink(
    rideId: string,
  ): Promise<{
    paymentUrl: string;
    shortUrl: string;
    intentId: string;
    amountCup: number;
    amountUsd: number;
  }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke('create-ride-payment-link', {
      body: { ride_id: rideId },
    });
    if (error) throw error;
    return data as {
      paymentUrl: string;
      shortUrl: string;
      intentId: string;
      amountCup: number;
      amountUsd: number;
    };
  },
};
