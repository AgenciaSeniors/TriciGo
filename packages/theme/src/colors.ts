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

  // Surface tokens (dark mode cards, modals, overlays)
  surface: {
    card: '#1a1a2e',
    elevated: '#252540',
    overlay: 'rgba(13,13,26,0.85)',
    input: '#1a1a2e',
    /** Subtle pressed/hover state */
    pressed: '#252540',
  },

  // Border tokens
  border: {
    subtle: 'rgba(255,255,255,0.06)',
    default: 'rgba(255,255,255,0.12)',
    strong: 'rgba(255,255,255,0.20)',
    accent: '#FF4D00',
  },

  // Profit level indicators (always use with icon + text, never color-only)
  profit: {
    high: '#22C55E',
    medium: '#F59E0B',
    low: '#EF4444',
  },

  // Status indicators
  status: {
    online: '#22C55E',
    busy: '#F59E0B',
    offline: '#6B7280',
    verified: '#22C55E',
    pending: '#F59E0B',
    rejected: '#EF4444',
  },
} as const;

// ============================================================
// Dark Mode Tokens — Foundation
// Used by mobile (NativeWind dark:) and web (CSS variables)
// ============================================================

export const darkColors = {
  background: {
    primary: '#0d0d1a',
    secondary: '#1a1a2e',
    tertiary: '#252540',
    dark: '#0d0d1a',
    darkSecondary: '#1a1a2e',
  },
  text: {
    primary: '#f5f5f5',
    secondary: '#a0a0a0',
    tertiary: '#8a8a8a',
    inverse: '#111111',
    accent: '#FF6D38',
  },
  border: {
    default: '#333333',
    light: '#222222',
  },
  card: '#1a1a2e',
  hover: '#252540',
} as const;

// ============================================================
// Driver App — Uber-style Dark Theme
// Deeper blacks, orange on dark, minimal blue tints
// ============================================================

export const driverDarkColors = {
  background: {
    primary: '#0a0a0a',
    secondary: '#141414',
    tertiary: '#1e1e1e',
    dark: '#0a0a0a',
    darkSecondary: '#141414',
  },
  text: {
    primary: '#f5f5f5',
    secondary: '#a0a0a0',
    tertiary: '#666666',
    inverse: '#111111',
    accent: '#FF4D00',
  },
  border: {
    default: '#2a2a2a',
    light: '#1e1e1e',
  },
  card: '#141414',
  hover: '#1e1e1e',
  /** Driver-specific: header bar background */
  header: '#0a0a0a',
  /** Driver-specific: tab bar background */
  tabBar: '#0a0a0a',
  /** Driver-specific: active tab accent */
  tabActive: '#FF4D00',
} as const;

export const driverLightColors = {
  background: {
    primary: '#FFFFFF',
    secondary: '#F5F5F5',
    tertiary: '#EBEBEB',
    dark: '#111111',
    darkSecondary: '#1A1A1A',
  },
  text: {
    primary: '#111111',
    secondary: '#525252',
    tertiary: '#737373',
    inverse: '#FFFFFF',
    accent: '#FF4D00',
  },
  border: {
    default: '#E4E4E4',
    light: '#F0F0F0',
  },
  card: '#FFFFFF',
  hover: '#F5F5F5',
  /** Driver-specific: header bar background (black header on light) */
  header: '#111111',
  /** Driver-specific: tab bar background */
  tabBar: '#FFFFFF',
  /** Driver-specific: active tab accent */
  tabActive: '#FF4D00',
} as const;

// ============================================================
// Driver App — Dual Theme: Map Dark + Standard Light
// Map dark: optimized for map overlay visibility
// Standard light: for non-map screens (earnings, settings, etc.)
// ============================================================

/** Map/navigation dark theme colors — optimized for map overlay visibility */
export const driverMapDarkColors = {
  background: {
    primary: '#0a0a0f',
    secondary: '#141418',
    tertiary: '#1c1c24',
  },
  text: {
    primary: '#F1F1F3',
    secondary: '#8A8F98',
    tertiary: '#5A5E66',
    inverse: '#0F172A',
    accent: '#FF4D00',
  },
  border: {
    subtle: 'rgba(255,255,255,0.08)',
    default: 'rgba(255,255,255,0.14)',
    strong: 'rgba(255,255,255,0.22)',
  },
  card: '#141418',
  elevated: '#1c1c24',
  sheetBackground: '#141418',
  sheetHandle: 'rgba(255,255,255,0.2)',
} as const;

/** Standard light theme colors — for non-map screens */
export const driverStandardLightColors = {
  background: {
    primary: '#F8FAFC',
    secondary: '#FFFFFF',
    tertiary: '#F1F5F9',
  },
  text: {
    primary: '#0F172A',
    secondary: '#64748B',
    tertiary: '#94A3B8',
    inverse: '#FFFFFF',
    accent: '#FF4D00',
  },
  border: {
    subtle: '#F1F5F9',
    default: '#E2E8F0',
    strong: '#CBD5E1',
  },
  card: '#FFFFFF',
  elevated: '#F8FAFC',
  sheetBackground: '#FFFFFF',
  sheetHandle: '#CBD5E1',
} as const;

// ============================================================
// Cuban Modern — Client home redesign palette (light + dark)
//
// Reference: docs/DESIGN_CLIENT_HOME.md §2
// Used by the redesigned passenger home to achieve the "cuban modern"
// aesthetic — warm, grounded, honest. Stays compatible with the
// existing brand.orange token.
// ============================================================

export const cubanLight = {
  bg: {
    paper: '#FFFBF5',      // Main background — tibia crema, no white clínico
    elev1: '#FFFFFF',       // Cards, inputs, sheets
    elev2: '#F4EEE2',       // Outer frame, subtle contrast
  },
  ink: {
    primary: '#1A1414',     // Headings, body principal (casi negro cálido)
    secondary: '#6B7F8F',   // Labels, secondary text
    subtle: '#A9B4BC',      // Placeholders, meta, disabled
  },
  accent: {
    orange: '#FF4D00',      // Primary accent (brand)
    orangeGlow: 'rgba(255, 77, 0, 0.18)',
    warm: '#FFB547',        // Secondary — precios, badges, highlights cálidos
    dusk: '#6B7F8F',        // Azul ceniza — dividers, accent frío
  },
  line: 'rgba(26, 20, 20, 0.08)',
  shadow: {
    card: '0 2px 20px rgba(30, 20, 10, 0.04), 0 1px 2px rgba(30, 20, 10, 0.06)',
    hero: '0 8px 40px rgba(255, 77, 0, 0.15), 0 2px 6px rgba(30, 20, 10, 0.08)',
  },
} as const;

export const cubanDark = {
  bg: {
    paper: '#0A0E1A',       // Main background — navy profundo
    elev1: '#11172A',       // Cards, inputs
    elev2: '#18203A',       // Outer frame / modal backdrop
  },
  ink: {
    primary: '#F4F0EA',     // Texto — crema tibia, no white clínico
    secondary: '#B7C4CF',   // Secondary
    subtle: '#6B7F8F',      // Placeholders
  },
  accent: {
    orange: '#FF4D00',
    orangeGlow: 'rgba(255, 77, 0, 0.25)',
    warm: '#FFB547',
    dusk: '#4A6278',        // Dusk más oscuro para dark bg
  },
  line: 'rgba(244, 240, 234, 0.08)',
  shadow: {
    card: '0 2px 20px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.4)',
    hero: '0 8px 40px rgba(255, 77, 0, 0.25), 0 2px 6px rgba(0, 0, 0, 0.5)',
  },
} as const;

export type CubanToken = typeof cubanLight;

export type ColorToken = typeof colors;
export type DarkColorToken = typeof darkColors;
export type DriverDarkColorToken = typeof driverDarkColors;
export type DriverLightColorToken = typeof driverLightColors;
export type DriverMapDarkColorToken = typeof driverMapDarkColors;
export type DriverStandardLightColorToken = typeof driverStandardLightColors;
