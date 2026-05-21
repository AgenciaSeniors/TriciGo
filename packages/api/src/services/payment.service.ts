// ============================================================
// TriciGo — Payment Service
// Client-side service for payment operations.
// Tracks payment intents and initiates wallet recharges through a
// payment provider. The recharge flow is provider-agnostic; see
// docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md.
//
// NETOPIA is the sole live provider after the 2026-05-20 cutover.
// EuPlatesc is reserved for Phase D3. The Stripe wrappers
// (createStripePaymentIntent / getStripeConfig) were removed in
// the same cutover; callers use createRechargeIntent directly.
// ============================================================

import type {
  PaymentIntent,
  PaymentProvider,
  RechargeIntentRequest,
  RechargeIntentResult,
  PaymentProviderConfig,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { logger } from '@tricigo/utils';

/** Providers that have (or will have) a real recharge integration. */
const KNOWN_PROVIDERS: PaymentProvider[] = ['netopia', 'euplatesc'];

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

  // ==================== RECHARGE INTENTS ====================

  /**
   * Create a wallet recharge intent through a payment provider.
   * Provider-agnostic: routes to the `create-<provider>-payment-intent`
   * edge function. See docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md.
   */
  async createRechargeIntent(req: RechargeIntentRequest): Promise<RechargeIntentResult> {
    const supabase = getSupabaseClient();
    const { data: { session } } = await supabase.auth.getSession();

    const supabaseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl
      ?? process.env.NEXT_PUBLIC_SUPABASE_URL
      ?? process.env.EXPO_PUBLIC_SUPABASE_URL
      ?? '';

    const res = await fetch(`${supabaseUrl}/functions/v1/create-${req.provider}-payment-intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token ?? ''}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
          ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
          ?? '',
      },
      body: JSON.stringify({
        user_id: req.userId,
        amount_cup: req.amountCup,
        recharge_type: req.rechargeType ?? 'customer',
        corporate_account_id: req.corporateAccountId,
        device_fingerprint: req.deviceFingerprint,
        return_url_base: req.returnUrl,
        language: req.language,
      }),
    });

    const json = await res.json();
    if (!res.ok || !json.ok) {
      const errorMsg = json.detail ?? json.error ?? 'Failed to create recharge intent';
      logger.error('recharge_intent_failed', {
        provider: req.provider,
        userId: req.userId,
        amountCup: req.amountCup,
        error: errorMsg,
      });
      throw new Error(errorMsg);
    }

    logger.info('recharge_intent_created', {
      provider: req.provider,
      userId: req.userId,
      amountCup: req.amountCup,
      intentId: json.intentId,
    });
    return { ...json, provider: req.provider } as RechargeIntentResult;
  },

  /**
   * Poll a payment intent status until completed or failed.
   * Useful after the checkout UI confirms — wait for the webhook.
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

  // ==================== PROVIDER CONFIG ====================

  /**
   * Get recharge configuration for a payment provider from platform_config.
   * Reads the provider-namespaced keys `<provider>_enabled`,
   * `<provider>_publishable_key`, `<provider>_min_recharge_cup`, etc.
   */
  async getPaymentProviderConfig(provider: PaymentProvider): Promise<PaymentProviderConfig> {
    const supabase = getSupabaseClient();
    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', [
        `${provider}_enabled`,
        `${provider}_publishable_key`,
        `${provider}_min_recharge_cup`,
        `${provider}_max_recharge_cup`,
        `${provider}_fee_usd`,
        `${provider}_fee_type`,
      ]);

    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => {
      const raw = c.value;
      configMap[c.key] = typeof raw === 'string' && raw.startsWith('"')
        ? JSON.parse(raw)
        : String(raw);
    });

    return {
      provider,
      enabled: configMap[`${provider}_enabled`] !== 'false',
      publishableKey: configMap[`${provider}_publishable_key`] ?? '',
      minRechargeCup: parseInt(configMap[`${provider}_min_recharge_cup`] ?? '500', 10),
      maxRechargeCup: parseInt(configMap[`${provider}_max_recharge_cup`] ?? '50000', 10),
      feeUsd: parseFloat(configMap[`${provider}_fee_usd`] ?? '2.00'),
      feeType: (configMap[`${provider}_fee_type`] as 'fixed' | 'percentage') ?? 'fixed',
    };
  },

  /**
   * The payment provider currently selected for new recharges
   * (platform_config.active_payment_provider; defaults to 'netopia').
   */
  async getActivePaymentProvider(): Promise<PaymentProvider> {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('platform_config')
      .select('value')
      .eq('key', 'active_payment_provider')
      .maybeSingle();
    const raw = (data as { value?: unknown } | null)?.value;
    const parsed = typeof raw === 'string' && raw.startsWith('"') ? JSON.parse(raw) : raw;
    return (typeof parsed === 'string' ? parsed : 'netopia') as PaymentProvider;
  },

  /**
   * Payment providers currently enabled for recharges.
   */
  async getEnabledPaymentProviders(): Promise<PaymentProvider[]> {
    const configs = await Promise.all(
      KNOWN_PROVIDERS.map((p) => this.getPaymentProviderConfig(p)),
    );
    return configs.filter((c) => c.enabled).map((c) => c.provider);
  },
};
