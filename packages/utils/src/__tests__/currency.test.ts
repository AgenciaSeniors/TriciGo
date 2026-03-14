import { describe, it, expect } from 'vitest';
import {
  centavosToUnits,
  unitsToCentavos,
  formatCurrency,
  formatTriciCoin,
  formatTRC,
  trcToUSD,
  formatTRCasUSD,
  cupToTrcCentavos,
  trcCentavosToCupPesos,
  formatCUP,
  validateDriverRate,
  serviceTypeToVehicleType,
} from '../currency';

// ============================================================
// centavosToUnits / unitsToCentavos
// ============================================================
describe('centavosToUnits', () => {
  it('converts centavos to units', () => {
    expect(centavosToUnits(10000)).toBe(100);
    expect(centavosToUnits(2500)).toBe(25);
    expect(centavosToUnits(1)).toBe(0.01);
  });

  it('handles zero', () => {
    expect(centavosToUnits(0)).toBe(0);
  });

  it('handles negative values', () => {
    expect(centavosToUnits(-500)).toBe(-5);
  });
});

describe('unitsToCentavos', () => {
  it('converts units to centavos', () => {
    expect(unitsToCentavos(100)).toBe(10000);
    expect(unitsToCentavos(25)).toBe(2500);
    expect(unitsToCentavos(0.01)).toBe(1);
  });

  it('rounds to nearest integer', () => {
    // Note: 1.005 * 100 = 100.49999... due to IEEE 754 floating point
    expect(unitsToCentavos(1.005)).toBe(100);
    expect(unitsToCentavos(1.006)).toBe(101); // 1.006 * 100 = 100.6 → 101
    expect(unitsToCentavos(1.004)).toBe(100); // 1.004 * 100 = 100.4 → 100
  });

  it('handles zero', () => {
    expect(unitsToCentavos(0)).toBe(0);
  });
});

// ============================================================
// formatCurrency
// ============================================================
describe('formatCurrency', () => {
  it('formats with default options (TC symbol)', () => {
    const result = formatCurrency(2500);
    expect(result).toContain('TC');
    expect(result).toContain('25');
  });

  it('formats without symbol when showSymbol is false', () => {
    const result = formatCurrency(2500, { showSymbol: false });
    expect(result).not.toContain('TC');
  });

  it('formats with custom symbol', () => {
    const result = formatCurrency(2500, { symbol: '$' });
    expect(result).toContain('$');
  });

  it('handles zero', () => {
    const result = formatCurrency(0);
    expect(result).toContain('0');
    expect(result).toContain('TC');
  });
});

// ============================================================
// formatTriciCoin / formatTRC
// ============================================================
describe('formatTriciCoin', () => {
  it('formats with TC symbol', () => {
    const result = formatTriciCoin(250000);
    expect(result).toContain('TC');
  });
});

describe('formatTRC', () => {
  it('formats with TRC symbol', () => {
    expect(formatTRC(100)).toContain('TRC');
    expect(formatTRC(250)).toContain('TRC');
  });

  it('formats zero', () => {
    const result = formatTRC(0);
    expect(result).toContain('0');
    expect(result).toContain('TRC');
  });
});

// ============================================================
// trcToUSD / formatTRCasUSD
// ============================================================
describe('trcToUSD', () => {
  it('converts TRC centavos to USD (1 TRC = 1 USD)', () => {
    expect(trcToUSD(100)).toBe(1);
    expect(trcToUSD(144)).toBe(1.44);
    expect(trcToUSD(50)).toBe(0.5);
  });

  it('handles zero', () => {
    expect(trcToUSD(0)).toBe(0);
  });
});

describe('formatTRCasUSD', () => {
  it('formats as USD with $ symbol', () => {
    expect(formatTRCasUSD(144)).toBe('$1.44');
    expect(formatTRCasUSD(100)).toBe('$1.00');
    expect(formatTRCasUSD(50)).toBe('$0.50');
  });

  it('formats zero', () => {
    expect(formatTRCasUSD(0)).toBe('$0.00');
  });
});

// ============================================================
// cupToTrcCentavos (CRITICAL)
// ============================================================
describe('cupToTrcCentavos', () => {
  it('converts CUP to TRC centavos with exchange rate', () => {
    // 750 CUP / 520 rate * 100 = 144.23 → 144
    expect(cupToTrcCentavos(750, 520)).toBe(144);
  });

  it('converts exact amounts', () => {
    // 300 CUP / 300 rate * 100 = 100 (exactly 1 TRC)
    expect(cupToTrcCentavos(300, 300)).toBe(100);
  });

  it('handles zero CUP', () => {
    expect(cupToTrcCentavos(0, 520)).toBe(0);
  });

  it('handles zero exchange rate (safety)', () => {
    expect(cupToTrcCentavos(750, 0)).toBe(0);
  });

  it('handles negative exchange rate (safety)', () => {
    expect(cupToTrcCentavos(750, -1)).toBe(0);
  });

  it('rounds correctly', () => {
    // 100 CUP / 300 rate * 100 = 33.33 → 33
    expect(cupToTrcCentavos(100, 300)).toBe(33);
  });

  it('handles large values', () => {
    // 50000 CUP / 520 rate * 100 = 9615.38 → 9615
    expect(cupToTrcCentavos(50000, 520)).toBe(9615);
  });

  it('handles small values', () => {
    // 1 CUP / 520 rate * 100 = 0.19 → 0
    expect(cupToTrcCentavos(1, 520)).toBe(0);
  });
});

// ============================================================
// trcCentavosToCupPesos (CRITICAL)
// ============================================================
describe('trcCentavosToCupPesos', () => {
  it('converts TRC centavos to CUP pesos', () => {
    // 144 centavos / 100 * 520 = 748.8 → 749
    expect(trcCentavosToCupPesos(144, 520)).toBe(749);
  });

  it('converts exact amounts', () => {
    // 100 centavos / 100 * 300 = 300
    expect(trcCentavosToCupPesos(100, 300)).toBe(300);
  });

  it('handles zero', () => {
    expect(trcCentavosToCupPesos(0, 520)).toBe(0);
  });

  it('rounds correctly', () => {
    // 33 centavos / 100 * 300 = 99 CUP
    expect(trcCentavosToCupPesos(33, 300)).toBe(99);
  });

  it('handles large values', () => {
    // 9615 centavos / 100 * 520 = 49998
    expect(trcCentavosToCupPesos(9615, 520)).toBe(49998);
  });
});

// ============================================================
// formatCUP
// ============================================================
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
// validateDriverRate (CRITICAL)
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
    expect(result.clampedRate).toBe(100); // clamped to default
    expect(result.error).toBe('below_minimum');
  });

  it('rejects and clamps rate above maximum', () => {
    const result = validateDriverRate(300, defaultRate, maxMultiplier);
    expect(result.valid).toBe(false);
    expect(result.clampedRate).toBe(200); // clamped to max (100 × 2)
    expect(result.error).toBe('above_maximum');
  });

  it('works with different multipliers', () => {
    // max = Math.round(100 * 3) = 300, so 250 is within range
    const result = validateDriverRate(250, 100, 3);
    expect(result.valid).toBe(true);
    expect(result.clampedRate).toBe(250);
  });

  it('rejects rate above max with 3x multiplier', () => {
    // max = Math.round(100 * 3) = 300, so 350 exceeds
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
