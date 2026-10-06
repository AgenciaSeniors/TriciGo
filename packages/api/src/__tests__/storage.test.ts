import { describe, it, expect, vi } from 'vitest';

import { createStorageAdapter } from '../storage';

// BUG-iOS-KEYCHAIN (Sentry TRICIGO-MOBILE-14, app.tricigo.driver@1.0.7+24,
// iOS 26.5, 11 events / 1 driver): on iOS the keychain is UNREADABLE while the
// device is locked. expo-secure-store then rejects with:
//
//   Error: Calling the 'getValueWithKeyAsync' function has failed
//   → Caused by: User interaction is not allowed.      (errSecInteractionNotAllowed)
//
// The driver app is woken in the BACKGROUND by the location task while the
// phone sits locked in the driver's pocket (`in_foreground: false` on every
// event), so this is the NORMAL case for it, not an edge case.
//
// This adapter is the seam Supabase's GoTrue uses to persist the session. It
// used to hand `impl.get/set/remove` straight to GoTrue, so a locked keychain
// surfaced as an unhandled promise rejection. It must instead degrade quietly:
// a keychain we cannot read right now is NOT a sign-out.
const lockedKeychain = (fn: string) => () =>
  Promise.reject(new Error(`Calling the '${fn}' function has failed`));

describe('createStorageAdapter', () => {
  describe('when the keychain is readable (device unlocked)', () => {
    it('passes the stored value through', async () => {
      const adapter = createStorageAdapter({
        get: async (key) => (key === 'sb-auth-token' ? 'session-json' : null),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      });

      await expect(adapter.getItem('sb-auth-token')).resolves.toBe('session-json');
    });

    it('reports a missing key as null', async () => {
      const adapter = createStorageAdapter({
        get: async () => null,
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      });

      await expect(adapter.getItem('nope')).resolves.toBeNull();
    });

    it('forwards writes and deletes to the underlying store', async () => {
      const set = vi.fn(async () => {});
      const remove = vi.fn(async () => {});
      const adapter = createStorageAdapter({ get: async () => null, set, remove });

      await adapter.setItem('sb-auth-token', 'session-json');
      await adapter.removeItem('sb-auth-token');

      expect(set).toHaveBeenCalledWith('sb-auth-token', 'session-json');
      expect(remove).toHaveBeenCalledWith('sb-auth-token');
    });
  });

  describe('when the keychain is locked (iOS background wake)', () => {
    it('resolves getItem to null instead of rejecting', async () => {
      const adapter = createStorageAdapter({
        get: lockedKeychain('getValueWithKeyAsync'),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      });

      // Must RESOLVE. Rejecting here is what produced the unhandled rejection
      // (Sentry mechanism: onunhandledrejection) on every locked background wake.
      await expect(adapter.getItem('sb-auth-token')).resolves.toBeNull();
    });

    it('resolves setItem instead of rejecting', async () => {
      const adapter = createStorageAdapter({
        get: async () => null,
        set: lockedKeychain('setValueWithKeyAsync'),
        remove: vi.fn(async () => {}),
      });

      await expect(adapter.setItem('sb-auth-token', 'session-json')).resolves.toBeUndefined();
    });

    it('resolves removeItem instead of rejecting', async () => {
      const adapter = createStorageAdapter({
        get: async () => null,
        set: vi.fn(async () => {}),
        remove: lockedKeychain('deleteValueWithKeyAsync'),
      });

      await expect(adapter.removeItem('sb-auth-token')).resolves.toBeUndefined();
    });

    it('never lets a synchronously-thrown keychain error escape', async () => {
      // expo-secure-store's native module can throw synchronously (rather than
      // returning a rejected promise) when the module itself is unavailable.
      const adapter = createStorageAdapter({
        get: () => {
          throw new Error('Native module ExpoSecureStore is null');
        },
        set: () => {
          throw new Error('Native module ExpoSecureStore is null');
        },
        remove: () => {
          throw new Error('Native module ExpoSecureStore is null');
        },
      });

      await expect(adapter.getItem('k')).resolves.toBeNull();
      await expect(adapter.setItem('k', 'v')).resolves.toBeUndefined();
      await expect(adapter.removeItem('k')).resolves.toBeUndefined();
    });
  });

  // Why a `legacy` store exists at all: expo-secure-store applies
  // `keychainAccessible` on its SecItemAdd path only. When the key already
  // exists, SecItemAdd returns errSecDuplicateItem and the module falls back to
  // SecItemUpdate, whose update dictionary carries kSecValueData ALONE and never
  // rewrites kSecAttrAccessible. So a session stored by an older build keeps the
  // old WHEN_UNLOCKED forever, however often it is refreshed — the reporting
  // driver would have installed the fix and stayed broken.
  //
  // The apps therefore write under a NEW keychainService, which is a different
  // primary key, so writes take the SecItemAdd path and the accessibility sticks.
  // Adoption must NEVER delete before writing: the entry has to be readable at
  // every instant, because the driver's background location task reads it on
  // arbitrary ticks and treats an absent entry as "signed out".
  describe('adopting entries from a legacy store', () => {
    const legacyStore = (value: string | null) => ({
      get: vi.fn(async () => value),
      remove: vi.fn(async () => {}),
    });

    it('ignores the legacy store once the entry lives in the current one', async () => {
      const legacy = legacyStore('stale');
      const adapter = createStorageAdapter(
        { get: async () => 'current', set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        { legacy },
      );

      await expect(adapter.getItem('sb-auth-token')).resolves.toBe('current');
      expect(legacy.get).not.toHaveBeenCalled();
    });

    it('writes the legacy value into the current store BEFORE deleting it', async () => {
      // The ordering IS the safety property: there must be no instant where
      // neither store holds the session.
      const calls: string[] = [];
      const legacy = {
        get: async () => 'session-json',
        remove: async () => {
          calls.push('legacy.remove');
        },
      };
      const adapter = createStorageAdapter(
        {
          get: async () => null,
          set: async () => {
            calls.push('set');
          },
          remove: vi.fn(async () => {}),
        },
        { legacy },
      );

      await expect(adapter.getItem('sb-auth-token')).resolves.toBe('session-json');
      expect(calls).toEqual(['set', 'legacy.remove']);
    });

    it('keeps the legacy entry when adopting it fails', async () => {
      // Losing the only copy would sign the driver out, and re-login needs an
      // OTP SMS — unreliable on some Cuban prefixes. Keep the old copy and retry
      // on the next read instead.
      const legacy = legacyStore('session-json');
      const adapter = createStorageAdapter(
        {
          get: async () => null,
          set: lockedKeychain('setValueWithKeyAsync'),
          remove: vi.fn(async () => {}),
        },
        { legacy },
      );

      await expect(adapter.getItem('sb-auth-token')).resolves.toBe('session-json');
      expect(legacy.remove).not.toHaveBeenCalled();
    });

    it('reports null when neither store has the entry', async () => {
      const legacy = legacyStore(null);
      const adapter = createStorageAdapter(
        { get: async () => null, set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        { legacy },
      );

      await expect(adapter.getItem('sb-auth-token')).resolves.toBeNull();
      expect(legacy.remove).not.toHaveBeenCalled();
    });

    it('reports null instead of rejecting when the legacy entry is locked', async () => {
      const adapter = createStorageAdapter(
        { get: async () => null, set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        { legacy: { get: lockedKeychain('getValueWithKeyAsync'), remove: vi.fn(async () => {}) } },
      );

      await expect(adapter.getItem('sb-auth-token')).resolves.toBeNull();
    });

    it('clears both stores on removeItem so no stale session is left behind', async () => {
      const legacy = legacyStore('session-json');
      const remove = vi.fn(async () => {});
      const adapter = createStorageAdapter(
        { get: async () => null, set: vi.fn(async () => {}), remove },
        { legacy },
      );

      await adapter.removeItem('sb-auth-token');

      expect(remove).toHaveBeenCalledWith('sb-auth-token');
      expect(legacy.remove).toHaveBeenCalledWith('sb-auth-token');
    });

    it('does not clobber a write that landed while the legacy value was read', async () => {
      // GoTrue does not serialize its storage calls on native (lockNoOp), so a
      // token refresh can store a NEW session while an adoption is still reading
      // the OLD one. Writing the inherited value on top would restore a session
      // whose refresh token the server already rotated away — the next refresh
      // gets invalid_refresh_token, which IS a real SIGNED_OUT, and the driver
      // needs an OTP SMS to get back in.
      let stored: string | null = null;
      let release = () => {};
      const legacyRead = new Promise<void>((r) => {
        release = r;
      });

      const adapter = createStorageAdapter(
        {
          get: async () => stored,
          set: async (_key, value) => {
            stored = value;
          },
          remove: vi.fn(async () => {}),
        },
        {
          legacy: {
            get: async () => {
              await legacyRead;
              return 'session-OLD';
            },
            remove: vi.fn(async () => {}),
          },
        },
      );

      const reading = adapter.getItem('sb-auth-token');
      await adapter.setItem('sb-auth-token', 'session-NEW'); // refresh lands first
      release();

      await expect(reading).resolves.toBe('session-NEW');
      expect(stored).toBe('session-NEW');
    });

    it('adopts once when two reads race', async () => {
      const set = vi.fn(async () => {});
      const legacyRemove = vi.fn(async () => {});
      const adapter = createStorageAdapter(
        { get: async () => null, set, remove: vi.fn(async () => {}) },
        { legacy: { get: async () => 'session-json', remove: legacyRemove } },
      );

      const [a, b] = await Promise.all([
        adapter.getItem('sb-auth-token'),
        adapter.getItem('sb-auth-token'),
      ]);

      expect([a, b]).toEqual(['session-json', 'session-json']);
      expect(set).toHaveBeenCalledTimes(1);
      expect(legacyRemove).toHaveBeenCalledTimes(1);
    });

    it('writes go straight to the current store, never the legacy one', async () => {
      const legacy = legacyStore('stale');
      const set = vi.fn(async () => {});
      const adapter = createStorageAdapter(
        { get: async () => null, set, remove: vi.fn(async () => {}) },
        { legacy },
      );

      await adapter.setItem('sb-auth-token', 'v2');

      expect(set).toHaveBeenCalledWith('sb-auth-token', 'v2');
      expect(legacy.get).not.toHaveBeenCalled();
      expect(legacy.remove).not.toHaveBeenCalled();
    });
  });
  // 2026-09-21, driver "Alexander solano": the app showed him signed in (UI
  // rehydrated from the offline snapshot) while GoTrue held NO session, so every
  // request left as role `anon` for 23 minutes — 32 of them 401, and "Conectarme"
  // surfaced the raw `permission denied for function current_user_role`. His
  // server session was intact the whole time (refreshed 13 min later). The
  // adapter turns BOTH "the store threw" and "the store holds nothing" into
  // null, so the apps could not tell a locked/failing keystore (keep the cached
  // UI, retry) from a genuinely absent session (go to login). Nor did anyone
  // learn WHY the read failed: the catch swallowed the error.
  describe('telling an unreadable store apart from an empty one', () => {
    it('reports no read failure after a clean "nothing stored" answer', async () => {
      const adapter = createStorageAdapter({
        get: async () => null,
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      });

      await expect(adapter.getItem('sb-auth-token')).resolves.toBeNull();
      expect(adapter.lastReadFailed('sb-auth-token')).toBe(false);
    });

    it('remembers that the last read threw, and tells the app why', async () => {
      const onReadError = vi.fn();
      const adapter = createStorageAdapter(
        {
          get: lockedKeychain('getValueWithKeyAsync'),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
        { onReadError },
      );

      await expect(adapter.getItem('sb-auth-token')).resolves.toBeNull();
      expect(adapter.lastReadFailed('sb-auth-token')).toBe(true);
      expect(onReadError).toHaveBeenCalledTimes(1);
      expect(onReadError).toHaveBeenCalledWith(
        'sb-auth-token',
        expect.objectContaining({ message: expect.stringContaining('getValueWithKeyAsync') }),
      );
    });

    it('clears the failure once a later read succeeds', async () => {
      let locked = true;
      const adapter = createStorageAdapter({
        get: async () => {
          if (locked) throw new Error("Calling the 'getValueWithKeyAsync' function has failed");
          return 'session-json';
        },
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      });

      await adapter.getItem('sb-auth-token');
      expect(adapter.lastReadFailed('sb-auth-token')).toBe(true);

      locked = false;
      await expect(adapter.getItem('sb-auth-token')).resolves.toBe('session-json');
      expect(adapter.lastReadFailed('sb-auth-token')).toBe(false);
    });

    it('counts a legacy-store read that threw as a failure, not as "nothing stored"', async () => {
      const onReadError = vi.fn();
      const adapter = createStorageAdapter(
        { get: async () => null, set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        { legacy: { get: lockedKeychain('getValueWithKeyAsync'), remove: vi.fn(async () => {}) }, onReadError },
      );

      await expect(adapter.getItem('sb-auth-token')).resolves.toBeNull();
      expect(adapter.lastReadFailed('sb-auth-token')).toBe(true);
      expect(onReadError).toHaveBeenCalledTimes(1);
    });

    it('tracks failures per key', async () => {
      const adapter = createStorageAdapter({
        get: async (key) => {
          if (key === 'broken') throw new Error('keystore');
          return null;
        },
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      });

      await adapter.getItem('broken');
      await adapter.getItem('fine');
      expect(adapter.lastReadFailed('broken')).toBe(true);
      expect(adapter.lastReadFailed('fine')).toBe(false);
      expect(adapter.lastReadFailed('never-read')).toBe(false);
    });

    it('never lets the onReadError hook itself break a read', async () => {
      const adapter = createStorageAdapter(
        {
          get: lockedKeychain('getValueWithKeyAsync'),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
        {
          onReadError: () => {
            throw new Error('sentry is down');
          },
        },
      );

      await expect(adapter.getItem('sb-auth-token')).resolves.toBeNull();
      expect(adapter.lastReadFailed('sb-auth-token')).toBe(true);
    });
  });
});
