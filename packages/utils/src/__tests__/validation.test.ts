import { describe, it, expect } from 'vitest';
import {
  isValidCubanPhone,
  normalizeCubanPhone,
  isValidEmail,
  isValidPlateNumber,
  isValidCubaLatitude,
  isValidCubaLongitude,
  isLocationInCuba,
  isValidOTP,
  sanitizeText,
  maskPhone,
} from '../validation';

// ============================================================
// isValidCubanPhone
// ============================================================
describe('isValidCubanPhone', () => {
  it('accepts valid phone with country code +535XXXXXXX', () => {
    expect(isValidCubanPhone('+5351234567')).toBe(true);
    expect(isValidCubanPhone('+5359876543')).toBe(true);
  });

  it('accepts valid phone without country code 5XXXXXXX', () => {
    expect(isValidCubanPhone('51234567')).toBe(true);
    expect(isValidCubanPhone('59876543')).toBe(true);
  });

  it('accepts phone with spaces/dashes', () => {
    expect(isValidCubanPhone('+53 5123 4567')).toBe(true);
    expect(isValidCubanPhone('5123-4567')).toBe(true);
  });

  it('rejects ambiguous format with parens (country code + number)', () => {
    // '(53) 51234567' → cleaned '5351234567' (10 digits) doesn't match either pattern
    expect(isValidCubanPhone('(53) 51234567')).toBe(false);
  });

  it('rejects phone that is too short', () => {
    expect(isValidCubanPhone('5123456')).toBe(false); // 7 digits
    expect(isValidCubanPhone('+535123')).toBe(false);
  });

  it('rejects phone that is too long', () => {
    expect(isValidCubanPhone('512345678')).toBe(false); // 9 digits
    expect(isValidCubanPhone('+53512345678')).toBe(false);
  });

  it('rejects phone with letters', () => {
    expect(isValidCubanPhone('5123abcd')).toBe(false);
    expect(isValidCubanPhone('+53abc12345')).toBe(false);
  });

  it('rejects phone not starting with 5 (non-mobile)', () => {
    expect(isValidCubanPhone('71234567')).toBe(false);
    expect(isValidCubanPhone('+5371234567')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidCubanPhone('')).toBe(false);
  });
});

// ============================================================
// normalizeCubanPhone
// ============================================================
describe('normalizeCubanPhone', () => {
  it('adds +53 prefix to 8-digit number', () => {
    expect(normalizeCubanPhone('51234567')).toBe('+5351234567');
  });

  it('returns unchanged if already has +53 prefix', () => {
    expect(normalizeCubanPhone('+5351234567')).toBe('+5351234567');
  });

  it('adds + to number starting with 53 (10 digits)', () => {
    expect(normalizeCubanPhone('5351234567')).toBe('+5351234567');
  });

  it('strips spaces and dashes before normalizing', () => {
    expect(normalizeCubanPhone('5123 4567')).toBe('+5351234567');
    expect(normalizeCubanPhone('5123-4567')).toBe('+5351234567');
  });
});

// ============================================================
// isValidEmail
// ============================================================
describe('isValidEmail', () => {
  it('accepts valid email addresses', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('test.user@domain.co')).toBe(true);
    expect(isValidEmail('name+tag@gmail.com')).toBe(true);
  });

  it('rejects email without @', () => {
    expect(isValidEmail('userexample.com')).toBe(false);
  });

  it('rejects email without domain', () => {
    expect(isValidEmail('user@')).toBe(false);
    expect(isValidEmail('user@.')).toBe(false);
  });

  it('rejects email with spaces', () => {
    expect(isValidEmail('user @example.com')).toBe(false);
    expect(isValidEmail(' user@example.com')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidEmail('')).toBe(false);
  });
});

// ============================================================
// isValidPlateNumber
// ============================================================
describe('isValidPlateNumber', () => {
  it('accepts valid Cuban plate format (letter + 5-6 digits)', () => {
    expect(isValidPlateNumber('P123456')).toBe(true);
    expect(isValidPlateNumber('T12345')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isValidPlateNumber('p123456')).toBe(true);
    expect(isValidPlateNumber('t12345')).toBe(true);
  });

  it('accepts plate with spaces/dashes', () => {
    expect(isValidPlateNumber('P 123456')).toBe(true);
    expect(isValidPlateNumber('P-123456')).toBe(true);
  });

  it('rejects plate with too few digits', () => {
    expect(isValidPlateNumber('P1234')).toBe(false);
  });

  it('rejects plate with too many digits', () => {
    expect(isValidPlateNumber('P1234567')).toBe(false);
  });

  it('rejects plate without leading letter', () => {
    expect(isValidPlateNumber('123456')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidPlateNumber('')).toBe(false);
  });
});

// ============================================================
// isValidCubaLatitude / isValidCubaLongitude
// ============================================================
describe('isValidCubaLatitude', () => {
  it('accepts latitude within Cuba (19.5 - 23.5)', () => {
    expect(isValidCubaLatitude(23.1365)).toBe(true); // Havana
    expect(isValidCubaLatitude(20.0247)).toBe(true); // Santiago de Cuba
    expect(isValidCubaLatitude(19.5)).toBe(true); // boundary
    expect(isValidCubaLatitude(23.5)).toBe(true); // boundary
  });

  it('rejects latitude outside Cuba', () => {
    expect(isValidCubaLatitude(19.4)).toBe(false);
    expect(isValidCubaLatitude(23.6)).toBe(false);
    expect(isValidCubaLatitude(25.7617)).toBe(false); // Miami
    expect(isValidCubaLatitude(0)).toBe(false);
  });
});

describe('isValidCubaLongitude', () => {
  it('accepts longitude within Cuba (-85.0 to -74.0)', () => {
    expect(isValidCubaLongitude(-82.3666)).toBe(true); // Havana
    expect(isValidCubaLongitude(-75.8219)).toBe(true); // Santiago de Cuba
    expect(isValidCubaLongitude(-85.0)).toBe(true); // boundary
    expect(isValidCubaLongitude(-74.0)).toBe(true); // boundary
  });

  it('rejects longitude outside Cuba', () => {
    expect(isValidCubaLongitude(-85.1)).toBe(false);
    expect(isValidCubaLongitude(-73.9)).toBe(false);
    expect(isValidCubaLongitude(0)).toBe(false);
  });

  it('note: Miami longitude (-80.19) overlaps Cuba range (only lat distinguishes)', () => {
    // Miami's longitude is within Cuba's longitude range
    // Distinction requires checking BOTH lat and lng (isLocationInCuba)
    expect(isValidCubaLongitude(-80.1918)).toBe(true);
  });
});

// ============================================================
// isLocationInCuba
// ============================================================
describe('isLocationInCuba', () => {
  it('accepts Havana coordinates', () => {
    expect(isLocationInCuba(23.1365, -82.3666)).toBe(true);
  });

  it('accepts Santiago de Cuba coordinates', () => {
    expect(isLocationInCuba(20.0247, -75.8219)).toBe(true);
  });

  it('rejects Miami coordinates', () => {
    expect(isLocationInCuba(25.7617, -80.1918)).toBe(false);
  });

  it('rejects Madrid coordinates', () => {
    expect(isLocationInCuba(40.4168, -3.7038)).toBe(false);
  });

  it('rejects when only lat is valid', () => {
    expect(isLocationInCuba(23.0, 0)).toBe(false);
  });

  it('rejects when only lng is valid', () => {
    expect(isLocationInCuba(0, -82.0)).toBe(false);
  });
});

// ============================================================
// isValidOTP
// ============================================================
describe('isValidOTP', () => {
  it('accepts 6-digit code', () => {
    expect(isValidOTP('123456')).toBe(true);
    expect(isValidOTP('000000')).toBe(true);
    expect(isValidOTP('999999')).toBe(true);
  });

  it('rejects code with fewer than 6 digits', () => {
    expect(isValidOTP('12345')).toBe(false);
    expect(isValidOTP('1')).toBe(false);
  });

  it('rejects code with more than 6 digits', () => {
    expect(isValidOTP('1234567')).toBe(false);
  });

  it('rejects code with letters', () => {
    expect(isValidOTP('12345a')).toBe(false);
    expect(isValidOTP('abcdef')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidOTP('')).toBe(false);
  });
});

// ============================================================
// sanitizeText
// ============================================================
describe('sanitizeText', () => {
  it('trims whitespace', () => {
    expect(sanitizeText('  hello  ')).toBe('hello');
  });

  it('preserves normal text', () => {
    expect(sanitizeText('Hola mundo')).toBe('Hola mundo');
  });

  it('removes control characters', () => {
    expect(sanitizeText('hello\x00world')).toBe('helloworld');
    expect(sanitizeText('test\x1Fvalue')).toBe('testvalue');
    expect(sanitizeText('del\x7Fete')).toBe('delete');
  });

  it('handles combined trim + control chars', () => {
    expect(sanitizeText('  \x00hello\x1F  ')).toBe('hello');
  });

  it('returns empty for whitespace-only input', () => {
    expect(sanitizeText('   ')).toBe('');
  });

  it('preserves unicode characters', () => {
    expect(sanitizeText('¡Hola! ñ á é')).toBe('¡Hola! ñ á é');
  });
});

// ============================================================
// maskPhone
// ============================================================
describe('maskPhone', () => {
  it('masks Cuban phone with country code', () => {
    expect(maskPhone('+5355123456')).toBe('+53 •••• 3456');
    expect(maskPhone('+5351234567')).toBe('+53 •••• 4567');
  });

  it('masks phone without country code', () => {
    expect(maskPhone('55123456')).toBe('•••• 3456');
    expect(maskPhone('51234567')).toBe('•••• 4567');
  });

  it('masks international phone with + prefix', () => {
    expect(maskPhone('+14155551234')).toBe('+1415 •••• 1234');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
    expect(maskPhone('')).toBe('');
  });

  it('handles very short numbers', () => {
    expect(maskPhone('123')).toBe('••••');
    expect(maskPhone('1234')).toBe('•••• 1234');
  });

  it('strips spaces and dashes before masking', () => {
    expect(maskPhone('+53 5512 3456')).toBe('+53 •••• 3456');
    expect(maskPhone('5512-3456')).toBe('•••• 3456');
  });
});
