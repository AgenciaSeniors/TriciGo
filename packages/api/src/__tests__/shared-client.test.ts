// @vitest-environment jsdom
// ============================================================
// TriciGo — setSupabaseClient: an app hands over the client it owns
//
// The admin panel signs in with @supabase/ssr (session in cookies). It used to
// copy that session into this package's localStorage client with setSession()
// on every page, a network call each time. Now it hands its own client over,
// and getSupabaseClient() returns that one.
// ============================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, setSupabaseClient } from '../client';

type AuthListener = (event: string, session: { access_token: string } | null) => void;

function fakeClient(token: string | null) {
  let listener: AuthListener = () => {};
  const lock = vi.fn();
  const setAuth = vi.fn();
  const client = {
    auth: {
      lock,
      getSession: vi.fn().mockResolvedValue({ data: { session: token ? { access_token: token } : null } }),
      onAuthStateChange: vi.fn((cb: AuthListener) => {
        listener = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
    },
    realtime: { setAuth },
  };
  return { client, lock, setAuth, emit: (event: string, session: { access_token: string } | null) => listener(event, session) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.__tricigo_supabase_client__;
  delete g.__tricigo_supabase_client_injected__;
  vi.unstubAllEnvs();
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

  it('handing over the same client twice installs the realtime listener once', () => {
    const { client } = fakeClient('tok-1');
    setSupabaseClient(client as unknown as SupabaseClient);
    setSupabaseClient(client as unknown as SupabaseClient);

    expect(client.auth.onAuthStateChange).toHaveBeenCalledTimes(1);
  });
});
