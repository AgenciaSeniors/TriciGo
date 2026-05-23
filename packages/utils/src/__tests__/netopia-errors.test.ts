import { describe, it, expect } from 'vitest';
import { translateNetopiaError } from '../netopia-errors';

describe('translateNetopiaError', () => {
  it('translates the canonical "Invalid CVV" with explicit "NO fue cobrada"', () => {
    // This is the exact message that triggered the bug investigation
    // (intent d3fc744f, NETOPIA two-IPN edge case, 2026-05-23). The
    // user MUST see that the card was not charged.
    const result = translateNetopiaError('Invalid CVV');
    expect(result).toContain('CVV');
    expect(result).toContain('NO fue cobrada');
    expect(result).not.toContain('Invalid CVV'); // no English leak
  });

  it('translates "Insufficient funds" to Spanish', () => {
    const result = translateNetopiaError('Insufficient funds');
    expect(result).toContain('Saldo insuficiente');
    expect(result).toContain('NO fue cobrada');
  });

  it('translates "Card declined" with bank contact hint', () => {
    const result = translateNetopiaError('Card declined');
    expect(result).toContain('Tu banco rechazó');
    expect(result).toContain('NO fue cobrada');
  });

  it('translates "Expired card" to Spanish', () => {
    expect(translateNetopiaError('Expired card')).toContain('vencida');
  });

  it('translates "3DS authentication failed" with OTP hint', () => {
    const result = translateNetopiaError('3DS authentication failed');
    expect(result).toContain('3D-Secure');
    expect(result).toContain('NO fue cobrada');
  });

  it('falls back to raw message + "NO fue cobrada" for unknown errors', () => {
    // The fallback path is critical: if NETOPIA introduces a new
    // failure message we haven't mapped, we must STILL tell the user
    // their card wasn't charged.
    const result = translateNetopiaError('Some new error from NETOPIA');
    expect(result).toContain('Some new error from NETOPIA');
    expect(result).toContain('NO fue cobrada');
  });

  it('returns a generic fallback when raw is null', () => {
    const result = translateNetopiaError(null);
    expect(result).toContain('rechazó el pago');
    expect(result).toContain('NO fue cobrada');
  });

  it('returns a generic fallback when raw is undefined', () => {
    const result = translateNetopiaError(undefined);
    expect(result).toContain('rechazó el pago');
    expect(result).toContain('NO fue cobrada');
  });

  it('returns a generic fallback when raw is empty string', () => {
    const result = translateNetopiaError('');
    expect(result).toContain('rechazó el pago');
  });

  it('returns a generic fallback when raw is whitespace-only', () => {
    const result = translateNetopiaError('   ');
    expect(result).toContain('rechazó el pago');
  });

  it('never returns an empty string', () => {
    // Defensive: every branch must return a user-displayable string.
    expect(translateNetopiaError('Invalid CVV').length).toBeGreaterThan(0);
    expect(translateNetopiaError('unknown').length).toBeGreaterThan(0);
    expect(translateNetopiaError(null).length).toBeGreaterThan(0);
    expect(translateNetopiaError(undefined).length).toBeGreaterThan(0);
    expect(translateNetopiaError('').length).toBeGreaterThan(0);
  });
});
