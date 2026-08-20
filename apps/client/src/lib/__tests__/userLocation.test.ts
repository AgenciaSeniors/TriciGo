import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetItem = vi.fn();
const mockSetItem = vi.fn();
const mockGetLastKnown = vi.fn();
const mockGetCurrent = vi.fn();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (...args: unknown[]) => mockGetItem(...args),
    setItem: (...args: unknown[]) => mockSetItem(...args),
  },
}));

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3, High: 4 },
  getLastKnownPositionAsync: (...args: unknown[]) => mockGetLastKnown(...args),
  getCurrentPositionAsync: (...args: unknown[]) => mockGetCurrent(...args),
  getForegroundPermissionsAsync: vi.fn(),
}));

import { readCachedLocation, getFreshPosition, LAST_KNOWN_LOCATION_KEY } from '../userLocation';

const HAVANA = { latitude: 23.1136, longitude: -82.3666 };

beforeEach(() => {
  vi.clearAllMocks();
  mockSetItem.mockResolvedValue(undefined);
});

describe('readCachedLocation', () => {
  it('returns the cached point', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify(HAVANA));
    await expect(readCachedLocation()).resolves.toEqual(HAVANA);
    expect(mockGetItem).toHaveBeenCalledWith(LAST_KNOWN_LOCATION_KEY);
  });

  it('returns null when nothing is cached', async () => {
    mockGetItem.mockResolvedValue(null);
    await expect(readCachedLocation()).resolves.toBeNull();
  });

  it('returns null on malformed JSON instead of throwing', async () => {
    mockGetItem.mockResolvedValue('{not json');
    await expect(readCachedLocation()).resolves.toBeNull();
  });

  // A NaN coordinate silently breaks the camera and poisons every bounds
  // computation downstream, so it must never leave this helper.
  it('rejects non-finite coordinates', async () => {
    mockGetItem.mockResolvedValue('{"latitude":null,"longitude":-82.3}');
    await expect(readCachedLocation()).resolves.toBeNull();
  });

  it('returns null when storage itself fails', async () => {
    mockGetItem.mockRejectedValue(new Error('storage unavailable'));
    await expect(readCachedLocation()).resolves.toBeNull();
  });
});

describe('getFreshPosition', () => {
  it('prefers the OS last-known fix and never asks for a fresh one', async () => {
    mockGetLastKnown.mockResolvedValue({ coords: HAVANA });
    await expect(getFreshPosition()).resolves.toEqual(HAVANA);
    expect(mockGetCurrent).not.toHaveBeenCalled();
  });

  it('falls back to a fresh fix when there is no last-known one', async () => {
    mockGetLastKnown.mockResolvedValue(null);
    mockGetCurrent.mockResolvedValue({ coords: HAVANA });
    await expect(getFreshPosition()).resolves.toEqual(HAVANA);
    expect(mockGetCurrent).toHaveBeenCalledTimes(1);
  });

  it('caches whatever it resolves so sibling views reuse it', async () => {
    mockGetLastKnown.mockResolvedValue({ coords: HAVANA });
    await getFreshPosition();
    expect(mockSetItem).toHaveBeenCalledWith(
      LAST_KNOWN_LOCATION_KEY,
      JSON.stringify(HAVANA),
    );
  });

  it('rejects a non-finite fix and does not cache it', async () => {
    mockGetLastKnown.mockResolvedValue({ coords: { latitude: NaN, longitude: -82.3 } });
    await expect(getFreshPosition()).resolves.toBeNull();
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('returns null when both position APIs come up empty', async () => {
    mockGetLastKnown.mockResolvedValue(null);
    mockGetCurrent.mockResolvedValue(null);
    await expect(getFreshPosition()).resolves.toBeNull();
  });

  it('returns null when the location API throws', async () => {
    mockGetLastKnown.mockRejectedValue(new Error('location services off'));
    await expect(getFreshPosition()).resolves.toBeNull();
  });
});
