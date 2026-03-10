import { useState, useEffect } from 'react';
import { getSupabaseClient } from '../client';

const cache = new Map<string, { value: boolean; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function useFeatureFlag(key: string, defaultValue = false): boolean {
  const [enabled, setEnabled] = useState(() => {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    return defaultValue;
  });

  useEffect(() => {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      setEnabled(cached.value);
      return;
    }

    let cancelled = false;

    async function fetch() {
      try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
          .from('feature_flags')
          .select('value')
          .eq('key', key)
          .single();

        if (!cancelled && !error && data) {
          const val = data.value === true || data.value === 'true';
          cache.set(key, { value: val, expiresAt: Date.now() + CACHE_TTL });
          setEnabled(val);
        }
      } catch {
        // Use default value on error
      }
    }

    fetch();
    return () => { cancelled = true; };
  }, [key]);

  return enabled;
}
