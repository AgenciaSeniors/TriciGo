import { describe, expect, it } from 'vitest';
import { buildSosSmsBody, cleanSmsField, smsPersonName, validCoordinates } from './sos-message';

describe('cleanSmsField', () => {
  it('collapses whitespace and strips control characters', () => {
    expect(cleanSmsField('  Ana \n\t María\u0000 ', 40)).toBe('Ana María');
  });

  it('truncates to the limit', () => {
    expect(cleanSmsField('a'.repeat(100), 40)).toHaveLength(40);
  });

  it('returns null for empty or non-string input', () => {
    expect(cleanSmsField('   ', 40)).toBeNull();
    expect(cleanSmsField(null, 40)).toBeNull();
    expect(cleanSmsField(undefined, 40)).toBeNull();
    expect(cleanSmsField(42 as unknown as string, 40)).toBeNull();
  });
});

describe('validCoordinates', () => {
  it('accepts real coordinates', () => {
    expect(validCoordinates(23.1357, -82.3666)).toBe(true);
    expect(validCoordinates(0, 0)).toBe(true);
  });

  it.each([
    [91, 0],
    [0, 181],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    ['23' as unknown as number, -82],
  ])('rejects %s,%s', (lat, lng) => {
    expect(validCoordinates(lat, lng)).toBe(false);
  });
});

describe('buildSosSmsBody', () => {
  const base = { latitude: 23.13571234, longitude: -82.36661234, riderName: null, driverName: null, vehiclePlate: null, rideRef: null };

  it('rounds the coordinates in the maps link', () => {
    expect(buildSosSmsBody(base, 'es')).toContain('https://maps.google.com/?q=23.135712,-82.366612');
  });

  it('falls back to a generic name', () => {
    expect(buildSosSmsBody(base, 'es')).toMatch(/^EMERGENCIA: Un usuario de TriciGo envió un SOS/);
  });

  it('includes the driver, plate and ride reference when given', () => {
    const body = buildSosSmsBody(
      { ...base, riderName: 'Ana', driverName: 'Luis', vehiclePlate: 'P123456', rideRef: 'abcdef12' },
      'es',
    );
    expect(body).toContain('EMERGENCIA: Ana envió un SOS');
    expect(body).toContain('Conductor: Luis / P123456.');
    expect(body).toContain('Ride: abcdef12.');
  });

  it('uses the requested locale', () => {
    expect(buildSosSmsBody(base, 'en')).toMatch(/^EMERGENCY: /);
    expect(buildSosSmsBody(base, 'pt')).toMatch(/^EMERGÊNCIA: /);
  });

  it('never starts with an emoji (carriers drop those)', () => {
    expect(buildSosSmsBody(base, 'es').codePointAt(0)).toBeLessThan(0x2000);
  });
});

describe('smsPersonName', () => {
  it('keeps the first name and the next initial', () => {
    expect(smsPersonName('Ana María Pérez')).toBe('Ana M.');
    expect(smsPersonName('Yunior')).toBe('Yunior');
  });

  it('drops links, digits and symbols an owner could put in their name', () => {
    expect(smsPersonName('Visita bit.ly/x para cobrar')).toBe('Visita B.');
    expect(smsPersonName('https://evil.example 5355555555')).toBe('httpsevilexample');
    expect(smsPersonName('$$$ 123')).toBeNull();
  });

  it('caps the first word', () => {
    expect(smsPersonName('A'.repeat(50))).toBe('A'.repeat(20));
  });

  it('returns null for empty or non-string input', () => {
    expect(smsPersonName('   ')).toBeNull();
    expect(smsPersonName(null)).toBeNull();
  });
});
