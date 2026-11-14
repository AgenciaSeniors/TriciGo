import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supportContactService } from '@tricigo/api';
import { resolveSupportPhone, type SupportPhoneStore } from '@tricigo/utils';

const store: SupportPhoneStore = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

/**
 * The support WhatsApp number from the server (operator on shift, else the last one), or the
 * last number received when offline. `null` when none is known: the screens then hide WhatsApp.
 */
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
