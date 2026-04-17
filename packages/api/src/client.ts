/// <reference lib="dom" />
// ============================================================
// TriciGo — Supabase Client Factory
// Detects environment (Expo vs Next.js) and uses the correct
// env var prefix to create a shared Supabase client.
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { StorageAdapter } from './storage';

declare const process: { env: Record<string, string | undefined> };

// Use globalThis to survive Metro hot reloads (prevents "Multiple GoTrueClient instances")
const GLOBAL_KEY = '__tricigo_supabase_client__';
const STORAGE_KEY = '__tricigo_storage_adapter__';

function getClientInstance(): SupabaseClient | null {
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as SupabaseClient | null ?? null;
}

function setClientInstance(client: SupabaseClient): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = client;
}

let storageAdapter: StorageAdapter | undefined =
  (globalThis as Record<string, unknown>)[STORAGE_KEY] as StorageAdapter | undefined;

/**
 * Configure a custom storage adapter for Supabase auth.
 * Must be called before the first getSupabaseClient() call.
 */
export function configureStorage(adapter: StorageAdapter): void {
  storageAdapter = adapter;
  (globalThis as Record<string, unknown>)[STORAGE_KEY] = adapter;
}

// Static env references using dot notation so bundlers (webpack/metro)
// can resolve them at compile time. Computed access like
// process.env[`PREFIX_${name}`] is NOT replaced by webpack.
const STATIC_ENV: Record<string, () => string | undefined> = {
  SUPABASE_URL: () =>
    process.env.EXPO_PUBLIC_SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: () =>
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY,
};

function getEnvVar(name: string): string {
  const getter = STATIC_ENV[name];
  const value = typeof process !== 'undefined' && getter ? getter() : undefined;
  if (value) return value;

  throw new Error(
    `Missing environment variable: ${name}. ` +
      `Set EXPO_PUBLIC_${name}, NEXT_PUBLIC_${name}, or ${name}.`,
  );
}

// ── Web Lock Fix ──
// Expo Web + Supabase's GoTrueClient = deadlock. The SDK uses navigator.locks
// internally, which hangs in Metro's web environment. We permanently disable
// navigator.locks on web BEFORE any Supabase client is created so the
// GoTrueClient constructor falls back to its internal lockNoOp.
const _isWeb = typeof window !== 'undefined' && typeof document !== 'undefined';
if (_isWeb && typeof globalThis !== 'undefined') {
  try {
    if ((globalThis as any).navigator?.locks) {
      Object.defineProperty((globalThis as any).navigator, 'locks', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    }
  } catch { /* non-fatal */ }
}

/** No-op lock that simply executes the callback without any locking. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lockNoOp = async (_name: string, _acquireTimeout: number, fn: () => Promise<any>) => fn();

/**
 * Monkey-patch an existing Supabase client's GoTrueClient to use no-op locks.
 * This fixes clients that were created before navigator.locks was removed
 * (e.g., surviving a Metro HMR reload).
 */
function patchClientLocks(client: SupabaseClient): void {
  try {
    const auth = client.auth as any;
    if (!auth) return;
    // Force the lock function to no-op
    auth.lock = lockNoOp;
    // If initializePromise is stuck, replace it with a resolved one
    // so getSession() and other methods don't wait forever.
    if (auth.initializePromise) {
      const testPromise = Promise.race([
        auth.initializePromise,
        new Promise((_, rej) => setTimeout(() => rej('stuck'), 50)),
      ]);
      testPromise.catch(() => {
        // The initializePromise is stuck — resolve it manually
        auth.initializePromise = Promise.resolve();
      });
    }
  } catch { /* non-fatal */ }
}

/**
 * Get or create the shared Supabase client.
 * Uses singleton pattern for client-side usage.
 */
export function getSupabaseClient(): SupabaseClient {
  const existing = getClientInstance();
  if (existing) {
    // Always patch locks on web — the singleton may predate the navigator.locks fix
    if (_isWeb) patchClientLocks(existing);
    return existing;
  }

  const supabaseUrl = getEnvVar('SUPABASE_URL');
  const supabaseAnonKey = getEnvVar('SUPABASE_ANON_KEY');

  const clientInstance = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: _isWeb, // Enable on web for OAuth redirects, disable on native
      ...(_isWeb ? { flowType: 'implicit' as const } : {}),
      storageKey: 'sb-tricigo-auth',
      // On web, provide no-op lock to prevent navigator.locks deadlock
      ...(_isWeb ? { lock: lockNoOp } : {}),
      ...(storageAdapter ? { storage: storageAdapter } : {}),
    },
    realtime: {
      params: {
        eventsPerSecond: 5, // Rate limit for Cuba's connectivity
      },
    },
  });

  // Patch locks as a safety net (belt + suspenders)
  if (_isWeb) patchClientLocks(clientInstance);

  setClientInstance(clientInstance);
  return clientInstance;
}

/**
 * Create a Supabase admin client (server-side only).
 * Uses the service role key which bypasses RLS.
 */
export function getSupabaseAdmin(): SupabaseClient {
  const supabaseUrl = getEnvVar('SUPABASE_URL');
  const serviceRoleKey =
    typeof process !== 'undefined'
      ? process.env['SUPABASE_SERVICE_ROLE_KEY']
      : undefined;

  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is required for admin operations.',
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export type { SupabaseClient };
