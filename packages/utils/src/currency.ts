// ============================================================
// TriciGo — Currency Utilities
// All internal amounts are in centavos (100 centavos = 1 unit)
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
 * Format CUP amount for fare display.
 * Examples:
 *   formatCUP(5000) → "50.00 CUP"
 */
export function formatCUP(centavos: number): string {
  return formatCurrency(centavos, { symbol: 'CUP' });
}
