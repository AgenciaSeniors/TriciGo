// The apps decide what to do with a null session by asking whether the auth
// storage could be READ at all: unreadable → keep the cached UI and retry
// (locked keychain, keystore hiccup); readable-but-empty → the session is
// genuinely gone → login. This helper is the single place that knows the
// storage key GoTrue uses.
import { describe, it, expect } from 'vitest';

import { configureStorage, didAuthStorageReadFail } from '../client';
import { createStorageAdapter } from '../storage';

describe('didAuthStorageReadFail', () => {
  it('is false when no adapter was ever configured', () => {
    expect(didAuthStorageReadFail()).toBe(false);
  });

  it('reflects the configured adapter for the GoTrue session key', async () => {
    const adapter = createStorageAdapter({
      get: async () => {
        throw new Error('keystore unavailable');
      },
      set: async () => {},
      remove: async () => {},
    });
    configureStorage(adapter);

    await adapter.getItem('sb-tricigo-auth');
    expect(didAuthStorageReadFail()).toBe(true);
  });

  it('is false after a clean read of the session key', async () => {
    const adapter = createStorageAdapter({
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    });
    configureStorage(adapter);

    await adapter.getItem('sb-tricigo-auth');
    expect(didAuthStorageReadFail()).toBe(false);
  });
});
