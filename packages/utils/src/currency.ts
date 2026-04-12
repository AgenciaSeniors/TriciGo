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
 * Format TriciCoin balance for wallet display.
 *
 *   formatTriciCoin(5000) → "5,000 TC"
 */
export function formatTriciCoin(amount: number): string {
  const formatted = Math.max(0, Math.round(safeNum(amount))).toLocaleString('es-CU');
  return `${formatted} TC`;
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
 * Convert TRC (= CUP) to USD using the exchange rate.
 *
 * @param trc - amount in TRC whole units (e.g. 500)
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
 */
export function serviceTypeToVehicleType(
  slug: string,
): 'triciclo' | 'moto' | 'auto' | null {
  if (slug.startsWith('triciclo')) return 'triciclo';
  if (slug.startsWith('moto')) return 'moto';
  if (slug.startsWith('auto')) return 'auto';
  return null;
}
