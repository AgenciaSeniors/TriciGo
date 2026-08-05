import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory AsyncStorage mock. The service module is imported LAZY (inside
// each test) so the mock is set up before its top-level import runs.
vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      setItem: vi.fn((k: string, v: string) => { store.set(k, v); return Promise.resolve(); }),
      removeItem: vi.fn((k: string) => { store.delete(k); return Promise.resolve(); }),
      __store: store,
    },
  };
});

const KEY = '@tricigo/recent_addresses';

async function seedStorage(rows: unknown) {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  await AsyncStorage.setItem(KEY, JSON.stringify(rows));
}

async function readStorage(): Promise<unknown> {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
}

beforeEach(async () => {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  await AsyncStorage.removeItem(KEY);
});

describe('recentAddressService.add (isFinite guard)', () => {
  // The regression this guards: cross-street SUGGESTIONS carry
  // { latitude: NaN, longitude: NaN, needsResolution: true } on purpose so a
  // caller that ignored the flag would fail loudly. If one of those ever
  // reached `add()`, haversineDistance(_, NaN) = NaN and `NaN > 50` is false,
  // so the dedupe would never remove it — the poisoned row would stay in
  // recents forever and crash the map every time it was rendered.
  it('rejects a NaN coordinate — returns the existing list unchanged', async () => {
    await seedStorage([
      { address: 'Calle 23 e/ L y M', latitude: 23.137, longitude: -82.383, timestamp: 1 },
    ]);
    const { recentAddressService } = await import('../recentAddresses');
    const out = await recentAddressService.add('Callejón de los Protestantes', NaN, NaN);
    expect(out).toHaveLength(1);
    expect(out[0]!.address).toBe('Calle 23 e/ L y M');
  });

  it('rejects an Infinity coordinate', async () => {
    const { recentAddressService } = await import('../recentAddresses');
    const out = await recentAddressService.add('bad', Number.POSITIVE_INFINITY, 0);
    expect(out).toHaveLength(0);
  });

  it('accepts a valid coordinate', async () => {
    const { recentAddressService } = await import('../recentAddresses');
    const out = await recentAddressService.add('Vedado', 23.137, -82.383);
    expect(out).toHaveLength(1);
    expect(out[0]!.latitude).toBe(23.137);
  });
});

describe('recentAddressService.getAll (self-heal)', () => {
  it('drops rows with non-finite coordinates and rewrites storage', async () => {
    await seedStorage([
      { address: 'good', latitude: 23.137, longitude: -82.383, timestamp: 1 },
      { address: 'nan', latitude: NaN, longitude: NaN, timestamp: 2 },
      { address: 'null-lng', latitude: 22.5, longitude: null, timestamp: 3 },
      { address: 'infinity', latitude: Number.NEGATIVE_INFINITY, longitude: -80, timestamp: 4 },
      { address: 'still-good', latitude: 21.4, longitude: -77.9, timestamp: 5 },
    ]);
    const { recentAddressService } = await import('../recentAddresses');
    const out = await recentAddressService.getAll();
    expect(out.map(r => r.address)).toEqual(['good', 'still-good']);

    // Give the fire-and-forget rewrite a tick to land, then confirm storage
    // was rewritten without the poisoned rows.
    await new Promise(r => setTimeout(r, 0));
    const persisted = await readStorage();
    expect(Array.isArray(persisted)).toBe(true);
    expect((persisted as { address: string }[]).map(r => r.address)).toEqual(['good', 'still-good']);
  });

  it('returns empty list when storage is empty', async () => {
    const { recentAddressService } = await import('../recentAddresses');
    const out = await recentAddressService.getAll();
    expect(out).toEqual([]);
  });

  it('returns empty list when storage holds a non-array', async () => {
    await seedStorage({ oops: true });
    const { recentAddressService } = await import('../recentAddresses');
    const out = await recentAddressService.getAll();
    expect(out).toEqual([]);
  });
});
