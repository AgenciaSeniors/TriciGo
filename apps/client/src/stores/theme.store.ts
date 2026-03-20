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
    const systemScheme = Appearance.getColorScheme() ?? 'light';
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
      themeStore.getState().setSystemScheme(colorScheme ?? 'light');
    });
    return () => subscription.remove();
  }, []);
}

/**
 * Get the store instance directly (for non-React contexts).
 */
export { themeStore };
