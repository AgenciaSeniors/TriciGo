import { describe, expect, it, vi } from 'vitest';
import {
  SUPPORT_PHONES_CONFIG_KEY,
  SUPPORT_PHONE_CACHE_KEY,
  SUPPORT_WHATSAPP_PHONES,
  formatSupportPhone,
  orderSupportPhones,
  parseSupportPhone,
  parseSupportPhones,
  primarySupportPhone,
  readCachedSupportPhone,
  resolveSupportPhone,
  resolveSupportPhones,
  supportHelpPhone,
  supportWhatsAppUrl,
} from '../supportContact';
import type { SupportPhoneStore } from '../supportContact';

describe('SUPPORT_PHONES_CONFIG_KEY', () => {
  it('is the platform_config key the admin edits', () => {
    expect(SUPPORT_PHONES_CONFIG_KEY).toBe('support_whatsapp_phones');
  });

  it('is not named like a secret, so the apps can read it with the publishable key', () => {
    // platform_config_is_secret (00517) hides every key with one of these endings
    // from anon and authenticated: the apps would read nothing and fall back forever.
    expect(SUPPORT_PHONES_CONFIG_KEY).not.toMatch(/(_token|_secret|_signature|_hash|_api_key|_password)$/);
  });
});

describe('SUPPORT_WHATSAPP_PHONES — the built-in support numbers', () => {
  it('is the support team, in order', () => {
    expect(SUPPORT_WHATSAPP_PHONES).toEqual(['+5355159376', '+5354269290']);
  });
});

describe('parseSupportPhone — one number an admin typed', () => {
  it('keeps an E.164 number', () => {
    expect(parseSupportPhone('+5355159376')).toBe('+5355159376');
  });

  it('drops spaces, dashes and parentheses', () => {
    expect(parseSupportPhone('+53 (5) 515-9376')).toBe('+5355159376');
  });

  it('adds +53 to an 8-digit Cuban mobile, which starts with 5 or 6', () => {
    expect(parseSupportPhone('51234567')).toBe('+5351234567');
    expect(parseSupportPhone('61234567')).toBe('+5361234567');
  });

  it('adds the + to a number saved without it', () => {
    expect(parseSupportPhone('5351234567')).toBe('+5351234567');
  });

  it('reads a number stored as a JSON number', () => {
    expect(parseSupportPhone(5351234567)).toBe('+5351234567');
  });

  it('rejects what WhatsApp cannot open', () => {
    for (const value of ['', '   ', 'soporte', '1234567', '71234567', '+1234567890123456']) {
      expect(parseSupportPhone(value)).toBeNull();
    }
  });

  it('rejects a missing or non-text value', () => {
    for (const value of [null, undefined, true, {}, []]) {
      expect(parseSupportPhone(value)).toBeNull();
    }
  });
});

describe('parseSupportPhones — the ordered list an admin typed in platform_config', () => {
  it('reads numbers separated by commas, keeping their order', () => {
    expect(parseSupportPhones('+53 5515 9376, +53 5426 9290')).toEqual(['+5355159376', '+5354269290']);
    expect(parseSupportPhones('54269290, 55159376')).toEqual(['+5354269290', '+5355159376']);
  });

  it('also splits on semicolons, slashes and new lines, and skips empty parts', () => {
    expect(parseSupportPhones('55159376; 54269290 /\n+5351234567,')).toEqual([
      '+5355159376',
      '+5354269290',
      '+5351234567',
    ]);
  });

  it('reads a single number', () => {
    expect(parseSupportPhones('+5355159376')).toEqual(['+5355159376']);
  });

  it('reads a JSON array', () => {
    expect(parseSupportPhones(['+5355159376', 5354269290])).toEqual(['+5355159376', '+5354269290']);
  });

  it('keeps a repeated number once, in its first place', () => {
    expect(parseSupportPhones('+5355159376, 54269290, 55159376')).toEqual(['+5355159376', '+5354269290']);
  });

  it('is null when any part is not a phone, so the panel refuses the whole value', () => {
    expect(parseSupportPhones('+5355159376, soporte')).toBeNull();
  });

  it('is null when there is nothing to read', () => {
    for (const value of ['', ' , ; ', null, undefined, true, {}, []]) {
      expect(parseSupportPhones(value)).toBeNull();
    }
  });
});

describe('resolveSupportPhones — the numbers the apps use', () => {
  it('is the configured list when it is valid', () => {
    expect(resolveSupportPhones('+53 5123 4567')).toEqual(['+5351234567']);
  });

  it('falls back to the built-in numbers when the key is missing or broken', () => {
    expect(resolveSupportPhones(null)).toEqual(['+5355159376', '+5354269290']);
    expect(resolveSupportPhones('no tengo número')).toEqual(['+5355159376', '+5354269290']);
  });
});

describe('primarySupportPhone — the number a one-tap button opens', () => {
  it('is the first number of the list', () => {
    expect(primarySupportPhone(['+5354269290', '+5355159376'])).toBe('+5354269290');
  });

  it('is the first built-in number when the list is empty', () => {
    expect(primarySupportPhone([])).toBe('+5355159376');
  });
});

describe('formatSupportPhone — how a number reads on screen', () => {
  it('groups a Cuban mobile as +53 XXXX XXXX', () => {
    expect(formatSupportPhone('+5355159376')).toBe('+53 5515 9376');
  });

  it('leaves any other number as +<digits>', () => {
    expect(formatSupportPhone('+5491112345678')).toBe('+5491112345678');
  });
});

describe('supportWhatsAppUrl — the link that opens a support chat', () => {
  it('opens a chat with the number', () => {
    expect(supportWhatsAppUrl('+5355159376')).toBe('https://wa.me/5355159376');
  });

  it('types the text in when there is one', () => {
    expect(supportWhatsAppUrl('+5355159376', 'Hola, ¿todo bien?')).toBe(
      'https://wa.me/5355159376?text=Hola%2C%20%C2%BFtodo%20bien%3F',
    );
  });
});

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

describe('parseSupportPhone — the number an operator types to go on shift (00683)', () => {
  it('keeps an international number and strips separators', () => {
    expect(parseSupportPhone('+53 5512-3456')).toBe('+5355123456');
    expect(parseSupportPhone('+1 305 555 0100')).toBe('+13055550100');
    expect(parseSupportPhone('+53 (5512).3456')).toBe('+5355123456');
  });

  it('adds +53 to an 8-digit Cuban mobile', () => {
    expect(parseSupportPhone('55123456')).toBe('+5355123456');
    expect(parseSupportPhone('5512 3456')).toBe('+5355123456');
  });

  it('rejects what WhatsApp could not open', () => {
    for (const value of ['', '   ', '12345678', '+53 1234', '+0 5512 3456']) {
      expect(parseSupportPhone(value)).toBeNull();
    }
  });
});

describe('readCachedSupportPhone', () => {
  it('returns the last number received', async () => {
    await expect(readCachedSupportPhone(memoryStore('+5355123456'))).resolves.toBe('+5355123456');
  });

  it('returns null with nothing cached', async () => {
    await expect(readCachedSupportPhone(memoryStore())).resolves.toBeNull();
  });

  it('ignores a cached value that is not E.164', async () => {
    await expect(readCachedSupportPhone(memoryStore('garbage'))).resolves.toBeNull();
    await expect(readCachedSupportPhone(memoryStore('55123456'))).resolves.toBeNull();
    await expect(readCachedSupportPhone(memoryStore(''))).resolves.toBeNull();
  });

  it('never throws, whether the store rejects or throws synchronously', async () => {
    const rejecting: SupportPhoneStore = {
      getItem: async () => {
        throw new Error('read failed');
      },
      setItem: async () => {},
      removeItem: async () => {},
    };
    const throwing: SupportPhoneStore = {
      getItem: () => {
        throw new Error('sync read failed');
      },
      setItem: async () => {},
      removeItem: async () => {},
    };
    await expect(readCachedSupportPhone(rejecting)).resolves.toBeNull();
    await expect(readCachedSupportPhone(throwing)).resolves.toBeNull();
  });

  it('only reads: never writes nor clears the cache', async () => {
    const setItem = vi.fn(async () => {});
    const removeItem = vi.fn(async () => {});
    const getItem = vi.fn(async () => 'garbage');
    await readCachedSupportPhone({ getItem, setItem, removeItem });
    expect(getItem).toHaveBeenCalledWith(SUPPORT_PHONE_CACHE_KEY);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
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

describe('orderSupportPhones — the numbers a help screen lists', () => {
  const list = ['+5355159376', '+5354269290'];

  it('puts the operator the server named first, then the configured list', () => {
    expect(orderSupportPhones('+5351234567', list)).toEqual(['+5351234567', '+5355159376', '+5354269290']);
  });

  it('is the configured list when no operator is known', () => {
    expect(orderSupportPhones(null, list)).toEqual(list);
    expect(orderSupportPhones(undefined, list)).toEqual(list);
  });

  it('lists the operator once when she is also in the configured list', () => {
    expect(orderSupportPhones('+5354269290', list)).toEqual(['+5354269290', '+5355159376']);
  });

  it('compares numbers by their digits, however they were written', () => {
    expect(orderSupportPhones('+53 5426 9290', list)).toEqual(['+5354269290', '+5355159376']);
    expect(orderSupportPhones('54269290', ['+53 5515 9376', '+53 5426-9290'])).toEqual([
      '+5354269290',
      '+5355159376',
    ]);
  });

  it('leaves out a number WhatsApp could not open', () => {
    expect(orderSupportPhones('+5312345', list)).toEqual(list);
    expect(orderSupportPhones('', ['soporte', '+5354269290'])).toEqual(['+5354269290']);
  });

  it('keeps a repeated configured number once, in its first place', () => {
    expect(orderSupportPhones(null, ['+5355159376', '+5354269290', '+5355159376'])).toEqual(list);
  });

  it('is never empty: with nothing usable it is the built-in list', () => {
    expect(orderSupportPhones(null, [])).toEqual([...SUPPORT_WHATSAPP_PHONES]);
    expect(orderSupportPhones('garbage', ['soporte'])).toEqual([...SUPPORT_WHATSAPP_PHONES]);
  });

  it('does not change the list it was given', () => {
    const given = ['+5355159376', '+5354269290'];
    orderSupportPhones('+5351234567', given);
    expect(given).toEqual(['+5355159376', '+5354269290']);
  });
});

describe('supportHelpPhone — the number "Pide ayuda" opens', () => {
  const list = ['+5355159376', '+5354269290'];

  it('is the ride owner the server answered with', () => {
    expect(supportHelpPhone('+5351111111', '+5352222222', list)).toBe('+5351111111');
  });

  it('else the operator on shift the screen already knows', () => {
    expect(supportHelpPhone(null, '+5352222222', list)).toBe('+5352222222');
    expect(supportHelpPhone(undefined, '+5352222222', list)).toBe('+5352222222');
  });

  it('else the first configured number', () => {
    expect(supportHelpPhone(null, null, list)).toBe('+5355159376');
    expect(supportHelpPhone(null, null, ['+5354269290', '+5355159376'])).toBe('+5354269290');
  });

  it('skips a number WhatsApp could not open', () => {
    expect(supportHelpPhone('+5312345', '+5352222222', list)).toBe('+5352222222');
    expect(supportHelpPhone('+5312345', 'garbage', list)).toBe('+5355159376');
  });

  it('is the first built-in number when nothing else is usable', () => {
    expect(supportHelpPhone(null, null, [])).toBe('+5355159376');
  });

  it('answers as +<digits>', () => {
    expect(supportHelpPhone('+53 5111 1111', null, list)).toBe('+5351111111');
  });
});
