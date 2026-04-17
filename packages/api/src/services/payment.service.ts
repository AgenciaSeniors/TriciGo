// ============================================================
// TriciGo — Payment Service
// Client-side service for payment operations.
// Tracks payment intents and initiates Stripe recharges.
// ============================================================

import type { PaymentIntent, CreateStripeIntentResponse, StripeRechargeConfig } from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { logger } from '@tricigo/utils';

export const paymentService = {
  /**
   * Get a single payment intent by ID (to check status after payment).
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
   * Get pending/created intents for a user.
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

  // ==================== STRIPE ====================

  /**
   * Create a Stripe PaymentIntent via the edge function.
   * Returns the client_secret for Stripe Elements to confirm payment.
   */
  async createStripePaymentIntent(
    userId: string,
    amountCup: number,
    rechargeType: 'customer' | 'driver_quota' = 'customer',
    corporateAccountId?: string,
  ): Promise<CreateStripeIntentResponse> {
    const supabase = getSupabaseClient();
    const { data: { session } } = await supabase.auth.getSession();

    const supabaseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl
      ?? process.env.NEXT_PUBLIC_SUPABASE_URL
      ?? process.env.EXPO_PUBLIC_SUPABASE_URL
      ?? '';

    const res = await fetch(`${supabaseUrl}/functions/v1/create-stripe-payment-intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token ?? ''}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
          ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
          ?? '',
      },
      body: JSON.stringify({
        user_id: userId,
        amount_cup: amountCup,
        recharge_type: rechargeType,
        corporate_account_id: corporateAccountId,
      }),
    });

    const json = await res.json();
    if (!res.ok || !json.ok) {
      const errorMsg = json.detail ?? json.error ?? 'Failed to create payment intent';
      logger.error('stripe_create_intent_failed', { userId, amountCup, error: errorMsg });
      throw new Error(errorMsg);
    }

    logger.info('stripe_intent_created', { userId, amountCup, intentId: json.intentId });
    return json as CreateStripeIntentResponse;
  },

  /**
   * Poll a payment intent status until completed or failed.
   * Useful after Stripe Elements confirms — wait for webhook to process.
   */
  async pollIntentStatus(
    intentId: string,
    maxAttempts = 15,
    intervalMs = 2000,
  ): Promise<PaymentIntent> {
    for (let i = 0; i < maxAttempts; i++) {
      const intent = await this.getPaymentIntent(intentId);
      if (!intent) throw new Error('Payment intent not found');

      if (intent.status === 'completed' || intent.status === 'failed' || intent.status === 'refunded') {
        return intent;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    // Return last known state
    const intent = await this.getPaymentIntent(intentId);
    if (!intent) throw new Error('Payment intent not found');
    return intent;
  },

  /**
   * Get Stripe recharge configuration from platform_config.
   */
  async getStripeConfig(): Promise<StripeRechargeConfig> {
    const supabase = getSupabaseClient();
    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', [
        'stripe_enabled',
        'stripe_publishable_key',
        'stripe_min_recharge_cup',
        'stripe_max_recharge_cup',
        'stripe_fee_usd',
        'stripe_fee_type',
      ]);

    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => {
      const raw = c.value;
      configMap[c.key] = typeof raw === 'string' && raw.startsWith('"')
        ? JSON.parse(raw)
        : String(raw);
    });

    return {
      enabled: configMap['stripe_enabled'] !== 'false',
      publishableKey: configMap['stripe_publishable_key'] ?? '',
      minRechargeCup: parseInt(configMap['stripe_min_recharge_cup'] ?? '500', 10),
      maxRechargeCup: parseInt(configMap['stripe_max_recharge_cup'] ?? '50000', 10),
      feeUsd: parseFloat(configMap['stripe_fee_usd'] ?? '2.00'),
      feeType: (configMap['stripe_fee_type'] as 'fixed' | 'percentage') ?? 'fixed',
    };
  },
};
