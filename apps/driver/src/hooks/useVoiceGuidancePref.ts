/**
 * useVoiceGuidancePref — persisted on/off toggle for TTS driver navigation.
 *
 * Reads the preference from AsyncStorage on mount (default: enabled),
 * and persists any change the driver makes. Exposed as a simple
 * [enabled, setEnabled] tuple.
 *
 * Reference: N1 from ride-flow review.
 */
import { useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'tricigo:driver:voice_guidance_enabled';

export function useVoiceGuidancePref(): readonly [boolean, (v: boolean) => void] {
  const [enabled, setEnabledState] = useState(true);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => {
        if (cancelled) return;
        // Only treat explicit "false" as disabled. Absent key => enabled.
        if (v === 'false') setEnabledState(false);
      })
      .catch(() => {
        // Storage failure is non-fatal; keep default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    AsyncStorage.setItem(STORAGE_KEY, value ? 'true' : 'false').catch(() => {
      // Best-effort; in-memory state is already updated.
    });
  }, []);

  return [enabled, setEnabled] as const;
}
