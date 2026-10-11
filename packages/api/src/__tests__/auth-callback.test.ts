// ============================================================
// TriciGo — a sign-in link never takes over someone else's session
//
// Before: both apps set the session from ANY `<scheme>://auth/callback#…` link,
// so a link carrying the tokens of the sender's own account silently swapped
// the reader into it. See packages/utils/src/authCallback.ts for the rule.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSession = vi.fn();
const mockSetSession = vi.fn();

vi.mock('../client', () => ({
  getSupabaseClient: () => ({ auth: { getSession: mockGetSession, setSession: mockSetSession } }),
}));

import { completeAuthCallback } from '../authCallback';
import { serializePendingLogin } from '@tricigo/utils/authCallback';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const ATTACKER = '11111111-1111-4111-8111-111111111111';
const VICTIM = '22222222-2222-4222-8222-222222222222';

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jwt(payload: Record<string, unknown>): string {
  return `${b64url('{"alg":"ES256"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

const tokens = {
  accessToken: jwt({ sub: ATTACKER, email: 'phone_5399999999@tricigo.app', exp: Math.floor(NOW / 1000) + 3600 }),
  refreshToken: 'rt-attacker',
};

function hooks(over: Partial<Parameters<typeof completeAuthCallback>[1]> = {}) {
  return {
    readPending: vi.fn(async () => null as string | null),
    clearPending: vi.fn(async () => {}),
    confirm: vi.fn(async () => false),
    currentUserId: () => null as string | null,
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockSetSession.mockResolvedValue({ data: {}, error: null });
});

describe('completeAuthCallback', () => {
  it('does not swap the signed-in victim into the sender account', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: VICTIM } } }, error: null });
    const h = hooks({ readPending: vi.fn(async () => serializePendingLogin('oauth', NOW - 1000)) });
    expect(await completeAuthCallback(tokens, h)).toBe('other_account_signed_in');
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('counts the account the UI shows even when the stored session could not be read', async () => {
    const h = hooks({ currentUserId: () => VICTIM });
    expect(await completeAuthCallback(tokens, h)).toBe('other_account_signed_in');
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it('asks before using a link nobody started here, and respects a no', async () => {
    const h = hooks();
    expect(await completeAuthCallback(tokens, h)).toBe('declined');
    expect(h.confirm).toHaveBeenCalledWith('+5399999999');
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it('signs in after a yes', async () => {
    const h = hooks({ confirm: vi.fn(async () => true) });
    expect(await completeAuthCallback(tokens, h)).toBe('signed_in');
    expect(mockSetSession).toHaveBeenCalledWith({ access_token: tokens.accessToken, refresh_token: 'rt-attacker' });
    expect(h.clearPending).toHaveBeenCalled();
  });

  it('signs in without asking when this device started the login, and clears the marker', async () => {
    const h = hooks({ readPending: vi.fn(async () => serializePendingLogin('oauth', NOW - 5000)) });
    expect(await completeAuthCallback(tokens, h)).toBe('signed_in');
    expect(h.confirm).not.toHaveBeenCalled();
    expect(mockSetSession).toHaveBeenCalledTimes(1);
    expect(h.clearPending).toHaveBeenCalled();
  });

  it('is a no-op for the account already signed in (the OAuth result and the link both arrive)', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: ATTACKER } } }, error: null });
    expect(await completeAuthCallback(tokens, hooks())).toBe('already_signed_in');
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it('reports a session Supabase rejects', async () => {
    mockSetSession.mockResolvedValue({ data: {}, error: { message: 'Invalid Refresh Token' } });
    const h = hooks({ readPending: vi.fn(async () => serializePendingLogin('oauth', NOW - 5000)) });
    expect(await completeAuthCallback(tokens, h)).toBe('failed');
    expect(h.clearPending).not.toHaveBeenCalled();
  });

  it('ignores a token it cannot read', async () => {
    const h = hooks({ confirm: vi.fn(async () => true) });
    expect(await completeAuthCallback({ accessToken: 'garbage', refreshToken: 'x' }, h)).toBe('invalid_token');
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it('still decides when the marker or the session cannot be read', async () => {
    mockGetSession.mockRejectedValue(new Error('keystore'));
    const h = hooks({ readPending: vi.fn(async () => { throw new Error('storage'); }) });
    expect(await completeAuthCallback(tokens, h)).toBe('declined');
    expect(h.confirm).toHaveBeenCalled();
  });
});
