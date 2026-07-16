/**
 * Platform-agnostic storage adapter for Supabase auth.
 * On React Native: backed by expo-secure-store
 * On Web: backed by localStorage (Supabase default)
 *
 * Every operation degrades quietly instead of rejecting. This is load-bearing
 * on iOS: the keychain is unreadable while the device is locked, so a read from
 * a backgrounded app rejects with errSecInteractionNotAllowed ("User
 * interaction is not allowed"). GoTrue does not guard its storage calls, so a
 * rejection here escaped as an unhandled promise rejection on every locked
 * background wake (Sentry TRICIGO-MOBILE-14). A keychain we cannot reach right
 * now means "unknown", never "signed out" — callers must keep the cached
 * session and retry, which resolving to null lets them do.
 */

export interface StorageAdapter {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

export interface StorageAdapterOptions {
  /**
   * A previous location for these entries, read-only, migrated on demand.
   *
   * Native apps needed this because expo-secure-store applies
   * `keychainAccessible` on its SecItemAdd path only: when the key already
   * exists SecItemAdd returns errSecDuplicateItem and the module falls back to
   * SecItemUpdate, whose update dictionary carries kSecValueData alone and never
   * rewrites kSecAttrAccessible. An entry stored under the old default therefore
   * keeps that accessibility forever, however often it is rewritten. The apps
   * work around it by writing under a NEW keychainService — a different primary
   * key, so writes take the SecItemAdd path and the accessibility sticks — and
   * pointing `legacy` at the old one so existing sessions survive the upgrade.
   *
   * Adoption writes the value into the current store BEFORE deleting the legacy
   * copy, never the other way round. That ordering is the whole point: the entry
   * must be readable at every instant, because the driver app's background
   * location task reads its own entry on arbitrary ticks and treats an absent
   * entry as "the driver signed out".
   *
   * Leave unset for web/localStorage, which has no create-time options.
   */
  legacy?: {
    get: (key: string) => Promise<string | null>;
    remove: (key: string) => Promise<void>;
  };
}

export function createStorageAdapter(
  impl: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    remove: (key: string) => Promise<void>;
  },
  options: StorageAdapterOptions = {},
): StorageAdapter {
  const { legacy } = options;
  // GoTrue does not serialize its storage calls on native (it installs a no-op
  // lock; navigatorLock is web-only), so reads and writes for the same key
  // genuinely overlap. `adopting` single-flights the adoption; `written` records
  // that a real write has landed, which always outranks an inherited value.
  const adopting = new Map<string, Promise<string | null>>();
  const written = new Set<string>();

  return {
    // `await` inside try/catch so a native module that throws synchronously is
    // caught too, not just a rejected promise.
    getItem: async (key) => {
      let current: string | null = null;
      try {
        current = await impl.get(key);
      } catch {
        return null;
      }
      if (current !== null || !legacy) return current;

      const inFlight = adopting.get(key);
      if (inFlight) return inFlight;

      const adoption = (async (): Promise<string | null> => {
        let inherited: string | null = null;
        try {
          inherited = await legacy.get(key);
        } catch {
          return null;
        }
        if (inherited === null) return null;

        if (written.has(key)) {
          // A real write landed while we were reading the legacy copy, so what
          // we inherited is stale. Writing it back would restore a session whose
          // refresh token the server has already rotated away, and the next
          // refresh would answer invalid_refresh_token — a genuine sign-out.
          try {
            return await impl.get(key);
          } catch {
            return null;
          }
        }

        try {
          await impl.set(key, inherited);
          // Only now that the value is safely in the current store. If the write
          // above threw we keep the legacy copy and retry on the next read.
          await legacy.remove(key);
        } catch {
          /* still ours to return — adoption retries on the next read */
        }
        return inherited;
      })();

      adopting.set(key, adoption);
      try {
        return await adoption;
      } finally {
        adopting.delete(key);
      }
    },
    setItem: async (key, value) => {
      written.add(key);
      try {
        await impl.set(key, value);
      } catch {
        /* best effort — a write we cannot make is retried on the next refresh */
      }
    },
    removeItem: async (key) => {
      try {
        await impl.remove(key);
      } catch {
        /* best effort */
      }
      if (!legacy) return;
      try {
        // An un-adopted copy would otherwise outlive the sign-out.
        await legacy.remove(key);
      } catch {
        /* best effort */
      }
    },
  };
}
