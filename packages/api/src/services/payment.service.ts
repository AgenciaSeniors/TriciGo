// ============================================================
// TriciGo — Payment Service
// Client-side service for payment operations.
// Tracks payment intents and initiates wallet recharges through a
// payment provider. The recharge flow is provider-agnostic; see
// docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md.
//
// NETOPIA is the primary live provider after the 2026-05-20 cutover.
// EuPlatesc is reserved for Phase D3. Stripe is wired back in as the
// in-app recharge FALLBACK (NETOPIA is geo-blocked from Cuba): the
// recharge WebView re-creates the intent with provider='stripe' on a
// NETOPIA load failure. See create-stripe-payment-intent (authenticated
// self-recharge) and docs/superpowers/specs/2026-06-27-netopia-stripe-
// fallback-design.md. Callers use createRechargeIntent directly.
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

/**
 * Providers that have (or will have) a real recharge integration.
 * 'stripe' is the in-app fallback for NETOPIA; it stays OFF in
 * getEnabledPaymentProviders until platform_config.stripe_enabled='true'
 * (KYC + live keys), so listing it here doesn't expose it prematurely.
 */
const KNOWN_PROVIDERS: PaymentProvider[] = ['netopia', 'euplatesc', 'stripe'];

// ── Recharge create-intent timeout (PASS #3 resilience) ──
// createRechargeIntent runs behind the non-dismissable "Redirigiendo a pago
// seguro…" overlay (PR #699). On a stalled/half-open Cuban connection a bare
// fetch (no default timeout on React Native) can hang for the OS socket
// timeout — tens of seconds to minutes — trapping the user on that overlay
// with no escape (Android back is a no-op). The Supabase client's own fetch is
// already timeout-wrapped (see client.ts makeTimeoutFetch), but this path uses
// a BARE globalThis.fetch for the edge function call, so we bound it here.
// 30s matches client.ts READ_TIMEOUT_MS; tighter than the 120s upload backstop
// because creating an intent is a quick metadata op and the user is trapped.
const RECHARGE_INTENT_TIMEOUT_MS = 30_000;
const RECHARGE_TIMEOUT_MESSAGE =
  'La conexión tardó demasiado. Verifica tu red e intenta de nuevo.';

/**
 * Reject `promise` with a friendly timeout error if it doesn't settle within
 * `ms`. Used to bound `supabase.auth.getSession()` — its network refresh is
 * already timeout-wrapped at the client fetch layer, but this also guards the
 * GoTrue lock/initialize step, which can stall before any network call.
 */
function withRechargeTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(RECHARGE_TIMEOUT_MESSAGE)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

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
    const { data: { session } } = await withRechargeTimeout(
      supabase.auth.getSession(),
      RECHARGE_INTENT_TIMEOUT_MS,
    );

    const supabaseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl
      ?? process.env.NEXT_PUBLIC_SUPABASE_URL
      ?? process.env.EXPO_PUBLIC_SUPABASE_URL
      ?? '';

    // Bound the bare fetch with an AbortController so a stalled connection
    // surfaces as an error (caught upstream → overlay cleared) instead of
    // hanging behind the non-dismissable "Redirigiendo a pago seguro…" overlay.
    // The single timer covers both the request AND res.json() so the worst-case
    // trap time is the timeout, not 2× it.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RECHARGE_INTENT_TIMEOUT_MS);

    let json: { ok?: boolean; detail?: string; error?: string; intentId?: string } & Record<string, unknown>;
    let res: Response;
    try {
      res = await fetch(`${supabaseUrl}/functions/v1/create-${req.provider}-payment-intent`, {
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
          // RECARGA V2: send the NET USD the user picked; the edge function
          // computes the additive fee and tells NETOPIA the total charge.
          amount_usd: req.amountUsd,
          recharge_type: req.rechargeType ?? 'customer',
          corporate_account_id: req.corporateAccountId,
          device_fingerprint: req.deviceFingerprint,
          return_url_base: req.returnUrl,
          language: req.language,
        }),
        signal: controller.signal,
      });
      json = await res.json();
    } catch (err) {
      // An aborted fetch throws a terse AbortError ("Aborted"); translate our
      // own timeout into the friendly Spanish message instead of leaking it.
      if (timedOut) throw new Error(RECHARGE_TIMEOUT_MESSAGE);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !json.ok) {
      const errorMsg = json.detail ?? json.error ?? 'Failed to create recharge intent';
      logger.error('recharge_intent_failed', {
        provider: req.provider,
        userId: req.userId,
        amountUsd: req.amountUsd,
        error: errorMsg,
      });
      throw new Error(errorMsg);
    }

    logger.info('recharge_intent_created', {
      provider: req.provider,
      userId: req.userId,
      amountUsd: req.amountUsd,
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

  /**
   * NETOPIA in-app checkout proxy config (from platform_config). When enabled,
   * the mobile recharge WebView routes through the VPS CONNECT proxy so
   * NETOPIA's edge sees the clean VPS IP instead of a reputation-flagged user
   * IP (Cuban ETECSA otherwise gets a Google Cloud Armor 403 on the hosted
   * card page). Defaults: flag OFF — the caller then falls back to the
   * WebBrowser flow (exact pre-existing behavior) — and host/port = the
   * TriciGo VPS squid. See project_netopia_cuba_ip_block_tunnel.
   */
  async getNetopiaProxyConfig(): Promise<{
    enabled: boolean;
    host: string;
    port: number;
    /** Track 4b: optional 2nd CONNECT proxy the app retries once before the
     * browser fallback. Empty/0 = none (dormant until a 2nd proxy is provisioned
     * with the SAME hmac_secret, so the ephemeral token authenticates to both). */
    hostFallback: string;
    portFallback: number;
  }> {
    const DEFAULT_HOST = '187.77.214.236';
    const DEFAULT_PORT = 13128;
    // NOTE: proxy auth creds are intentionally NOT read from platform_config.
    // platform_config has a public SELECT RLS (any authed user can read every
    // row), so a static proxy password stored there would be client-readable —
    // an open-tunnel risk. Auth uses ONLY the short-lived ephemeral token from
    // mintNetopiaProxyCredential(). The squid still keeps a static htpasswd for
    // curl/dev smoke only; the app never sends it.
    try {
      const supabase = getSupabaseClient();
      const { data } = await supabase
        .from('platform_config')
        .select('key, value')
        .in('key', [
          'netopia_proxy_enabled',
          'netopia_proxy_host',
          'netopia_proxy_port',
          'netopia_proxy_host_fallback',
          'netopia_proxy_port_fallback',
        ]);
      const m: Record<string, string> = {};
      (data ?? []).forEach((c: { key: string; value: string }) => {
        const raw = c.value;
        m[c.key] = typeof raw === 'string' && raw.startsWith('"') ? JSON.parse(raw) : String(raw);
      });
      return {
        enabled: m['netopia_proxy_enabled'] === 'true',
        host: m['netopia_proxy_host'] || DEFAULT_HOST,
        port: parseInt(m['netopia_proxy_port'] ?? '', 10) || DEFAULT_PORT,
        hostFallback: m['netopia_proxy_host_fallback'] || '',
        portFallback: parseInt(m['netopia_proxy_port_fallback'] ?? '', 10) || 0,
      };
    } catch {
      return { enabled: false, host: DEFAULT_HOST, port: DEFAULT_PORT, hostFallback: '', portFallback: 0 };
    }
  },

  /**
   * Mint a SHORT-LIVED proxy credential for the in-app NETOPIA checkout WebView
   * (the `mint-netopia-proxy-credential` EF). This is the ONLY source of proxy
   * auth creds for the app (the static platform_config cred was removed — it was
   * client-readable). The squid validates this ephemeral HMAC token statelessly
   * and it expires (~10 min), so a leak isn't a standing tunnel. Returns null on
   * ANY failure (not logged in, EF absent/disabled, network) → the caller then
   * proceeds without proxy auth and the WebView's onError recovers to the browser.
   */
  async mintNetopiaProxyCredential(): Promise<{
    host: string;
    port: number;
    username: string;
    password: string;
    expiresAt: number;
  } | null> {
    try {
      const supabase = getSupabaseClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return null;
      const supabaseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl
        ?? process.env.NEXT_PUBLIC_SUPABASE_URL
        ?? process.env.EXPO_PUBLIC_SUPABASE_URL
        ?? '';
      const res = await fetch(`${supabaseUrl}/functions/v1/mint-netopia-proxy-credential`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
            ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
            ?? '',
        },
      });
      const json = await res.json();
      if (!res.ok || !json.ok || !json.username || !json.password) return null;
      return {
        host: String(json.host),
        port: Number(json.port),
        username: String(json.username),
        password: String(json.password),
        expiresAt: Number(json.expiresAt),
      };
    } catch {
      return null;
    }
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
