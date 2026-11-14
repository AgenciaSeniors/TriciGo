'use client';

import { useEffect, useState } from 'react';
import { supportContactService } from '@tricigo/api';
import { resolveSupportPhone, type SupportPhoneStore } from '@tricigo/utils';

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

/** Support WhatsApp number from the server, else the last one received; null when unknown. */
export function useSupportPhone(): { phone: string | null; loading: boolean } {
  const [phone, setPhone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    resolveSupportPhone(() => supportContactService.fetch(), store)
      .then((value) => {
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
