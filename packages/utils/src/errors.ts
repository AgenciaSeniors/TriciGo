/**
 * Extract a user-friendly error message from any error object.
 * Distinguishes network errors, auth errors, validation errors, and server errors.
 * Handles: Error instances, string errors, objects with message property,
 * null/undefined, and any other unknown types.
 *
 * @param err - The error to extract a message from
 * @param t - Optional i18n translation function. When provided, returns localized
 *            error messages using translation keys. Falls back to Spanish when not provided.
 */
export function getErrorMessage(err: unknown, t?: (key: string, opts?: Record<string, unknown>) => string): string {
  // Null / undefined / falsy
  if (!err) return t ? t('errors.unexpected') : 'Error inesperado. Intenta de nuevo.';

  // Plain string errors
  if (typeof err === 'string') {
    return err.length > 0 && err.length < 300
      ? err
      : t ? t('errors.unexpected') : 'Error inesperado. Intenta de nuevo.';
  }

  // Network errors (no internet)
  if (err instanceof TypeError && err.message === 'Failed to fetch') {
    return t ? t('errors.network_error') : 'Sin conexión a internet. Verifica tu red e intenta de nuevo.';
  }
  if (err instanceof TypeError && err.message?.includes('Network request failed')) {
    return t ? t('errors.network_error') : 'Sin conexión a internet. Verifica tu red e intenta de nuevo.';
  }

  // Supabase/API errors with status codes
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;

    // HTTP status-based errors
    const status = e.status ?? e.statusCode ?? (e.code === 'PGRST301' ? 401 : undefined);
    if (status === 401 || status === 403) {
      return t ? t('errors.session_expired') : 'Sesión expirada. Inicia sesión de nuevo.';
    }
    if (status === 429) {
      return t ? t('errors.rate_limited') : 'Demasiados intentos. Espera un momento e intenta de nuevo.';
    }
    if (status === 400) {
      // Try to extract server message
      const msg = e.message ?? e.error_description ?? e.msg;
      if (typeof msg === 'string' && msg.length > 0 && msg.length < 200) return msg;
      return t ? t('errors.invalid_data') : 'Datos inválidos. Revisa la información e intenta de nuevo.';
    }
    if (typeof status === 'number' && status >= 500) {
      return t ? t('errors.server_error') : 'Error del servidor. Intenta más tarde.';
    }

    // Supabase error format
    if (typeof e.message === 'string') {
      if (e.message.includes('JWT expired') || e.message.includes('token is expired')) {
        return t ? t('errors.session_expired') : 'Sesión expirada. Inicia sesión de nuevo.';
      }
      if (e.message.includes('duplicate key') || e.message.includes('already exists')) {
        return t ? t('errors.duplicate_record') : 'Este registro ya existe.';
      }
      // Return message if it's reasonable length
      if (e.message.length > 0 && e.message.length < 200) return e.message;
    }

    // Objects with error_description (OAuth-style errors)
    if (typeof e.error_description === 'string' && e.error_description.length > 0 && e.error_description.length < 200) {
      return e.error_description;
    }

    // Objects with error property as string
    if (typeof e.error === 'string' && e.error.length > 0 && e.error.length < 200) {
      return e.error;
    }
  }

  if (err instanceof Error) {
    if (err.message.includes('fetch') || err.message.includes('network')) {
      return t ? t('errors.network_error') : 'Sin conexión a internet. Verifica tu red e intenta de nuevo.';
    }
    if (err.message.length > 0 && err.message.length < 200) return err.message;
  }

  return t ? t('errors.unexpected') : 'Error inesperado. Intenta de nuevo.';
}
