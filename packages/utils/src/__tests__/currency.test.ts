import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXCHANGE_RATE,
  formatTRC,
  formatTriciCoin,
  formatCUP,
  formatUSD,
  formatTRCasUSD,
  formatMultiCurrency,
  getMultiCurrencyValues,
  trcToUsd,
  usdToTrc,
  cupToTrc,
  trcToCup,
  cupToTrcCentavos,
  trcCentavosToCupPesos,
  centavosToUnits,
  unitsToCentavos,
  formatCurrency,
  validateDriverRate,
  serviceTypeToVehicleType,
} from '../currency';

// ============================================================
// Constants
// ============================================================
describe('DEFAULT_EXCHANGE_RATE', () => {
  it('is 520', () => {
    expect(DEFAULT_EXCHANGE_RATE).toBe(520);
  });
});

// ============================================================
// TRC / CUP Formatting (post-rebase: 1 TRC = 1 CUP, whole units)
// ============================================================
describe('formatTRC', () => {
  it('formats whole units with TRC suffix', () => {
    expect(formatTRC(500)).toContain('500');
    expect(formatTRC(500)).toContain('TRC');
  });

  it('formats large numbers with locale separators', () => {
    const result = formatTRC(1500);
    expect(result).toContain('TRC');
  });

  it('formats zero', () => {
    expect(formatTRC(0)).toContain('0');
    expect(formatTRC(0)).toContain('TRC');
  });

  it('rounds decimals', () => {
    expect(formatTRC(499.7)).toContain('500');
  });

  it('handles NaN safely', () => {
    expect(formatTRC(NaN)).toContain('0');
    expect(formatTRC(NaN)).toContain('TRC');
  });

  it('handles Infinity safely', () => {
    expect(formatTRC(Infinity)).toContain('0');
  });
});

describe('formatTriciCoin', () => {
  it('formats with TC suffix', () => {
    const result = formatTriciCoin(5000);
    expect(result).toContain('TC');
  });

  it('handles NaN safely', () => {
    expect(formatTriciCoin(NaN)).toContain('0');
  });
});

describe('formatCUP', () => {
  it('formats CUP pesos with symbol', () => {
    expect(formatCUP(150)).toBe('150 CUP');
  });

  it('formats zero', () => {
    expect(formatCUP(0)).toBe('0 CUP');
  });

  it('rounds decimal pesos', () => {
    expect(formatCUP(150.7)).toBe('151 CUP');
  });
});

// ============================================================
// USD Formatting & Conversion
// ============================================================
describe('trcToUsd', () => {
  it('converts TRC to USD using exchange rate', () => {
    // 500 TRC / 520 rate ≈ 0.9615
    expect(trcToUsd(500, 520)).toBeCloseTo(0.9615, 3);
  });

  it('handles zero amount', () => {
    expect(trcToUsd(0, 520)).toBe(0);
  });

  it('returns 0 for zero exchange rate', () => {
    expect(trcToUsd(500, 0)).toBe(0);
  });

  it('returns 0 for negative exchange rate', () => {
    expect(trcToUsd(500, -1)).toBe(0);
  });

  it('returns 0 for NaN amount', () => {
    expect(trcToUsd(NaN, 520)).toBe(0);
  });

  it('returns 0 for NaN exchange rate', () => {
    expect(trcToUsd(500, NaN)).toBe(0);
  });

  it('returns 0 for Infinity exchange rate', () => {
    expect(trcToUsd(500, Infinity)).toBe(0);
  });
});

describe('usdToTrc', () => {
  it('converts USD to TRC (rounded)', () => {
    // $9.62 × 520 = 5002.4 → 5002
    expect(usdToTrc(9.62, 520)).toBe(5002);
  });

  it('handles zero', () => {
    expect(usdToTrc(0, 520)).toBe(0);
  });

  it('returns 0 for NaN', () => {
    expect(usdToTrc(NaN, 520)).toBe(0);
  });

  it('returns 0 for Infinity', () => {
    expect(usdToTrc(Infinity, 520)).toBe(0);
  });
});

describe('formatUSD', () => {
  it('formats USD with $ symbol and 2 decimals', () => {
    expect(formatUSD(0.96)).toBe('$0.96');
    expect(formatUSD(9.62)).toBe('$9.62');
    expect(formatUSD(0)).toBe('$0.00');
  });

  it('handles NaN safely', () => {
    expect(formatUSD(NaN)).toBe('$0.00');
  });
});

describe('formatTRCasUSD', () => {
  it('formats TRC amount as USD equivalent', () => {
    // 500 TRC / 520 = $0.96
    expect(formatTRCasUSD(500, 520)).toBe('$0.96');
  });

  it('formats zero', () => {
    expect(formatTRCasUSD(0, 520)).toBe('$0.00');
  });
});

// ============================================================
// Multi-Currency Display
// ============================================================
describe('formatMultiCurrency', () => {
  it('formats all three currencies', () => {
    const result = formatMultiCurrency(500, 520);
    expect(result).toContain('500 TRC');
    expect(result).toContain('500 CUP');
    expect(result).toContain('$0.96');
  });
});

describe('getMultiCurrencyValues', () => {
  it('returns all currency representations', () => {
    const result = getMultiCurrencyValues(500, 520);
    expect(result.trc).toContain('500 TRC');
    expect(result.cup).toContain('500 CUP');
    expect(result.usd).toContain('$0.96');
    expect(result.usdRaw).toBeCloseTo(0.9615, 3);
  });
});

// ============================================================
// TRC ↔ CUP (identity — 1:1 peg)
// ============================================================
describe('cupToTrc', () => {
  it('returns same value (identity, 1:1)', () => {
    expect(cupToTrc(500)).toBe(500);
    expect(cupToTrc(0)).toBe(0);
    expect(cupToTrc(1234)).toBe(1234);
  });
});

describe('trcToCup', () => {
  it('returns same value (identity, 1:1)', () => {
    expect(trcToCup(500)).toBe(500);
    expect(trcToCup(0)).toBe(0);
    expect(trcToCup(1234)).toBe(1234);
  });
});

// ============================================================
// Legacy Compatibility
// ============================================================
describe('centavosToUnits (deprecated)', () => {
  it('divides by 100', () => {
    expect(centavosToUnits(10000)).toBe(100);
    expect(centavosToUnits(0)).toBe(0);
  });
});

describe('unitsToCentavos (deprecated)', () => {
  it('multiplies by 100', () => {
    expect(unitsToCentavos(100)).toBe(10000);
    expect(unitsToCentavos(0)).toBe(0);
  });
});

describe('cupToTrcCentavos (deprecated)', () => {
  it('returns CUP value directly (identity, post-rebase)', () => {
    // Post-rebase: no longer divides by exchange rate
    expect(cupToTrcCentavos(750, 520)).toBe(750);
    expect(cupToTrcCentavos(0, 520)).toBe(0);
    expect(cupToTrcCentavos(500, 300)).toBe(500);
  });
});

describe('trcCentavosToCupPesos (deprecated)', () => {
  it('returns value directly (identity, post-rebase)', () => {
    expect(trcCentavosToCupPesos(144, 520)).toBe(144);
    expect(trcCentavosToCupPesos(0, 520)).toBe(0);
  });
});

describe('formatCurrency (deprecated)', () => {
  it('formats with default TC symbol', () => {
    const result = formatCurrency(2500);
    expect(result).toContain('TC');
    // Post-rebase: 2500 is whole units, not centavos
    expect(result).toContain('2');
  });

  it('formats without symbol when showSymbol is false', () => {
    const result = formatCurrency(2500, { showSymbol: false });
    expect(result).not.toContain('TC');
  });

  it('handles zero', () => {
    const result = formatCurrency(0);
    expect(result).toContain('0');
  });
});

// ============================================================
// validateDriverRate (whole CUP/TRC units)
// ============================================================
describe('validateDriverRate', () => {
  const defaultRate = 100; // 100 CUP/km
  const maxMultiplier = 2; // max 2x

  it('accepts rate within valid range', () => {
    const result = validateDriverRate(150, defaultRate, maxMultiplier);
    expect(result.valid).toBe(true);
    expect(result.clampedRate).toBe(150);
    expect(result.error).toBeUndefined();
  });

  it('accepts rate equal to default', () => {
    const result = validateDriverRate(100, defaultRate, maxMultiplier);
    expect(result.valid).toBe(true);
    expect(result.clampedRate).toBe(100);
  });

  it('accepts rate equal to max', () => {
    const result = validateDriverRate(200, defaultRate, maxMultiplier);
    expect(result.valid).toBe(true);
    expect(result.clampedRate).toBe(200);
  });

  it('rejects and clamps rate below minimum', () => {
    const result = validateDriverRate(50, defaultRate, maxMultiplier);
    expect(result.valid).toBe(false);
    expect(result.clampedRate).toBe(100);
    expect(result.error).toBe('below_minimum');
  });

  it('rejects and clamps rate above maximum', () => {
    const result = validateDriverRate(300, defaultRate, maxMultiplier);
    expect(result.valid).toBe(false);
    expect(result.clampedRate).toBe(200);
    expect(result.error).toBe('above_maximum');
  });

  it('works with different multipliers', () => {
    const result = validateDriverRate(250, 100, 3);
    expect(result.valid).toBe(true);
    expect(result.clampedRate).toBe(250);
  });

  it('rejects rate above max with 3x multiplier', () => {
    const result = validateDriverRate(350, 100, 3);
    expect(result.valid).toBe(false);
    expect(result.clampedRate).toBe(300);
    expect(result.error).toBe('above_maximum');
  });
});

// ============================================================
// serviceTypeToVehicleType
// ============================================================
describe('serviceTypeToVehicleType', () => {
  it('maps triciclo types', () => {
    expect(serviceTypeToVehicleType('triciclo_basico')).toBe('triciclo');
    expect(serviceTypeToVehicleType('triciclo_premium')).toBe('triciclo');
  });

  it('maps moto types', () => {
    expect(serviceTypeToVehicleType('moto_standard')).toBe('moto');
  });

  it('maps auto types', () => {
    expect(serviceTypeToVehicleType('auto_standard')).toBe('auto');
  });

  it('returns null for unknown types', () => {
    expect(serviceTypeToVehicleType('mensajeria')).toBeNull();
    expect(serviceTypeToVehicleType('unknown')).toBeNull();
  });
});
