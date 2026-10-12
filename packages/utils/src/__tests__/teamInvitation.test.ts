import { describe, expect, it } from 'vitest';
import {
  invitationOutcomePath,
  isInvitationToken,
  noAccessReason,
  parseAcceptOutcome,
} from '../teamInvitation';

describe('parseAcceptOutcome', () => {
  it('reads an accepted invitation with its role', () => {
    expect(parseAcceptOutcome({ result: 'accepted', role: 'marketing' })).toEqual({
      result: 'accepted', role: 'marketing', emailMasked: null,
    });
  });

  it('keeps the masked address of a wrong account', () => {
    expect(parseAcceptOutcome({ result: 'wrong_account', email_masked: 'l…@gmail.com' })).toEqual({
      result: 'wrong_account', role: null, emailMasked: 'l…@gmail.com',
    });
  });

  it('turns anything unexpected into none', () => {
    for (const raw of [null, undefined, 'accepted', 42, {}, { result: 'hacked' }, { result: 'accepted', role: 'customer' }]) {
      expect(parseAcceptOutcome(raw).result).toBe('none');
    }
  });
});

describe('invitationOutcomePath', () => {
  it('sends an accepted person to their role home', () => {
    expect(invitationOutcomePath({ result: 'accepted', role: 'admin', emailMasked: null })).toBe('/');
    expect(invitationOutcomePath({ result: 'accepted', role: 'marketing', emailMasked: null })).toBe('/launch-pulse');
  });

  it('sends everyone else to /sin-acceso with the reason and the masked address', () => {
    expect(invitationOutcomePath({ result: 'wrong_account', role: null, emailMasked: 'l…@gmail.com' })).toBe(
      '/sin-acceso?reason=wrong_account&email=l%E2%80%A6%40gmail.com',
    );
    expect(invitationOutcomePath({ result: 'none', role: null, emailMasked: null })).toBe('/sin-acceso?reason=none');
  });
});

describe('noAccessReason', () => {
  it('accepts the known reasons and nothing else', () => {
    expect(noAccessReason('expired')).toBe('expired');
    expect(noAccessReason('needs_google')).toBe('needs_google');
    for (const raw of [null, '', 'accepted', 'whatever']) expect(noAccessReason(raw)).toBe('none');
  });
});

describe('isInvitationToken', () => {
  it('is 64 lowercase hex characters', () => {
    expect(isInvitationToken('a'.repeat(64))).toBe(true);
    for (const raw of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), '', null, undefined]) {
      expect(isInvitationToken(raw)).toBe(false);
    }
  });
});
