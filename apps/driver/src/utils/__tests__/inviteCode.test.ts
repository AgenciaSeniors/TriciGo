import { describe, it, expect } from 'vitest';
import { INVALID_REFERRAL_CODE_MESSAGE, inviteCodeErrorMessage } from '../inviteCode';

const INVALID = 'Ese código no existe. Revísalo o deja el campo vacío.';

describe('inviteCodeErrorMessage', () => {
  it('replaces the invalid-referral message with the invite-code one', () => {
    expect(inviteCodeErrorMessage(new Error(INVALID_REFERRAL_CODE_MESSAGE), INVALID)).toBe(INVALID);
  });

  it('keeps the other referral errors as they are', () => {
    expect(inviteCodeErrorMessage(new Error('No puedes usar tu propio código'), INVALID)).toBe(
      'No puedes usar tu propio código',
    );
    expect(inviteCodeErrorMessage(new Error('Ya usaste un código de referido'), INVALID)).toBe(
      'Ya usaste un código de referido',
    );
  });

  it('passes raw errors through', () => {
    expect(inviteCodeErrorMessage(new Error('Network request failed'), INVALID)).toBe('Network request failed');
  });

  it('returns undefined for anything that is not an Error', () => {
    expect(inviteCodeErrorMessage({ message: INVALID_REFERRAL_CODE_MESSAGE }, INVALID)).toBeUndefined();
    expect(inviteCodeErrorMessage('boom', INVALID)).toBeUndefined();
    expect(inviteCodeErrorMessage(undefined, INVALID)).toBeUndefined();
  });
});
