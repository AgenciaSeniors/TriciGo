import { describe, expect, it, vi } from 'vitest';
import {
  SUPPORT_PHONE_CACHE_KEY,
  normalizeSupportWhatsapp,
  resolveSupportPhone,
} from '../supportContact';
import type { SupportPhoneStore } from '../supportContact';

function memoryStore(initial?: string): SupportPhoneStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SUPPORT_PHONE_CACHE_KEY, initial);
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

describe('normalizeSupportWhatsapp', () => {
  it('keeps a valid international number and strips separators', () => {
    expect(normalizeSupportWhatsapp('+53 5512-3456')).toBe('+5355123456');
    expect(normalizeSupportWhatsapp('+1 305 555 0100')).toBe('+13055550100');
    expect(normalizeSupportWhatsapp('+53 (5512).3456')).toBe('+5355123456');
  });

  it('adds +53 to an 8-digit Cuban mobile starting with 5', () => {
    expect(normalizeSupportWhatsapp('55123456')).toBe('+5355123456');
    expect(normalizeSupportWhatsapp('5512 3456')).toBe('+5355123456');
  });

  it('rejects numbers without a plus that are not Cuban mobiles', () => {
    expect(normalizeSupportWhatsapp('(305) 555-0100')).toBeNull();
    expect(normalizeSupportWhatsapp('12345678')).toBeNull();
  });

  it('rejects empty and too short input', () => {
    expect(normalizeSupportWhatsapp('')).toBeNull();
    expect(normalizeSupportWhatsapp('   ')).toBeNull();
    expect(normalizeSupportWhatsapp('+53 1234')).toBeNull();
    expect(normalizeSupportWhatsapp('+0 5512 3456')).toBeNull();
    expect(normalizeSupportWhatsapp('+53 abc 5512 3456')).toBeNull();
  });
});

describe('resolveSupportPhone', () => {
  it('returns and caches a phone that came back ok', async () => {
    const store = memoryStore();
    const phone = await resolveSupportPhone(async () => ({ status: 'ok', phone: '+5355123456' }), store);
    expect(phone).toBe('+5355123456');
    expect(store.data.get(SUPPORT_PHONE_CACHE_KEY)).toBe('+5355123456');
  });

  it('returns null and clears the cache when ok has no phone', async () => {
    const store = memoryStore('+5355123456');
    const phone = await resolveSupportPhone(async () => ({ status: 'ok', phone: null }), store);
    expect(phone).toBeNull();
    expect(store.data.has(SUPPORT_PHONE_CACHE_KEY)).toBe(false);
  });

  it('falls back to the cached phone when unreachable', async () => {
    const store = memoryStore('+5355123456');
    const phone = await resolveSupportPhone(async () => ({ status: 'unreachable' }), store);
    expect(phone).toBe('+5355123456');
  });

  it('returns null when unreachable with nothing cached', async () => {
    const phone = await resolveSupportPhone(async () => ({ status: 'unreachable' }), memoryStore());
    expect(phone).toBeNull();
  });

  it('treats a store that throws on read as empty', async () => {
    const store: SupportPhoneStore = {
      getItem: vi.fn(async () => {
        throw new Error('read failed');
      }),
      setItem: async () => {},
      removeItem: async () => {},
    };
    await expect(resolveSupportPhone(async () => ({ status: 'unreachable' }), store)).resolves.toBeNull();
  });

  it('ignores a store that throws or rejects on write', async () => {
    const store: SupportPhoneStore = {
      getItem: async () => {
        throw new Error('read failed');
      },
      setItem: () => {
        throw new Error('sync write failed');
      },
      removeItem: async () => {
        throw new Error('remove failed');
      },
    };
    await expect(
      resolveSupportPhone(async () => ({ status: 'ok', phone: '+5355123456' }), store),
    ).resolves.toBe('+5355123456');
    await expect(
      resolveSupportPhone(async () => ({ status: 'ok', phone: null }), store),
    ).resolves.toBeNull();
  });

  it('does not offer a stale non-E.164 cached value', async () => {
    const store = memoryStore('garbage');
    const phone = await resolveSupportPhone(async () => ({ status: 'unreachable' }), store);
    expect(phone).toBeNull();
  });
});
