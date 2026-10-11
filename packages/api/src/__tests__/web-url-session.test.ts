// @vitest-environment jsdom
// ============================================================
// TriciGo — web: a URL with someone's tokens does not sign the browser in
//
// supabase-js reads `#access_token=…` on ANY page load (detectSessionInUrl).
// Before, https://tricigo.com/#access_token=<sender's>&… replaced whatever
// session the browser had. These tests run the real GoTrueClient in jsdom with
// our client options; only the network is faked.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ATTACKER = '11111111-1111-4111-8111-111111111111';
const VICTIM = '22222222-2222-4222-8222-222222222222';
const URL_BASE = 'https://example.supabase.co';

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jwt(sub: string): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64url('{"alg":"ES256","typ":"JWT"}')}.${b64url(JSON.stringify({ sub, exp, role: 'authenticated' }))}.sig`;
}

const attackerToken = jwt(ATTACKER);
const fetchMock = vi.fn();

function putTokensInUrl() {
  window.history.replaceState(
    null,
    '',
    `/auth/callback#access_token=${attackerToken}&refresh_token=rt-attacker&expires_in=3600&token_type=bearer&type=magiclink`,
  );
}

function storeVictimSession() {
  const token = jwt(VICTIM);
  window.localStorage.setItem(
    'sb-tricigo-auth',
    JSON.stringify({
      access_token: token,
      refresh_token: 'rt-victim',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: VICTIM, aud: 'authenticated', role: 'authenticated' },
    }),
  );
}

async function sessionUserId(): Promise<string | null> {
  const { getSupabaseClient } = await import('../client');
  const { data } = await getSupabaseClient().auth.getSession();
  return data.session?.user?.id ?? null;
}

beforeEach(() => {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__tricigo_supabase_client__;
  delete (globalThis as Record<string, unknown>).__tricigo_storage_adapter__;
  window.localStorage.clear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = URL_BASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'sb_publishable_test';
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string }).url);
    if (url.endsWith('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: ATTACKER, aud: 'authenticated', role: 'authenticated' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web client: session in the URL', () => {
  it('keeps the signed-in account when a link carries another account', async () => {
    storeVictimSession();
    putTokensInUrl();
    expect(await sessionUserId()).toBe(VICTIM);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps it even right after this browser started a login', async () => {
    storeVictimSession();
    window.localStorage.setItem('tricigo_pending_login', JSON.stringify({ kind: 'oauth', startedAt: Date.now() - 1000 }));
    putTokensInUrl();
    expect(await sessionUserId()).toBe(VICTIM);
  });

  it('does not sign in from tokens nobody asked for', async () => {
    putTokensInUrl();
    expect(await sessionUserId()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs in the redirect of a login this browser started, once', async () => {
    window.localStorage.setItem('tricigo_pending_login', JSON.stringify({ kind: 'oauth', startedAt: Date.now() - 1000 }));
    putTokensInUrl();
    expect(await sessionUserId()).toBe(ATTACKER);
    expect(window.localStorage.getItem('tricigo_pending_login')).toBeNull();
  });
});
