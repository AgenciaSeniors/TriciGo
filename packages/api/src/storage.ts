/**
 * Platform-agnostic storage adapter for Supabase auth.
 * On React Native: backed by expo-secure-store
 * On Web: backed by localStorage (Supabase default)
 */

export interface StorageAdapter {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

export function createStorageAdapter(impl: {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
}): StorageAdapter {
  return {
    getItem: impl.get,
    setItem: impl.set,
    removeItem: impl.remove,
  };
}
