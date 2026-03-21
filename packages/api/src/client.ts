// ============================================================
// TriciGo — Supabase Client Factory
// Detects environment (Expo vs Next.js) and uses the correct
// env var prefix to create a shared Supabase client.
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { StorageAdapter } from './storage';

declare const process: { env: Record<string, string | undefined> };

let clientInstance: SupabaseClient | null = null;
let storageAdapter: StorageAdapter | undefined;

/**
 * Configure a custom storage adapter for Supabase auth.
 * Must be called before the first getSupabaseClient() call.
 */
export function configureStorage(adapter: StorageAdapter): void {
  storageAdapter = adapter;
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
  if (clientInstance) return clientInstance;

  const supabaseUrl = getEnvVar('SUPABASE_URL');
  const supabaseAnonKey = getEnvVar('SUPABASE_ANON_KEY');

  clientInstance = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false, // Disable for React Native
      // Prevent "Lock broken by another request with the 'steal' option" on Expo Web
      // by providing a longer timeout so the lock doesn't get stolen on remounts
      storageKey: 'sb-tricigo-auth',
      ...(storageAdapter ? { storage: storageAdapter } : {}),
    },
    realtime: {
      params: {
        eventsPerSecond: 5, // Rate limit for Cuba's connectivity
      },
    },
  });

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
