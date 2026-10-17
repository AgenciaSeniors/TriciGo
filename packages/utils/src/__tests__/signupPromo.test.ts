import { describe, it, expect } from 'vitest';
import {
  isSignupPromoCode,
  signupPromoPrefill,
  signupPromoAction,
  promotionLinkStatus,
} from '../signupPromo';

describe('isSignupPromoCode', () => {
  it('matches the signup promotion code, ignoring case and spaces', () => {
    expect(isSignupPromoCode(' moto20 ', 'MOTO20')).toBe(true);
  });
  it('is false for another code, an empty field or no signup promotion', () => {
    expect(isSignupPromoCode('OTRO', 'MOTO20')).toBe(false);
    expect(isSignupPromoCode('', 'MOTO20')).toBe(false);
    expect(isSignupPromoCode('MOTO20', null)).toBe(false);
    expect(isSignupPromoCode('MOTO 20', 'MOTO20')).toBe(false);
    expect(isSignupPromoCode('MOTO20', '  ')).toBe(false);
  });
});

describe('signupPromoPrefill', () => {
  it('fills an empty field with the signup promotion code', () => {
    expect(signupPromoPrefill('', 'MOTO20')).toBe('MOTO20');
    expect(signupPromoPrefill('   ', 'MOTO20')).toBe('MOTO20');
  });
  it('leaves a typed or linked code alone', () => {
    expect(signupPromoPrefill('VERANO', 'MOTO20')).toBeNull();
  });
  it('does nothing without a signup promotion', () => {
    expect(signupPromoPrefill('', null)).toBeNull();
    expect(signupPromoPrefill('', '  ')).toBeNull();
  });
});

describe('signupPromoAction', () => {
  const base = {
    promoCode: 'MOTO20',
    signupPromoCode: 'MOTO20',
    hasResult: false,
    validating: false,
    fareCup: 4000,
    eligible: true,
  };

  it('validates the signup code once there is a fare and no result', () => {
    expect(signupPromoAction(base)).toBe('validate');
  });
  it('waits for a fare', () => {
    expect(signupPromoAction({ ...base, fareCup: 0 })).toBe('none');
  });
  it('does not validate twice', () => {
    expect(signupPromoAction({ ...base, hasResult: true })).toBe('none');
    expect(signupPromoAction({ ...base, validating: true })).toBe('none');
  });
  it('never touches a code the person typed', () => {
    expect(signupPromoAction({ ...base, promoCode: 'VERANO' })).toBe('none');
    expect(signupPromoAction({ ...base, promoCode: 'VERANO', hasResult: true, eligible: false })).toBe('none');
  });
  it('clears its result on a delivery or a company ride, and validates again when that changes back', () => {
    expect(signupPromoAction({ ...base, hasResult: true, eligible: false })).toBe('clear');
    expect(signupPromoAction({ ...base, hasResult: false, eligible: false })).toBe('none');
    expect(signupPromoAction({ ...base, hasResult: false, eligible: true })).toBe('validate');
  });
  it('matches the signup code ignoring case and spaces', () => {
    expect(signupPromoAction({ ...base, promoCode: ' moto20 ' })).toBe('validate');
  });
  it('lets a validation in flight finish before clearing', () => {
    expect(signupPromoAction({ ...base, validating: true, hasResult: true, eligible: false })).toBe('none');
  });
});

describe('promotionLinkStatus', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const active = {
    is_active: true,
    pending_approval: false,
    valid_from: '2026-10-01T00:00:00Z',
    valid_until: null,
    max_uses: null,
    current_uses: 0,
  };

  it('is active when on, started, not expired and with uses left', () => {
    expect(promotionLinkStatus(active, now)).toBe('active');
  });
  it('tells pending approval from paused', () => {
    expect(promotionLinkStatus({ ...active, is_active: false, pending_approval: true }, now)).toBe('pending');
    expect(promotionLinkStatus({ ...active, is_active: false }, now)).toBe('paused');
  });
  it('is scheduled before it starts and expired after it ends', () => {
    expect(promotionLinkStatus({ ...active, valid_from: '2026-10-18T00:00:00Z' }, now)).toBe('scheduled');
    expect(promotionLinkStatus({ ...active, valid_until: '2026-10-17T12:00:00Z' }, now)).toBe('expired');
    expect(promotionLinkStatus({ ...active, valid_from: '2026-10-17T12:00:00Z' }, now)).toBe('active');
  });
  it('is exhausted with no uses left', () => {
    expect(promotionLinkStatus({ ...active, max_uses: 10, current_uses: 10 }, now)).toBe('exhausted');
    expect(promotionLinkStatus({ ...active, max_uses: 10, current_uses: 11 }, now)).toBe('exhausted');
    expect(promotionLinkStatus({ ...active, max_uses: 0, current_uses: 0 }, now)).toBe('exhausted');
  });
});
