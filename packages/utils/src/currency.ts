// ============================================================
// TriciGo — Currency Utilities
//
// Storage conventions:
//   TRC = centavos (INTEGER, 100 centavos = 1.00 TRC = $1.00 USD)
//   CUP = whole pesos (INTEGER, 150 = 150 CUP) — Cuba no usa centavos
//
// Exchange: 1 TRC = 1 USD.  CUP/TRC conversion via exchange rate.
// ============================================================

const CENTAVOS_PER_UNIT = 100;

/**
 * Convert centavos to display units (e.g., 2500 → 25.00)
 */
export function centavosToUnits(centavos: number): number {
  return centavos / CENTAVOS_PER_UNIT;
}

/**
 * Convert display units to centavos (e.g., 25.00 → 2500)
 */
export function unitsToCentavos(units: number): number {
  return Math.round(units * CENTAVOS_PER_UNIT);
}

/**
 * Format centavos as a currency string for display.
 * Examples:
 *   formatCurrency(2500) → "25.00 TC"
 *   formatCurrency(2500, { symbol: '$', showSymbol: true }) → "$25.00"
 */
export function formatCurrency(
  centavos: number,
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
    minimumFractionDigits = 2,
    maximumFractionDigits = 2,
  } = options;

  const units = centavosToUnits(centavos);
  const formatted = units.toLocaleString(locale, {
    minimumFractionDigits,
    maximumFractionDigits,
  });

  if (!showSymbol) return formatted;
  return `${formatted} ${symbol}`;
}

/**
 * Format TriciCoin balance for wallet display.
 * Examples:
 *   formatTriciCoin(250000) → "2,500.00 TC"
 */
export function formatTriciCoin(centavos: number): string {
  return formatCurrency(centavos, { symbol: 'TC' });
}

/**
 * Format TRC centavos for fare display.
 * Examples:
 *   formatTRC(250) → "2.50 TRC"
 *   formatTRC(100) → "1.00 TRC"
 */
export function formatTRC(centavos: number): string {
  return formatCurrency(centavos, { symbol: 'TRC' });
}

/**
 * Convert TRC centavos to USD equivalent.
 * Legacy: kept for backward compatibility.
 * Note: 1 TRC = 1 CUP. USD conversion uses exchange rate.
 */
export function trcToUSD(centavos: number): number {
  return centavos / 100;
}

/**
 * Format TRC centavos as USD for display.
 *   formatTRCasUSD(144) → "$1.44"
 */
export function formatTRCasUSD(centavos: number): string {
  const usd = trcToUSD(centavos);
  return `$${usd.toFixed(2)}`;
}

// ──────────────────────────────────────────────
// CUP ↔ TRC Conversion (via exchange rate)
// ──────────────────────────────────────────────

/**
 * Convert CUP whole pesos to TRC centavos using the exchange rate.
 *
 * @param cupPesos - amount in CUP whole pesos (e.g. 750)
 * @param exchangeRate - 1 USD = X CUP (e.g. 520)
 * @returns TRC centavos (e.g. 750/520*100 = 144)
 *
 * Example: cupToTrcCentavos(750, 520) → 144  (750 CUP = 1.44 TRC)
 */
export function cupToTrcCentavos(cupPesos: number, exchangeRate: number): number {
  if (exchangeRate <= 0) return 0;
  return Math.round((cupPesos / exchangeRate) * 100);
}

/**
 * Convert TRC centavos to CUP whole pesos using the exchange rate.
 *
 * @param trcCentavos - amount in TRC centavos (e.g. 144)
 * @param exchangeRate - 1 USD = X CUP (e.g. 520)
 * @returns CUP whole pesos (e.g. 144/100*520 = 749)
 */
export function trcCentavosToCupPesos(trcCentavos: number, exchangeRate: number): number {
  return Math.round((trcCentavos / 100) * exchangeRate);
}

/**
 * Format CUP whole pesos for display.
 *   formatCUP(150) → "150 CUP"
 *   formatCUP(1500) → "1,500 CUP"
 */
export function formatCUP(cupPesos: number): string {
  const formatted = Math.round(cupPesos).toLocaleString('es-CU');
  return `${formatted} CUP`;
}

// ──────────────────────────────────────────────
// Driver Rate Validation
// ──────────────────────────────────────────────

/**
 * Validate a driver's custom per-km rate (CUP whole pesos) against the default and max multiplier.
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
