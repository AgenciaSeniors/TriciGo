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

/**
 * Get or create the shared Supabase client.
 * Uses singleton pattern for client-side usage.
 */
export function getSupabaseClient(): SupabaseClient {
  const existing = getClientInstance();
  if (existing) return existing;

  const supabaseUrl = getEnvVar('SUPABASE_URL');
  const supabaseAnonKey = getEnvVar('SUPABASE_ANON_KEY');

  // Expo Web (Metro bundler) has issues with Supabase's navigator.locks usage,
  // causing "this.lock is not a function" or "Lock broken" errors.
  // Provide a simple no-op lock on web to avoid these issues entirely.
  const isWeb = typeof window !== 'undefined' && typeof document !== 'undefined';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lockConfig: any = isWeb
    ? {
        lock: async (_name: string, _acquireTimeout: number, fn: () => Promise<unknown>) => {
          return await fn();
        },
      }
    : {};

  const clientInstance = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: isWeb, // Enable on web for OAuth redirects, disable on native
      ...(isWeb ? { flowType: 'implicit' as const } : {}), // Implicit flow for web (no server to exchange PKCE code)
      storageKey: 'sb-tricigo-auth',
      ...lockConfig,
      ...(storageAdapter ? { storage: storageAdapter } : {}),
    },
    realtime: {
      params: {
        eventsPerSecond: 5, // Rate limit for Cuba's connectivity
      },
    },
  });

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
