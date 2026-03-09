// ============================================================
// TriciGo — Supabase Client Factory
// Detects environment (Expo vs Next.js) and uses the correct
// env var prefix to create a shared Supabase client.
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { StorageAdapter } from './storage';

declare const process: { env: Record<string, string | undefined> } | undefined;

let clientInstance: SupabaseClient | null = null;
let storageAdapter: StorageAdapter | undefined;

/**
 * Configure a custom storage adapter for Supabase auth.
 * Must be called before the first getSupabaseClient() call.
 */
export function configureStorage(adapter: StorageAdapter): void {
  storageAdapter = adapter;
}

function getEnvVar(name: string): string {
  // Try Expo prefix first (EXPO_PUBLIC_)
  const expoVar =
    typeof process !== 'undefined'
      ? process.env[`EXPO_PUBLIC_${name}`]
      : undefined;
  if (expoVar) return expoVar;

  // Try Next.js prefix (NEXT_PUBLIC_)
  const nextVar =
    typeof process !== 'undefined'
      ? process.env[`NEXT_PUBLIC_${name}`]
      : undefined;
  if (nextVar) return nextVar;

  // Try plain name (server-side / Edge Functions)
  const plainVar =
    typeof process !== 'undefined' ? process.env[name] : undefined;
  if (plainVar) return plainVar;

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
