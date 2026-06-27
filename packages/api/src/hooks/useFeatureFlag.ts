import { useState, useEffect } from 'react';
import { getSupabaseClient } from '../client';

const cache = new Map<string, { value: boolean; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Feature flag with an explicit `loading` state. `loading` is true until the
 * flag resolves — instantly from the 5-min cache, or from `feature_flags` on a
 * fresh load. Use this (instead of `useFeatureFlag`) when a false default would
 * FLASH the wrong UI before the real value arrives — e.g. a flag-gated page that
 * would otherwise show "no disponible" for one frame before rendering.
 */
export function useFeatureFlagState(
  key: string,
  defaultValue = false,
): { value: boolean; loading: boolean } {
  const [value, setValue] = useState(() => {
    const c = cache.get(key);
    return c && c.expiresAt > Date.now() ? c.value : defaultValue;
  });
  const [loading, setLoading] = useState(() => {
    const c = cache.get(key);
    return !(c && c.expiresAt > Date.now());
  });

  useEffect(() => {
    const c = cache.get(key);
    if (c && c.expiresAt > Date.now()) {
      setValue(c.value);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchFlag() {
      try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
          .from('feature_flags')
          .select('value')
          .eq('key', key)
          .single();

        if (!cancelled) {
          if (!error && data) {
            const val = data.value === true || data.value === 'true';
            cache.set(key, { value: val, expiresAt: Date.now() + CACHE_TTL });
            setValue(val);
          }
          setLoading(false);
        }
      } catch {
        // Keep the default value on error.
        if (!cancelled) setLoading(false);
      }
    }

    fetchFlag();
    return () => { cancelled = true; };
  }, [key]);

  return { value, loading };
}

/**
 * Boolean-only feature flag. Returns `defaultValue` while loading and on error.
 * Unchanged behavior — delegates to useFeatureFlagState.
 */
export function useFeatureFlag(key: string, defaultValue = false): boolean {
  return useFeatureFlagState(key, defaultValue).value;
}
