// ============================================================
// TriciGo Driver — Theme Store (persisted with AsyncStorage)
// ============================================================

import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { useStore } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createThemeStore, type ThemeMode, type ContextMode } from '@tricigo/theme';

const THEME_STORAGE_KEY = '@tricigo/theme_mode';

// Singleton store instance — driver uses forced dark backgrounds via Screen bg="dark"
// but NativeWind stays in light mode so color="inverse" gives white text.
const themeStore = createThemeStore('light');

// Load persisted theme on startup
AsyncStorage.getItem(THEME_STORAGE_KEY).then((stored) => {
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    const systemScheme = (Appearance.getColorScheme() ?? 'light') as 'light' | 'dark';
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
 * Set context mode ('map' forces dark, 'standard' respects user preference).
 * Not persisted — resets to 'standard' on app restart.
 */
export function setContextMode(mode: ContextMode) {
  themeStore.getState().setContextMode(mode);
}

/**
 * Hook that syncs system appearance changes with the theme store.
 * Call this once in the root layout.
 */
export function useSystemThemeSync() {
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      themeStore.getState().setSystemScheme((colorScheme ?? 'light') as 'light' | 'dark');
    });
    return () => subscription.remove();
  }, []);
}

export { themeStore };
