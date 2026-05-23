// ============================================================
// TriciGo — Currency Utilities
//
// Storage conventions (post-rebase):
//   TRC = whole units (INTEGER, 1 TRC = 1 CUP)
//   CUP = whole pesos (INTEGER, 500 = 500 CUP = 500 TRC)
//   USD = derived from exchange rate (1 USD = X CUP/TRC)
//
// Exchange: 1 TRC = 1 CUP.  USD conversion via eltoque rate.
// ============================================================

/** Default USD/CUP exchange rate used as fallback when API is unavailable. */
export const DEFAULT_EXCHANGE_RATE = 520;

/** Guard: return 0 for NaN, Infinity, or undefined values. */
function safeNum(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

// ──────────────────────────────────────────────
// TRC / CUP Formatting (1:1 peg)
// ──────────────────────────────────────────────

/**
 * Format TRC whole units for fare display.
 * Since 1 TRC = 1 CUP, amount is always an integer.
 *
 *   formatTRC(500) → "500 TRC"
 *   formatTRC(1500) → "1,500 TRC"
 */
export function formatTRC(amount: number): string {
  const formatted = Math.round(safeNum(amount)).toLocaleString('es-CU');
  return `${formatted} TRC`;
}

/**
 * Format TriciCoin balance for wallet display (legacy CUP-pegged unit).
 *
 *   formatTriciCoin(5000) → "5,000 TC"
 *
 * @deprecated for wallet balance headers post Wallet v2 phase 1 migration
 *  (00242). Use `formatTriciCoinUsd(usdCents)` for new surfaces. This
 *  helper stays in use for ride fares, platform-internal accounting,
 *  and any context where TC still represents CUP-pegged whole units.
 */
export function formatTriciCoin(amount: number): string {
  const formatted = Math.max(0, Math.round(safeNum(amount))).toLocaleString('es-CU');
  return `${formatted} TC`;
}

/**
 * Wallet v2 phase 2: format an USD-cents balance as the new TriciCoin
 * unit (1 TC ≡ 1 USD per spec §1).
 *
 *   formatTriciCoinUsd(1941)                 → "$19.41"
 *   formatTriciCoinUsd(1941, { withSymbol }) → "19.41 TC"
 *   formatTriciCoinUsd(1941, { compact })    → "$19" (rounded, for chips)
 *
 * For the dual-line header pattern, pair this with `formatCupApprox`:
 *   $19.41             ← formatTriciCoinUsd(1941)
 *   ≈ 10,287 CUP        ← formatCupApprox(1941, rate)
 */
export function formatTriciCoinUsd(
  usdCents: number,
  opts: { withSymbol?: boolean; compact?: boolean } = {},
): string {
  const usd = safeNum(usdCents) / 100;
  if (opts.compact) {
    const rounded = Math.round(usd);
    return opts.withSymbol ? `${rounded} TC` : `$${rounded}`;
  }
  const formatted = usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return opts.withSymbol ? `${formatted} TC` : `$${formatted}`;
}

/**
 * Wallet v2 phase 2: render the CUP equivalence of a USD-cents balance
 * at the current exchange rate. Used as the muted secondary line under
 * the primary USD figure.
 *
 *   formatCupApprox(1941, 530) → "≈ 10,287 CUP"
 */
export function formatCupApprox(usdCents: number, exchangeRate: number): string {
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) return '';
  const cup = Math.round((safeNum(usdCents) / 100) * exchangeRate);
  return `≈ ${cup.toLocaleString('es-CU')} CUP`;
}

/** USD-cents → numeric USD (e.g. 1941 → 19.41). */
export function centsToUsd(cents: number): number {
  return safeNum(cents) / 100;
}

/**
 * Format CUP whole pesos for display.
 *
 *   formatCUP(150) → "150 CUP"
 *   formatCUP(1500) → "1,500 CUP"
 */
export function formatCUP(cupPesos: number): string {
  const formatted = Math.round(cupPesos).toLocaleString('es-CU');
  return `${formatted} CUP`;
}

// ──────────────────────────────────────────────
// USD Formatting & Conversion (via exchange rate)
// ──────────────────────────────────────────────

/**
 * Convert CUP (whole pesos) to USD using the exchange rate.
 *
 * Use this for ANY display that shows the "USD equivalent" of a fare,
 * balance, or transaction amount. The formula is just `cup / rate`.
 *
 * IMPORTANT — prefer this over `trcToUsd()` when the source value comes
 * from `rides.final_fare_*` columns. Since the Wallet v2 migration
 * (~2026-04-08), the `complete_ride_and_pay` RPC writes
 * `rides.final_fare_trc` as **USD-cents** (via the SQL helper
 * `cup_to_trc_centavos`), NOT as CUP-pegged 1:1. Dividing USD-cents
 * by the exchange rate gives ~5.5× wrong USD. `final_fare_cup` is
 * always genuine CUP and safe to pass here in both regimes.
 *
 * @param cup - amount in CUP whole pesos (e.g. 1440)
 * @param exchangeRate - 1 USD = X CUP (e.g. 555)
 * @returns USD amount (e.g. 1440/555 = 2.5946)
 */
export function cupToUsd(cup: number, exchangeRate: number): number {
  if (!Number.isFinite(cup) || exchangeRate <= 0 || !Number.isFinite(exchangeRate)) return 0;
  return cup / exchangeRate;
}

/**
 * Convert TRC to USD using the exchange rate.
 *
 * @deprecated For fare display, prefer `cupToUsd(final_fare_cup, rate)`.
 * Since the Wallet v2 migration (~2026-04-08), `rides.final_fare_trc`
 * is stored as USD-cents (not CUP-pegged 1:1), so this function gives
 * ~5.5× wrong result when called with `final_fare_trc`. Safe to use
 * with values that ARE genuinely CUP-pegged TRC: `estimated_fare_trc`,
 * `wallet_accounts.balance` (legacy), or any TRC where 1 TRC = 1 CUP.
 *
 * @param trc - amount in TRC whole units, assumed CUP-pegged 1:1
 * @param exchangeRate - 1 USD = X CUP/TRC (e.g. 520)
 * @returns USD amount (e.g. 500/520 = 0.9615)
 */
export function trcToUsd(trc: number, exchangeRate: number): number {
  if (!Number.isFinite(trc) || exchangeRate <= 0 || !Number.isFinite(exchangeRate)) return 0;
  return trc / exchangeRate;
}

/**
 * Convert USD to TRC (= CUP) using the exchange rate.
 *
 * @param usd - amount in USD (e.g. 9.62)
 * @param exchangeRate - 1 USD = X CUP/TRC (e.g. 520)
 * @returns TRC whole units (e.g. 9.62 × 520 = 5002)
 */
export function usdToTrc(usd: number, exchangeRate: number): number {
  if (!Number.isFinite(usd) || !Number.isFinite(exchangeRate)) return 0;
  return Math.round(usd * exchangeRate);
}

/**
 * Format a USD amount for display.
 *
 *   formatUSD(0.96) → "$0.96"
 *   formatUSD(9.62) → "$9.62"
 *   formatUSD(1500) → "$1,500.00"
 */
export function formatUSD(usd: number): string {
  return `$${safeNum(usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format TRC amount as its USD equivalent.
 *
 * @param trc - amount in TRC whole units
 * @param exchangeRate - 1 USD = X CUP/TRC
 *
 *   formatTRCasUSD(500, 520) → "$0.96"
 */
export function formatTRCasUSD(trc: number, exchangeRate: number): string {
  return formatUSD(trcToUsd(trc, exchangeRate));
}

// ──────────────────────────────────────────────
// Multi-Currency Display
// ──────────────────────────────────────────────

/**
 * Format an amount in all three currencies simultaneously.
 * Since TRC = CUP (1:1), both show the same number.
 *
 * @param amount - amount in TRC/CUP whole units
 * @param exchangeRate - 1 USD = X CUP/TRC (e.g. 520)
 *
 *   formatMultiCurrency(500, 520) → "500 TRC / 500 CUP / $0.96 USD"
 */
export function formatMultiCurrency(amount: number, exchangeRate: number): string {
  const trc = formatTRC(amount);
  const cup = formatCUP(amount);
  const usd = formatTRCasUSD(amount, exchangeRate);
  return `${trc} / ${cup} / ${usd}`;
}

/**
 * Get all three currency representations as an object.
 * Useful for UI components that display them separately.
 */
export function getMultiCurrencyValues(
  amount: number,
  exchangeRate: number,
): { trc: string; cup: string; usd: string; usdRaw: number } {
  return {
    trc: formatTRC(amount),
    cup: formatCUP(amount),
    usd: formatTRCasUSD(amount, exchangeRate),
    usdRaw: trcToUsd(amount, exchangeRate),
  };
}

// ──────────────────────────────────────────────
// TRC ↔ CUP Conversion (identity — 1:1 peg)
// ──────────────────────────────────────────────

/**
 * Convert CUP to TRC. Since 1 TRC = 1 CUP, returns the same value.
 * Kept for semantic clarity in code.
 */
export function cupToTrc(cupPesos: number): number {
  return cupPesos;
}

/**
 * Convert TRC to CUP. Since 1 TRC = 1 CUP, returns the same value.
 * Kept for semantic clarity in code.
 */
export function trcToCup(trc: number): number {
  return trc;
}

// ──────────────────────────────────────────────
// Legacy Compatibility
// ──────────────────────────────────────────────

/**
 * @deprecated TRC no longer uses centavos. Use whole units directly.
 * Kept temporarily for migration. Will be removed.
 */
export function centavosToUnits(centavos: number): number {
  return centavos / 100;
}

/**
 * @deprecated TRC no longer uses centavos. Use whole units directly.
 * Kept temporarily for migration. Will be removed.
 */
export function unitsToCentavos(units: number): number {
  return Math.round(units * 100);
}

/**
 * @deprecated Use cupToTrc() instead. CUP/TRC are now 1:1.
 */
export function cupToTrcCentavos(cupPesos: number, exchangeRate: number): number {
  // Legacy: convert CUP to old TRC centavos — now just returns CUP since 1:1
  return cupPesos;
}

/**
 * @deprecated Use trcToCup() instead. CUP/TRC are now 1:1.
 */
export function trcCentavosToCupPesos(trcCentavos: number, exchangeRate: number): number {
  // Legacy: was centavos-based — now just identity
  return trcCentavos;
}

/**
 * @deprecated Use formatTriciCoin() or formatTRC() instead.
 */
export function formatCurrency(
  amount: number,
  options: {
    symbol?: string;
    showSymbol?: boolean;
    locale?: string;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
  } = {},
): string {
  const {
    symbol = 'TC',
    showSymbol = true,
    locale = 'es-CU',
    minimumFractionDigits = 0,
    maximumFractionDigits = 0,
  } = options;

  const formatted = Math.round(amount).toLocaleString(locale, {
    minimumFractionDigits,
    maximumFractionDigits,
  });

  if (!showSymbol) return formatted;
  return `${formatted} ${symbol}`;
}

// ──────────────────────────────────────────────
// RECARGA V2 — wallet recharge fee math
// ──────────────────────────────────────────────

/** Fee percentage (RECARGA V2 — additive on top of the net amount). */
export const RECHARGE_FEE_PCT = 0.03;
/** Floor on the fee so micro-recharges remain economically viable. */
export const RECHARGE_FEE_MIN_USD = 0.5;

/** Recarga V2 per-customer-tier amount limits (USD). */
export const RECHARGE_LIMITS = {
  customer: { min: 20, max: 500 },
  corporate: { min: 100, max: 10_000 },
} as const;

/**
 * Compute the additive service fee for a wallet recharge of `amountUsd`.
 * Mirror of the math in `create-netopia-payment-intent`. Kept here so
 * UI previews (web wallet, client mobile, driver mobile) and the
 * receipt fallback all agree on the same number to the cent.
 *
 *   computeRechargeFeeUsd(20)   → 0.60
 *   computeRechargeFeeUsd(10)   → 0.50   (floor)
 *   computeRechargeFeeUsd(0)    → 0.50   (floor — guard before callers anyway)
 *   computeRechargeFeeUsd(NaN)  → 0      (safe under bad input)
 */
export function computeRechargeFeeUsd(amountUsd: number): number {
  const amt = safeNum(amountUsd);
  if (amt <= 0) return 0;
  return Math.max(Number((amt * RECHARGE_FEE_PCT).toFixed(2)), RECHARGE_FEE_MIN_USD);
}

/**
 * Total to charge the card given the user-picked NET amount. Additive
 * model — `amountUsd + fee`. Returned rounded to cents.
 *
 *   computeRechargeChargeUsd(20) → 20.60
 */
export function computeRechargeChargeUsd(amountUsd: number): number {
  const fee = computeRechargeFeeUsd(amountUsd);
  return Number((safeNum(amountUsd) + fee).toFixed(2));
}

// ──────────────────────────────────────────────
// Driver Rate Validation
// ──────────────────────────────────────────────

/**
 * Validate a driver's custom per-km rate (CUP/TRC whole units) against the default and max multiplier.
 */
export function validateDriverRate(
  customRate: number,
  defaultRate: number,
  maxMultiplier: number,
): { valid: boolean; clampedRate: number; error?: string } {
  if (customRate < defaultRate) {
    return { valid: false, clampedRate: defaultRate, error: 'below_minimum' };
  }
  const maxRate = Math.round(defaultRate * maxMultiplier);
  if (customRate > maxRate) {
    return { valid: false, clampedRate: maxRate, error: 'above_maximum' };
  }
  return { valid: true, clampedRate: customRate };
}

// ──────────────────────────────────────────────
// Service Type → Vehicle Type Mapping
// ──────────────────────────────────────────────

/**
 * Map ServiceTypeSlug to VehicleType for filtering.
 *
 * 00263: 'auto_confort' resolves to 'confort' so the client UI
 * (eta-by-vehicle, nearby filters) can distinguish premium from
 * basic supply — matches the strict mapping in find_best_drivers.
 */
export function serviceTypeToVehicleType(
  slug: string,
): 'triciclo' | 'moto' | 'auto' | 'confort' | null {
  if (slug.startsWith('triciclo')) return 'triciclo';
  if (slug.startsWith('moto')) return 'moto';
  if (slug === 'auto_confort') return 'confort';
  if (slug.startsWith('auto')) return 'auto';
  return null;
}
