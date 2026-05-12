// ============================================================
// TriciGo — Midnight Ember (Driver Design System)
// ============================================================
//
// Sistema formal del driver app. Reemplaza progresivamente las 4 paletas
// fragmentadas legacy (driverDarkColors / driverLightColors / driverMapDark /
// driverStandardLight) con un único token semántico organizado por:
//
//   - Submodo: `map` (pantallas con mapa overlay — deep dark)
//             vs `screen` (earnings/profile/settings — gray light estándar)
//   - Uso: `bg`, `text`, `line`, `accent`, `state`, `tripPhase`
//
// Los componentes deben leer SOLO desde aquí. Si un valor falta,
// agrégalo al sistema, no inline.
//
// Filosofía:
//   1. Una sola familia accent (orange) con escala de intensidad por estado.
//      NO rainbow de colores por trip phase.
//   2. Tipografía driver-específica con `data` (mono tabular) para números.
//      Hero único por pantalla (Linear-style).
//   3. Motion con diccionario cerrado: 7 propósitos válidos. Cualquier
//      animación fuera del set es violación de sistema (radarSweep,
//      idlePulse, glowRing están prohibidos).
//   4. Radius/shadow nombrados por uso (tap/card/sheet/hero) no por tamaño.
//
// Referencia: análisis críticos visuales del driver
// (IncomingRideCard / Home / TripView / Earnings / Profile)
// realizados durante la fase 3 del plan.
// ============================================================

// ──────────────────────────────────────────────────────────
// Color
// ──────────────────────────────────────────────────────────

/** Driver — submodo mapa activo (home idle, home online, trip view) */
export const midnightEmberMap = {
  bg: {
    /** Lo más oscuro — fondo del mapa cuando hay overlay. */
    canvas: '#08080C',
    /** Cards/sheets sobre canvas. */
    surface: '#12131A',
    /** Sheets levantadas (incoming ride card, bottom sheet alta). */
    elevated: '#1B1D26',
    /** Inputs, áreas presionadas. */
    sunken: '#05060A',
  },
  text: {
    primary: '#F5F6FA',
    secondary: '#9CA3B5',
    tertiary: '#5C6478',
    inverse: '#08080C',
    /** Texto sobre accent (orange). */
    onAccent: '#FFFFFF',
  },
  line: {
    hairline: 'rgba(255,255,255,0.06)',
    default: 'rgba(255,255,255,0.12)',
    strong: 'rgba(255,255,255,0.20)',
  },
} as const;

/** Driver — submodo pantalla estándar (earnings, profile, settings) */
export const midnightEmberScreen = {
  bg: {
    canvas: '#F8FAFC',
    surface: '#FFFFFF',
    elevated: '#FFFFFF',
    sunken: '#F1F5F9',
  },
  text: {
    primary: '#0F172A',
    secondary: '#475569',
    tertiary: '#94A3B8',
    inverse: '#FFFFFF',
    onAccent: '#FFFFFF',
  },
  line: {
    hairline: '#F1F5F9',
    default: '#E2E8F0',
    strong: '#CBD5E1',
  },
} as const;

/**
 * Accent — UNA familia. Intensidad por estado/jerarquía.
 * Usar SIEMPRE estos valores; nunca hex inline en componentes.
 */
export const midnightEmberAccent = {
  50: '#FFF3ED',
  100: '#FFE4D4',
  200: '#FFC5A8',
  300: '#FF9E71',
  400: '#FF6D38',
  /** Brand canónico — Go Orange. */
  500: '#FF4D00',
  600: '#E64400',
  700: '#BF3800',
  800: '#992D00',
  900: '#7A2400',
  /** Halo para CTA hero (incoming card, primary button glow). */
  glow: 'rgba(255,77,0,0.18)',
} as const;

/**
 * Semánticos de estado funcional.
 * REGLA: usar SIEMPRE con icono + texto, nunca color-only (a11y).
 */
export const midnightEmberState = {
  /** completed, online, success. */
  success: '#22C55E',
  /** pending, busy, warning. */
  warning: '#F59E0B',
  /** cancel, sos, destructive. */
  danger: '#EF4444',
  /** notifications, hints, info. */
  info: '#3B82F6',
} as const;

/**
 * Trip phase — escala de intensidad de UNA familia.
 * Reemplaza el rainbow legacy (azul/naranja/verde/morado/rojo) que
 * hace que el driver tenga que aprender 5 colores semánticos
 * diferentes durante un viaje crítico.
 *
 * Solo `completed` rompe la familia (verde) — justificado porque es
 * un terminal state distinto del flujo activo.
 */
export const midnightEmberTripPhase = {
  /** Pre-acceptance / matching. */
  accepting: midnightEmberAccent[300],
  /** En ruta al pickup. */
  enRoute: midnightEmberAccent[500],
  /** Llegó al pickup. */
  atPickup: midnightEmberAccent[600],
  /** Viaje en progreso. */
  inTrip: midnightEmberAccent[700],
  /** Completado — única ruptura de familia, justificada. */
  completed: midnightEmberState.success,
  /** Cancelado. */
  cancelled: midnightEmberState.danger,
} as const;

// ──────────────────────────────────────────────────────────
// Typography (driver-specific)
// ──────────────────────────────────────────────────────────
//
// Driver app es data-dense por contexto operativo. Body más compacto,
// monoscape para números (tabular para evitar layout shift en ETAs/$).
// Hero único por pantalla — Linear/Vercel style, no múltiples display 48pt.
//

/**
 * Variantes tipográficas driver-específicas.
 * Cada variante incluye `font`, `size`, `weight`, `lineHeight` y
 * opcionalmente `letterSpacing` y `textTransform`.
 *
 * USO:
 *   - `hero` / `heroLg`  → ÚNICO display por pantalla (saldo, total, contador)
 *   - `data*`            → números (ETA, $, distancia, rating) — tabular figures
 *   - `meta`             → caption mono uppercase ("5 MIN  •  2.3 KM")
 *   - `body*`            → texto de párrafo, hints
 *   - `button*`          → CTAs
 */
export const driverText = {
  // ── Display único (Linear-style) ───────────
  hero: {
    fontFamily: 'BricolageGrotesque_700Bold',
    fontSize: 36,
    fontWeight: '700' as const,
    lineHeight: 38, // 36 × 1.05 — RN lineHeight is absolute px, not multiplier
    letterSpacing: -0.5,
  },
  heroLg: {
    fontFamily: 'BricolageGrotesque_700Bold',
    fontSize: 48,
    fontWeight: '700' as const,
    lineHeight: 48, // 48 × 1.0
    letterSpacing: -0.75,
  },

  // ── Headings ───────────────────────────────
  h1: {
    fontFamily: 'Inter',
    fontSize: 24,
    fontWeight: '700' as const,
    lineHeight: 28, // 24 × 1.15
    letterSpacing: -0.3,
  },
  h2: {
    fontFamily: 'Inter',
    fontSize: 20,
    fontWeight: '600' as const,
    lineHeight: 24, // 20 × 1.2
  },
  h3: {
    fontFamily: 'Inter',
    fontSize: 17,
    fontWeight: '600' as const,
    lineHeight: 21, // 17 × 1.25
  },

  // ── Body (data-dense vs cliente) ──────────
  body: {
    fontFamily: 'Inter',
    fontSize: 15,
    fontWeight: '400' as const,
    lineHeight: 21, // 15 × 1.4
  },
  bodyDense: {
    fontFamily: 'Inter',
    fontSize: 14,
    fontWeight: '400' as const,
    lineHeight: 19, // 14 × 1.35
  },

  // ── Data (números, mono, tabular) ──────────
  /** Para precios/distancias en línea con texto. */
  data: {
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 16,
    fontWeight: '500' as const,
    lineHeight: 19, // 16 × 1.2
  },
  /** Para ETAs prominentes, totales secundarios. */
  dataLg: {
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 22,
    fontWeight: '500' as const,
    lineHeight: 25, // 22 × 1.15
  },
  /** Para meta inline (rating, fee adicional). */
  dataSm: {
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 13,
    fontWeight: '500' as const,
    lineHeight: 16, // 13 × 1.2
  },

  // ── Meta (uppercase, separators) ──────────
  /** Ej: "5 MIN  •  2.3 KM  •  ★ 4.8". */
  meta: {
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 11,
    fontWeight: '500' as const,
    lineHeight: 14, // 11 × 1.3
    letterSpacing: 1.5,
    textTransform: 'uppercase' as const,
  },

  // ── Labels & hints ────────────────────────
  label: {
    fontFamily: 'Inter',
    fontSize: 13,
    fontWeight: '500' as const,
    lineHeight: 17, // 13 × 1.3
  },
  caption: {
    fontFamily: 'Inter',
    fontSize: 12,
    fontWeight: '500' as const,
    lineHeight: 16, // 12 × 1.3
  },

  // ── Buttons ───────────────────────────────
  buttonLg: {
    fontFamily: 'Inter',
    fontSize: 16,
    fontWeight: '600' as const,
    lineHeight: 16, // 16 × 1.0
    letterSpacing: 0.2,
  },
  buttonMd: {
    fontFamily: 'Inter',
    fontSize: 14,
    fontWeight: '600' as const,
    lineHeight: 14, // 14 × 1.0
    letterSpacing: 0.2,
  },
} as const;

// ──────────────────────────────────────────────────────────
// Motion (closed dictionary)
// ──────────────────────────────────────────────────────────
//
// Cualquier animación en driver DEBE caer en uno de estos 7 propósitos.
// Si necesitás algo nuevo, se agrega al sistema con justificación.
//
// PROHIBIDOS (eliminados por análisis crítico):
//   - radarSweep   (decorativo, "fitness app smell")
//   - idlePulse    (causa ansiedad pasiva)
//   - glowRing     (theatrical, dated, conflicts with brand precision)
//   - ignitionPortal (3 anillos animados — sobre-uso de motion)
//   - ambientGradient (anti-Linear)
//

/**
 * Diccionario cerrado de motion para driver.
 * Duraciones en ms, escalas relativas a 1.0.
 */
export const driverMotion = {
  /** Tap feedback inicial — siempre <100ms para sentirse "vivo". */
  pressIn: {
    duration: 80,
    easing: 'easeOut' as const,
    scale: 0.97,
  },
  /** Tap release — restore. */
  pressOut: {
    duration: 120,
    easing: 'easeOut' as const,
    scale: 1.0,
  },
  /** Sheets/modales suben — spring para sentirse natural. */
  enter: {
    duration: 280,
    easing: 'spring' as const,
    /** Referencia: spring.enter en interaction.ts. */
    springPreset: 'enter' as const,
  },
  /** Exit siempre 70% de enter (sentirse responsivo). */
  exit: {
    duration: 200,
    easing: 'easeIn' as const,
  },
  /** Route line draw, hero number reveal — one-shot emphasis. */
  reveal: {
    duration: 400,
    easing: 'easeOut' as const,
  },
  /** Status indicator (online dot, recording dot). UNA cosa por pantalla. */
  pulseStatus: {
    duration: 1600,
    easing: 'sine' as const,
    loop: true,
    opacityRange: [0.6, 1.0] as const,
  },
  /** Toast slide-in. */
  toast: {
    duration: 220,
    easing: 'easeOut' as const,
    translateY: 24,
  },
} as const;

// ──────────────────────────────────────────────────────────
// Radius (named by use, not by size)
// ──────────────────────────────────────────────────────────

/**
 * Radius nombrados por uso. Permite cambiar el sistema globalmente
 * (ej: subir todos los cards de 12 → 14) sin tocar componentes.
 */
export const driverRadius = {
  /** Chips, switches, micro-toggles. */
  tap: 4,
  /** Inputs, search bars. */
  input: 10,
  /** Cards estándar. */
  card: 12,
  /** Bottom sheets, large modals. */
  sheet: 16,
  /** Incoming ride card, modales destacados, hero CTAs. */
  hero: 20,
  /** Pills (status badges, ratings). */
  pill: 9999,
} as const;

// ──────────────────────────────────────────────────────────
// Shadow (named by purpose)
// ──────────────────────────────────────────────────────────

/**
 * Shadows nombradas por propósito de jerarquía visual.
 * Valores aptos para usar con `style={...}` en RN.
 *
 * REGLA: shadow.glow se usa SOLO en CTA hero (incoming primary button)
 * o status crítico — nunca decorativo.
 */
export const driverShadow = {
  /** Sin sombra — flat sobre canvas. */
  flat: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  /** Cards sobre dark canvas (sutil). */
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  /** Sheets, modales bajos. */
  lifted: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.20,
    shadowRadius: 12,
    elevation: 6,
  },
  /** Incoming ride card, sheets destacadas. */
  hero: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.30,
    shadowRadius: 24,
    elevation: 12,
  },
  /** Glow accent — uso reservado: CTA primario, status crítico. */
  glow: {
    shadowColor: midnightEmberAccent[500],
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 20,
    elevation: 8,
  },
} as const;

// ──────────────────────────────────────────────────────────
// Aggregate export — Midnight Ember as one cohesive token tree
// ──────────────────────────────────────────────────────────

/**
 * Token tree completo. Importar como:
 *   import { midnightEmber } from '@tricigo/theme';
 *   const bg = midnightEmber.map.bg.canvas;
 *   const accent = midnightEmber.accent[500];
 *   const txt = midnightEmber.text.hero;
 */
export const midnightEmber = {
  map: midnightEmberMap,
  screen: midnightEmberScreen,
  accent: midnightEmberAccent,
  state: midnightEmberState,
  tripPhase: midnightEmberTripPhase,
  text: driverText,
  motion: driverMotion,
  radius: driverRadius,
  shadow: driverShadow,
} as const;

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export type MidnightEmberMap = typeof midnightEmberMap;
export type MidnightEmberScreen = typeof midnightEmberScreen;
export type MidnightEmberAccent = typeof midnightEmberAccent;
export type MidnightEmberState = typeof midnightEmberState;
export type MidnightEmberTripPhase = typeof midnightEmberTripPhase;
export type DriverTextVariant = keyof typeof driverText;
export type DriverMotionPreset = keyof typeof driverMotion;
export type DriverRadiusToken = keyof typeof driverRadius;
export type DriverShadowToken = keyof typeof driverShadow;
export type MidnightEmberToken = typeof midnightEmber;
