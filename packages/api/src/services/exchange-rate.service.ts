// ============================================================
// TriciGo — Exchange Rate Service
// Fetches and caches the current USD/CUP exchange rate.
// ============================================================

import type { ExchangeRate } from '@tricigo/types';
import { DEFAULT_EXCHANGE_RATE } from '@tricigo/utils';
import { getSupabaseClient } from '../client';

// In-memory cache (5 min TTL)
let cachedRate: number | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const exchangeRateService = {
  /**
   * Get the current exchange rate record from the database.
   */
  async getCurrentRate(): Promise<ExchangeRate> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('exchange_rates')
      .select('*')
      .eq('is_current', true)
      .single();
    if (error) throw error;
    return data as ExchangeRate;
  },

  /**
   * Get just the numeric USD/CUP rate, with in-memory cache.
   * Returns e.g. 520 (meaning 1 USD = 520 CUP).
   */
  async getUsdCupRate(): Promise<number> {
    const now = Date.now();
    if (cachedRate !== null && now - cacheTimestamp < CACHE_TTL_MS) {
      return cachedRate;
    }

    try {
      const rate = await this.getCurrentRate();
      cachedRate = rate.usd_cup_rate;
      cacheTimestamp = now;
      return cachedRate;
    } catch {
      // Fallback: try platform_config
      try {
        const supabase = getSupabaseClient();
        const { data } = await supabase
          .from('platform_config')
          .select('value')
          .eq('key', 'exchange_rate_fallback_cup')
          .single();
        const fallback = Number(data?.value ?? DEFAULT_EXCHANGE_RATE);
        cachedRate = fallback;
        cacheTimestamp = now;
        return fallback;
      } catch {
        return cachedRate ?? DEFAULT_EXCHANGE_RATE; // Ultimate fallback
      }
    }
  },

  /**
   * Get exchange rate history (for admin dashboard).
   */
  async getRateHistory(limit = 50): Promise<ExchangeRate[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('exchange_rates')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as ExchangeRate[];
  },

  /**
   * Set a manual exchange rate (admin override).
   * Creates a new exchange_rates row and toggles is_current.
   */
  async setManualRate(usdCupRate: number): Promise<void> {
    const supabase = getSupabaseClient();

    // Unset the current rate
    await supabase
      .from('exchange_rates')
      .update({ is_current: false })
      .eq('is_current', true);

    // Insert new manual rate
    const { error } = await supabase
      .from('exchange_rates')
      .insert({
        source: 'manual',
        usd_cup_rate: usdCupRate,
        fetched_at: new Date().toISOString(),
        is_current: true,
      });
    if (error) throw error;

    // Invalidate cache
    cachedRate = usdCupRate;
    cacheTimestamp = Date.now();
  },

  /**
   * Convert a TRC/CUP amount to USD using the cached exchange rate.
   * Convenience method for UI display.
   *
   * @param trcAmount - amount in TRC whole units (= CUP)
   * @returns USD amount (e.g. 500 TRC / 520 = 0.96)
   */
  async trcToUsd(trcAmount: number): Promise<number> {
    const rate = await this.getUsdCupRate();
    if (rate <= 0) return 0;
    return Math.round((trcAmount / rate) * 100) / 100;
  },

  /**
   * Convert a USD amount to TRC/CUP using the cached exchange rate.
   *
   * @param usdAmount - amount in USD (e.g. 9.62)
   * @returns TRC whole units (e.g. 9.62 * 520 = 5002)
   */
  async usdToTrc(usdAmount: number): Promise<number> {
    const rate = await this.getUsdCupRate();
    return Math.round(usdAmount * rate);
  },

  /**
   * Invalidate the in-memory cache (e.g. after edge function sync).
   */
  invalidateCache(): void {
    cachedRate = null;
    cacheTimestamp = 0;
  },
};
