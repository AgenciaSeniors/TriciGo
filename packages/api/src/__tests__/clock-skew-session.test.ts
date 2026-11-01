// ============================================================
// TriciGo — a phone clock that is wrong by an hour must not sign anyone out
//
// 2026-11-01: Cuba kept summer time (UTC−4) but phones fell back to UTC−5, and
// people set the clock forward by hand. Their phones then read UTC one hour
// AHEAD of the server. GoTrue stores the server's `expires_at` and compares it
// to the phone's Date.now(), so a fresh one-hour token already looked expired:
// every request refreshed the session again (~40 in 20 s), GoTrue answered
// 429 over_request_rate_limit, and auth-js treated the 429 as fatal, deleted
// the session and fired SIGNED_OUT. 16 users were sent to the login screen that
// day (one then signed in with Google and got a brand-new empty account).
//
// These tests run the REAL GoTrueClient (auth-js 2.99.1) through the client
// this package builds. Only the network and the phone clock are faked.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const URL_BASE = 'https://example.supabase.co';
const USER = '33333333-3333-4333-8333-333333333333';
const SKEW_MS = 60 * 60 * 1000; // phone one hour ahead of the server

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The server's clock: the phone's minus the skew. */
let skewMs = SKEW_MS;
const serverNowS = () => Math.floor((Date.now() - skewMs) / 1000);

function serverToken(n: number) {
  const exp = serverNowS() + 3600;
  return {
    access_token: `${b64url('{"alg":"ES256","typ":"JWT"}')}.${b64url(JSON.stringify({ sub: USER, exp, n, role: 'authenticated' }))}.sig`,
    refresh_token: `rt-${n}`,
    expires_in: 3600,
    expires_at: exp, // GoTrue sends it, computed on the SERVER clock
    token_type: 'bearer',
    user: { id: USER, aud: 'authenticated', role: 'authenticated' },
  };
}

const memory = new Map<string, string>();
const adapter = {
  getItem: async (k: string) => memory.get(k) ?? null,
  setItem: async (k: string, v: string) => { memory.set(k, v); },
  removeItem: async (k: string) => { memory.delete(k); },
  lastReadFailed: () => false,
};

let refreshCalls = 0;
let refreshStatus = 200;
const fetchMock = vi.fn();

function storeSession() {
  memory.set('sb-tricigo-auth', JSON.stringify(serverToken(0)));
}

async function buildClient() {
  const mod = await import('../client');
  mod.configureStorage(adapter);
  return mod.getSupabaseClient();
}

beforeEach(() => {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__tricigo_supabase_client__;
  delete (globalThis as Record<string, unknown>).__tricigo_storage_adapter__;
  memory.clear();
  refreshCalls = 0;
  refreshStatus = 200;
  skewMs = SKEW_MS;
  process.env.EXPO_PUBLIC_SUPABASE_URL = URL_BASE;
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'sb_publishable_test';
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string }).url);
    if (url.includes('/auth/v1/token')) {
      refreshCalls += 1;
      if (refreshStatus !== 200) {
        return new Response(
          JSON.stringify({ code: refreshStatus, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }),
          { status: refreshStatus, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(serverToken(refreshCalls)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  const client = (globalThis as Record<string, unknown>).__tricigo_supabase_client__ as
    | { auth: { stopAutoRefresh: () => Promise<void> } }
    | undefined;
  await client?.auth.stopAutoRefresh();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('phone clock one hour ahead of the server', () => {
  it('refreshes the session once, not on every request', async () => {
    storeSession();
    const client = await buildClient();
    await client.auth.stopAutoRefresh();

    for (let i = 0; i < 6; i++) {
      await client.from('rides').select('id');
    }

    // The stored session looks expired to the phone, so one refresh is right.
    // Every refresh after that is the loop that got users signed out.
    expect(refreshCalls).toBe(1);
  });

  it('keeps working the same way when the clock is right', async () => {
    skewMs = 0;
    storeSession();
    const client = await buildClient();
    await client.auth.stopAutoRefresh();

    for (let i = 0; i < 6; i++) {
      await client.from('rides').select('id');
    }

    expect(refreshCalls).toBe(0);
  });

  it('a 429 on the refresh does not sign the user out', async () => {
    // The stored session looks expired, and GoTrue rate-limits the refresh.
    storeSession();
    refreshStatus = 429;
    // auth-js logs every retryable failure with console.error.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const client = await buildClient();
    const events: string[] = [];
    client.auth.onAuthStateChange((event) => { events.push(event); });

    /** Run a request on the fake clock until it settles: auth-js retries a
     *  retryable error with backoff for up to 30 s of Date.now() (hence Date
     *  is faked too), once while restoring the stored session and once more
     *  for the request itself. */
    async function settle(request: PromiseLike<unknown>) {
      let settled = false;
      const done = Promise.resolve(request).then(() => { settled = true; });
      for (let i = 0; i < 180 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await done;
    }

    await settle(client.from('rides').select('id'));
    expect(refreshCalls).toBeGreaterThan(0);
    expect(events).not.toContain('SIGNED_OUT');
    const stored = memory.get('sb-tricigo-auth');
    expect(stored).toBeDefined();
    expect(JSON.parse(stored as string).refresh_token).toBe('rt-0');

    // Once GoTrue lets it through, the same session refreshes normally. Let
    // the backoff still in flight run out first, as it would on a phone.
    for (let i = 0; i < 40 && vi.getTimerCount() > 0; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    refreshStatus = 200;
    await settle(client.from('rides').select('id'));
    await client.auth.stopAutoRefresh();
    vi.useRealTimers();
    expect(JSON.parse(memory.get('sb-tricigo-auth') as string).refresh_token).not.toBe('rt-0');
    expect(events).not.toContain('SIGNED_OUT');
  }, 20_000);
});
