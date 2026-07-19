// Shared USD→CUP freshness guard for the payment/recharge Edge Functions.
//
// WHY THIS EXISTS
// The four payment EFs each had their own copy of `24 * 60 * 60 * 1000` compared
// against exchange_rates.created_at, and none of them read
// platform_config.exchange_rate_max_age_hours. That made the config look like an
// emergency lever it is NOT: during the 2026-07-15 FX outage, raising
// exchange_rate_max_age_hours would have done nothing to unblock recharges, while
// silently re-enabling revalue_anchored_wallets against a stale rate (that function
// DOES read the key). Someone reaching for it under pressure would have made things
// worse. One definition, one place.
//
// SAFETY: THE CONFIG CANNOT DISABLE THIS GUARD
// This guard protects money: the recharge path credits round(amount_usd * rate), so a
// stale rate mis-credits wallets. Two deliberate divergences from the DB-side
// get_fresh_exchange_rate():
//   1. get_fresh_exchange_rate() treats max_age = 0 as "no staleness check at all"
//      (`IF v_max_age > 0 AND ...`). Here, 0 / negative / NaN falls back to the 24h
//      DEFAULT instead. A config value must never be able to switch the money guard off.
//   2. The value is CLAMPED to [MIN, MAX] hours. Without a ceiling, making this
//      configurable would be a worse footgun than the hardcode it replaces — one typo
//      (2400 instead of 24) would let the platform credit wallets at a 100-day-old rate.
//
// Uses fetched_at (when the rate was actually observed upstream) rather than created_at
// (when the row was written), matching get_fresh_exchange_rate(). In practice they differ
// by milliseconds, but fetched_at is the honest one if a rate is ever backdated. A
// fetched_at in the FUTURE is treated as stale rather than as infinitely fresh.

const DEFAULT_MAX_AGE_HOURS = 24;
const MIN_MAX_AGE_HOURS = 1;
const MAX_MAX_AGE_HOURS = 72;

export interface FxFreshness {
  ok: boolean;
  rate?: number;
  ageHours?: number;
  maxAgeHours: number;
  reason?: 'no_rate' | 'stale' | 'error';
}

/** Spanish copy shown to the user. Kept identical to the pre-existing wording. */
export const FX_UNAVAILABLE_DETAIL =
  'Tipo de cambio USD→CUP no disponible o desactualizado. Intentalo más tarde.';

function resolveMaxAgeHours(raw: unknown): number {
  // platform_config.value is jsonb: a bare number arrives as number, but tolerate a
  // quoted string too since other keys in that table are stored both ways.
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/"/g, '').trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_AGE_HOURS;
  return Math.min(Math.max(n, MIN_MAX_AGE_HOURS), MAX_MAX_AGE_HOURS);
}

/**
 * Reads the current USD→CUP rate and enforces the freshness window.
 * FAILS CLOSED: any missing row, unreadable value, or thrown error yields ok:false.
 */
// deno-lint-ignore no-explicit-any
export async function getFreshFx(supabase: any): Promise<FxFreshness> {
  let maxAgeHours = DEFAULT_MAX_AGE_HOURS;
  try {
    const { data: cfgRow } = await supabase
      .from('platform_config').select('value').eq('key', 'exchange_rate_max_age_hours').maybeSingle();
    maxAgeHours = resolveMaxAgeHours(cfgRow?.value);

    const { data: rateRow } = await supabase
      .from('exchange_rates').select('usd_cup_rate, fetched_at, created_at').eq('is_current', true).maybeSingle();

    const rate = Number(rateRow?.usd_cup_rate);
    const stamp = rateRow?.fetched_at ?? rateRow?.created_at;
    if (!Number.isFinite(rate) || rate <= 0 || !stamp) {
      return { ok: false, maxAgeHours, reason: 'no_rate' };
    }

    // Math.abs: a future timestamp is stale, not infinitely fresh.
    const ageMs = Math.abs(Date.now() - new Date(stamp).getTime());
    const ageHours = ageMs / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > maxAgeHours) {
      return { ok: false, rate, ageHours, maxAgeHours, reason: 'stale' };
    }
    return { ok: true, rate, ageHours, maxAgeHours };
  } catch (err) {
    console.error('[fx-freshness] failing closed:', err);
    return { ok: false, maxAgeHours, reason: 'error' };
  }
}
