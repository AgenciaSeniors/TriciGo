// ============================================================
// TriciGo — Theme Store
// Persisted dark/light/system theme preference using Zustand
// ============================================================

import { createStore } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ContextMode = 'map' | 'standard';

export interface ThemeState {
  mode: ThemeMode;
  /** Resolved color scheme (never 'system') */
  resolvedScheme: 'light' | 'dark';
  /** Context mode: 'map' forces dark scheme, 'standard' respects user preference */
  contextMode: ContextMode;
  setMode: (mode: ThemeMode) => void;
  setSystemScheme: (scheme: 'light' | 'dark') => void;
  setContextMode: (mode: ContextMode) => void;
}

/**
 * Create a theme store instance.
 * Apps should create their own instance and persist it with AsyncStorage.
 */
export function createThemeStore(initialMode: ThemeMode = 'light') {
  /** Compute resolved scheme considering context mode */
  function resolveScheme(mode: ThemeMode, systemScheme: 'light' | 'dark', contextMode: ContextMode): 'light' | 'dark' {
    // Map context always forces dark
    if (contextMode === 'map') return 'dark';
    // Standard context respects user preference
    if (mode === 'system') return systemScheme;
    return mode;
  }

  return createStore<ThemeState>((set, get) => ({
    mode: initialMode,
    resolvedScheme: initialMode === 'system' ? 'light' : initialMode,
    contextMode: 'standard',
    setMode: (mode) => {
      const { resolvedScheme, contextMode } = get();
      const systemScheme = resolvedScheme; // best approximation of current system scheme
      set({
        mode,
        resolvedScheme: resolveScheme(mode, systemScheme, contextMode),
      });
    },
    setSystemScheme: (scheme) => {
      const { mode, contextMode } = get();
      set({ resolvedScheme: resolveScheme(mode, scheme, contextMode) });
    },
    setContextMode: (contextMode) => {
      const { mode, resolvedScheme } = get();
      const systemScheme = resolvedScheme;
      set({
        contextMode,
        resolvedScheme: resolveScheme(mode, systemScheme, contextMode),
      });
    },
  }));
}
