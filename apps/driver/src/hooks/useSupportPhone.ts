import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supportContactService } from '@tricigo/api';
import { readCachedSupportPhone, resolveSupportPhone, type SupportPhoneStore } from '@tricigo/utils';

const store: SupportPhoneStore = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

/**
 * The support WhatsApp number: the last one received (cached) at once, then the server's answer
 * (operator on shift, else the last one), which replaces it, also with null when the server knows
 * none. The cache alone stays when the server cannot be reached. `null` when no number is known:
 * the screens then hide WhatsApp. `loading` is true until the server answered or failed.
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
