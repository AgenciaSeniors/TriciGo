// ============================================================
// TriciGo Client — Theme Store (persisted with AsyncStorage)
// ============================================================

import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { useStore } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createThemeStore, type ThemeMode } from '@tricigo/theme';

const THEME_STORAGE_KEY = '@tricigo/theme_mode';

// Singleton store instance
const themeStore = createThemeStore('light');

// Load persisted theme on startup
AsyncStorage.getItem(THEME_STORAGE_KEY).then((stored) => {
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    // Appearance.getColorScheme() is typed ColorSchemeName which in
    // some RN .d.ts versions widens to include 'no-preference' or
    // similar string literals. Normalize explicitly to the 'light' |
    // 'dark' accepted by setSystemScheme.
    const raw = Appearance.getColorScheme();
    const systemScheme: 'light' | 'dark' = raw === 'dark' ? 'dark' : 'light';
    themeStore.getState().setSystemScheme(systemScheme);
    themeStore.getState().setMode(stored);
  }
}).catch(() => {});

/**
 * Hook to access and control the theme.
 */
export function useThemeStore<T>(selector: (state: ReturnType<typeof themeStore.getState>) => T): T {
  return useStore(themeStore, selector);
}

/**
 * Set theme mode and persist to AsyncStorage.
 */
export function setThemeMode(mode: ThemeMode) {
  themeStore.getState().setMode(mode);
  AsyncStorage.setItem(THEME_STORAGE_KEY, mode).catch(() => {});
}

/**
 * Hook that syncs system appearance changes with the theme store.
 * Call this once in the root layout.
 */
export function useSystemThemeSync() {
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      // Normalize like the boot-time block above.
      const systemScheme: 'light' | 'dark' = colorScheme === 'dark' ? 'dark' : 'light';
      themeStore.getState().setSystemScheme(systemScheme);
    });
    return () => subscription.remove();
  }, []);
}

/**
 * Get the store instance directly (for non-React contexts).
 */
export { themeStore };
