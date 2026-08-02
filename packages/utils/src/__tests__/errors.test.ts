import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../errors';

const NETWORK_ES = 'Sin conexión a internet. Verifica tu red e intenta de nuevo.';
const SESSION_ES = 'Sesión expirada. Inicia sesión de nuevo.';

describe('getErrorMessage', () => {
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
