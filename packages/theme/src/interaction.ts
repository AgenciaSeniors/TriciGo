// ============================================================
// TriciGo — Interaction Constants
// Touch targets, animation durations, and interaction specs
// ============================================================

/** Minimum touch target size in dp (Material Design standard) */
export const TOUCH_TARGET_MIN = 48;

/** Minimum spacing between touch targets in dp */
export const TOUCH_SPACING_MIN = 8;

/** Animation duration presets in ms */
export const animation = {
  /** Micro-interactions: toggles, button presses */
  fast: 150,
  /** Standard transitions: cards, modals */
  normal: 250,
  /** Complex transitions: page, shared elements */
  slow: 400,
  /** Stagger delay between list items */
  stagger: 50,
} as const;

/** Spring animation configs for react-native Animated / Reanimated */
export const spring = {
  /** Snappy press feedback */
  press: { damping: 15, stiffness: 300, mass: 0.8 },
  /** Smooth card entrance */
  enter: { damping: 20, stiffness: 200, mass: 1 },
  /** Bouncy toggle */
  toggle: { damping: 12, stiffness: 250, mass: 0.6 },
} as const;

/** Press feedback scale values */
export const pressScale = {
  /** Cards, list items */
  subtle: 0.98,
  /** Buttons */
  button: 0.95,
} as const;

/** Opacity values for states */
export const stateOpacity = {
  /** Disabled elements */
  disabled: 0.38,
  /** Secondary/muted text */
  muted: 0.5,
  /** Tertiary/hint text */
  hint: 0.4,
  /** Pressed overlay */
  pressed: 0.08,
} as const;
