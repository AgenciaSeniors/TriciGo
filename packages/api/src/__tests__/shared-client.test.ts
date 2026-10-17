// @vitest-environment jsdom
// ============================================================
// TriciGo — setSupabaseClient: an app hands over the client it owns
//
// The admin panel signs in with @supabase/ssr (session in cookies). It used to
// copy that session into this package's localStorage client with setSession()
// on every page, a network call each time. Now it hands its own client over,
// and getSupabaseClient() returns that one. The copy of the session that old
// client kept in localStorage is deleted, so its refresh token cannot be replayed.
// ============================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PENDING_LOGIN_STORAGE_KEY } from '@tricigo/utils/authCallback';
import { AUTH_STORAGE_KEY, getSupabaseClient, setSupabaseClient } from '../client';

type AuthListener = (event: string, session: { access_token: string } | null) => void;

function fakeClient(token: string | null) {
  const listeners: AuthListener[] = [];
  const lock = vi.fn();
  const setAuth = vi.fn();
  const client = {
    auth: {
      lock,
      getSession: vi.fn().mockResolvedValue({ data: { session: token ? { access_token: token } : null } }),
      onAuthStateChange: vi.fn((cb: AuthListener) => {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
    },
    realtime: { setAuth },
  };
  const emit = (event: string, session: { access_token: string } | null) => {
    for (const listener of listeners) listener(event, session);
  };
  return { client, lock, setAuth, emit };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.__tricigo_supabase_client__;
  delete g.__tricigo_supabase_client_injected__;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('setSupabaseClient', () => {
  it('makes getSupabaseClient return the client the app handed over', () => {
    const { client } = fakeClient('tok-1');
    setSupabaseClient(client as unknown as SupabaseClient);

    expect(getSupabaseClient()).toBe(client);
    expect(getSupabaseClient()).toBe(client);
  });

  it('leaves the handed-over client its own lock (the web lock patch is for the client this package builds)', () => {
    const { client, lock } = fakeClient('tok-1');
    setSupabaseClient(client as unknown as SupabaseClient);

    getSupabaseClient();

    expect(client.auth.lock).toBe(lock);
  });

  it('gives realtime the session token at start and on every auth event', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
    const { client, setAuth, emit } = fakeClient('tok-1');
    setSupabaseClient(client as unknown as SupabaseClient);
    await flush();

    expect(setAuth).toHaveBeenCalledWith('tok-1');

    emit('TOKEN_REFRESHED', { access_token: 'tok-2' });
    expect(setAuth).toHaveBeenLastCalledWith('tok-2');

    emit('SIGNED_OUT', null);
    expect(setAuth).toHaveBeenLastCalledWith('anon-key');
  });

  it('handing over the same client twice installs its listeners once', () => {
    const { client } = fakeClient('tok-1');
    setSupabaseClient(client as unknown as SupabaseClient);
    const listenersAfterFirst = client.auth.onAuthStateChange.mock.calls.length;
    setSupabaseClient(client as unknown as SupabaseClient);

    expect(client.auth.onAuthStateChange).toHaveBeenCalledTimes(listenersAfterFirst);
  });

  // 2026-10-15: a panel tab loaded before the handover existed still held its own
  // client, with the refresh token this package's client had last saved here
  // (four days old). It refreshed with that token a second after the cookie
  // client had rotated the same session, and Supabase revoked the whole session
  // as a replayed token. The admin was sent back to the login page.
  it('drops the session the package client left in localStorage, so no stale refresh token can be replayed', () => {
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ access_token: 'old-access', refresh_token: 'old-refresh' }),
    );
    const { client } = fakeClient('tok-1');

    setSupabaseClient(client as unknown as SupabaseClient);

    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('removes only that session and leaves the rest of localStorage alone', () => {
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ refresh_token: 'old-refresh' }));
    window.localStorage.setItem('admin-theme', 'dark');
    window.localStorage.setItem(PENDING_LOGIN_STORAGE_KEY, 'pending');
    const { client } = fakeClient('tok-1');

    setSupabaseClient(client as unknown as SupabaseClient);

    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem('admin-theme')).toBe('dark');
    expect(window.localStorage.getItem(PENDING_LOGIN_STORAGE_KEY)).toBe('pending');
  });

  // A panel tab still running the code from before the handover copies every new
  // session into that key again. Deleting it each time the handed-over client gets
  // a new token keeps the copy from ever being older than the cookies' session.
  it.each(['TOKEN_REFRESHED', 'SIGNED_IN'])('drops the session again when the handed-over client emits %s', (event) => {
    const { client, emit } = fakeClient('tok-1');
    setSupabaseClient(client as unknown as SupabaseClient);
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ refresh_token: 'rewritten-by-old-tab' }));

    emit(event, { access_token: 'tok-2' });

    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('still hands the client over when storage is blocked', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const { client, emit } = fakeClient('tok-1');

    expect(() => setSupabaseClient(client as unknown as SupabaseClient)).not.toThrow();
    expect(() => emit('TOKEN_REFRESHED', { access_token: 'tok-2' })).not.toThrow();
    expect(getSupabaseClient()).toBe(client);
  });
});
