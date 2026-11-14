'use client';

import { useEffect, useState } from 'react';
import { supportContactService } from '@tricigo/api';
import { readCachedSupportPhone, resolveSupportPhone, type SupportPhoneStore } from '@tricigo/utils';

// localStorage is only touched inside effects (SSR-safe) and always inside try/catch
// (private mode, blocked storage).
const store: SupportPhoneStore = {
  getItem: async (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: async (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
  removeItem: async (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  },
};

/**
 * Support WhatsApp number: the last one received (cached) at once, then the server's answer, which
 * replaces it (also with null when the server knows none); the cache alone stays when the server
 * cannot be reached. Null when unknown. `loading` is true until the server answered or failed.
 */
export function useSupportPhone(): { phone: string | null; loading: boolean } {
  const [phone, setPhone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // The server's answer wins, even when the cache read resolves after it.
    let answered = false;
    void readCachedSupportPhone(store).then((cached) => {
      if (!cancelled && !answered && cached) setPhone(cached);
    });
    resolveSupportPhone(() => supportContactService.fetch(), store)
      .then((value) => {
        answered = true;
        if (!cancelled) setPhone(value);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { phone, loading };
}
