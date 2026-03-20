// ============================================================
// TriciGo — Theme Store
// Persisted dark/light/system theme preference using Zustand
// ============================================================

import { createStore } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeState {
  mode: ThemeMode;
  /** Resolved color scheme (never 'system') */
  resolvedScheme: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  setSystemScheme: (scheme: 'light' | 'dark') => void;
}

/**
 * Create a theme store instance.
 * Apps should create their own instance and persist it with AsyncStorage.
 */
export function createThemeStore(initialMode: ThemeMode = 'light') {
  return createStore<ThemeState>((set, get) => ({
    mode: initialMode,
    resolvedScheme: initialMode === 'system' ? 'light' : initialMode,
    setMode: (mode) => {
      const systemScheme = get().resolvedScheme;
      set({
        mode,
        resolvedScheme: mode === 'system' ? systemScheme : mode,
      });
    },
    setSystemScheme: (scheme) => {
      const { mode } = get();
      if (mode === 'system') {
        set({ resolvedScheme: scheme });
      }
    },
  }));
}
