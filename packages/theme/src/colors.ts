// ============================================================
// TriciGo — Color System
// Based on the TriciGo Visual Identity V1.0
// ============================================================

export const colors = {
  // Brand colors
  brand: {
    /** Trici Black — Carbón Profundo. Primary dark color. */
    black: '#111111',
    /** Go Orange — Lava Vibrante. Accent & CTA color. */
    orange: '#FF4D00',
    /** Pure white for contrast. */
    white: '#FFFFFF',
  },

  // Semantic colors
  primary: {
    50: '#FFF3ED',
    100: '#FFE4D4',
    200: '#FFC5A8',
    300: '#FF9E71',
    400: '#FF6D38',
    500: '#FF4D00', // Go Orange
    600: '#E64400',
    700: '#BF3800',
    800: '#992D00',
    900: '#7A2400',
    950: '#421100',
  },

  neutral: {
    50: '#F9F9F9',
    100: '#F0F0F0',
    200: '#E4E4E4',
    300: '#D1D1D1',
    400: '#A3A3A3',
    500: '#737373',
    600: '#525252',
    700: '#404040',
    800: '#262626',
    900: '#171717',
    950: '#111111', // Trici Black
  },

  // Functional colors
  success: {
    light: '#D1FAE5',
    DEFAULT: '#10B981',
    dark: '#065F46',
  },

  warning: {
    light: '#FEF3C7',
    DEFAULT: '#F59E0B',
    dark: '#92400E',
  },

  error: {
    light: '#FEE2E2',
    DEFAULT: '#EF4444',
    dark: '#991B1B',
  },

  info: {
    light: '#DBEAFE',
    DEFAULT: '#3B82F6',
    dark: '#1E40AF',
  },

  // Background variations
  background: {
    primary: '#FFFFFF',
    secondary: '#F9F9F9',
    tertiary: '#F0F0F0',
    dark: '#111111',
    darkSecondary: '#1A1A1A',
  },

  // Text variations
  text: {
    primary: '#111111',
    secondary: '#525252',
    tertiary: '#737373',
    inverse: '#FFFFFF',
    accent: '#FF4D00',
  },
} as const;

export type ColorToken = typeof colors;
