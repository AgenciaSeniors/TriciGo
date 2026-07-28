import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../errors';

const NETWORK_ES = 'Sin conexión a internet. Verifica tu red e intenta de nuevo.';
const SESSION_ES = 'Sesión expirada. Inicia sesión de nuevo.';
const GENERIC = 'Error inesperado. Intenta de nuevo.';

describe('getErrorMessage', () => {
  it('returns the generic message for null / undefined', () => {
    expect(getErrorMessage(null)).toBe(GENERIC);
    expect(getErrorMessage(undefined)).toBe(GENERIC);
  });

  it('returns the generic message when the error carries no message at all', () => {
    expect(getErrorMessage(new Error(''))).toBe(GENERIC);
    expect(getErrorMessage('')).toBe(GENERIC);
    expect(getErrorMessage({})).toBe(GENERIC);
  });

  it('passes short messages through unchanged', () => {
    expect(getErrorMessage(new Error('customer_has_active_ride'))).toBe('customer_has_active_ride');
    expect(getErrorMessage('ride_rate_limited')).toBe('ride_rate_limited');
  });

  it('maps HTTP status codes before reading the message', () => {
    expect(getErrorMessage({ status: 401, message: 'nope' })).toContain('Sesión expirada');
    expect(getErrorMessage({ status: 429 })).toContain('Demasiados intentos');
    expect(getErrorMessage({ status: 503 })).toContain('Error del servidor');
  });

  // The bug this file was written for: a rider outside Cuba tapped "Solicitar",
  // Zod rejected all four coordinates, and the resulting 264-char message was
  // silently discarded — the toast said "Error inesperado" and the real reason
  // never reached the user (or the logs they could read). Long messages must be
  // clipped for display, never dropped.
  it('clips an overlong message instead of discarding it', () => {
    const long = `Validation error: ${'pickup_latitude: Number must be greater than or equal to 19.5; '.repeat(4)}`;
    expect(long.length).toBeGreaterThan(200);

    const result = getErrorMessage(new Error(long));

    expect(result).not.toBe(GENERIC);
    expect(result.startsWith('Validation error: pickup_latitude')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('…')).toBe(true);
  });

  it('clips an overlong bare string', () => {
    const long = 'x'.repeat(500);

    const result = getErrorMessage(long);

    expect(result).not.toBe(GENERIC);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result.endsWith('…')).toBe(true);
  });

  it('clips an overlong message on a 400 response', () => {
    const long = `bad request: ${'y'.repeat(400)}`;

    const result = getErrorMessage({ status: 400, message: long });

    expect(result.startsWith('bad request: yyy')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  // useRide/book branch on the text of this message to show the Spanish
  // "fuera del área de servicio" toast, so it has to survive the round trip
  // through a ValidationError (an Error subclass carrying statusCode 400).
  it('preserves the message of a 400-status AppError', () => {
    const err = Object.assign(new Error('Dropoff location is outside the service area'), {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });

    expect(getErrorMessage(err)).toBe('Dropoff location is outside the service area');
  });

  it('uses the localized generic message when a translator is provided', () => {
    const t = (key: string) => `t:${key}`;
    expect(getErrorMessage(null, t)).toBe('t:errors.unexpected');
    expect(getErrorMessage(new Error(''), t)).toBe('t:errors.unexpected');
  });

  // supabase-js/postgrest-js do NOT reject with a TypeError when the request
  // never reaches the server — they RESOLVE with this plain object. The
  // `err instanceof TypeError` branches therefore never fire for a Supabase
  // call, and without an explicit branch the raw English string reached the
  // user (verified against @supabase/postgrest-js dist/index.cjs).
  describe('Supabase transport failures (plain object, not a TypeError)', () => {
    it('maps the React Native shape to the friendly network message', () => {
      expect(
        getErrorMessage({
          message: 'TypeError: Network request failed',
          details: '',
          hint: '',
          code: '',
          status: 0,
        }),
      ).toBe(NETWORK_ES);
    });

    it('maps the browser shape', () => {
      expect(
        getErrorMessage({
          message: 'TypeError: Failed to fetch',
          details: '',
          hint: '',
          code: '',
          status: 0,
        }),
      ).toBe(NETWORK_ES);
    });

    it('maps a FetchError with no status field', () => {
      expect(
        getErrorMessage({ message: 'FetchError: request to ... failed', code: '' }),
      ).toBe(NETWORK_ES);
    });

    it('uses the translator when one is provided', () => {
      const t = (key: string) => `t:${key}`;
      expect(getErrorMessage({ message: 'TypeError: Network request failed', code: '', status: 0 }, t))
        .toBe('t:errors.network_error');
    });
  });

  describe('session_expired sentinel', () => {
    // Thrown by driverService.setOnlineStatus when the pre-check returns zero
    // rows AND there is no local session (anon fallback), so the raw sentinel
    // must never reach the UI.
    it('maps the sentinel thrown as an Error', () => {
      expect(getErrorMessage(new Error('session_expired'))).toBe(SESSION_ES);
    });

    it('maps the sentinel with a translator', () => {
      const t = (key: string) => `t:${key}`;
      expect(getErrorMessage(new Error('session_expired'), t)).toBe('t:errors.session_expired');
    });
  });

  // Guard against the new branches swallowing unrelated errors.
  describe('does not over-match', () => {
    it('still surfaces a genuine trigger error verbatim', () => {
      const msg =
        'driver_has_no_active_vehicle_for_online: register an active vehicle before going online (driver d-1)';
      expect(getErrorMessage({ message: msg, code: 'P0001' })).toBe(msg);
    });

    it('still maps 401 to session expired', () => {
      expect(getErrorMessage({ status: 401, message: 'Unauthorized' })).toBe(SESSION_ES);
    });

    it('does not treat a business message mentioning the network as a transport failure', () => {
      const msg = 'No se pudo conectar al conductor';
      expect(getErrorMessage({ message: msg, code: 'P0001' })).toBe(msg);
    });

    it('keeps returning plain strings untouched', () => {
      expect(getErrorMessage('Algo salió mal')).toBe('Algo salió mal');
    });
  });
});
