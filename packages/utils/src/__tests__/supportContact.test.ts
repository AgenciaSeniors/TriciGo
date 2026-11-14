import { describe, it, expect } from 'vitest';
import {
  SUPPORT_PHONES_CONFIG_KEY,
  SUPPORT_WHATSAPP_PHONES,
  parseSupportPhone,
  parseSupportPhones,
  resolveSupportPhones,
  primarySupportPhone,
  formatSupportPhone,
  supportWhatsAppUrl,
} from '../supportContact';

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
