// ============================================================
// TriciGo — Map Visual Constants (Premium Uber/Bolt Style)
// Single source of truth for all map-related visual parameters.
// ============================================================

// ── Map Base Styles ──────────────────────────────────────────
/** Clean, muted base — roads, parks, water only. No shop/restaurant POIs. */
export const MAP_STYLE_LIGHT = 'mapbox://styles/mapbox/light-v11';

/** Navigation night mode for driver app (already excellent, keep as-is). */
export const MAP_STYLE_NAV_NIGHT = 'mapbox://styles/mapbox/navigation-night-v1';

// ── Marker Dimensions ────────────────────────────────────────
export const MARKER = {
  pickup: { size: 32, innerDot: 10, shadow: '0 3px 12px rgba(34,197,94,0.35)' },
  dropoff: { size: 32, innerDot: 10, tailH: 10, shadow: '0 3px 12px rgba(239,68,68,0.35)' },
  driver: { size: 44, ringSize: 56, shadow: '0 4px 16px rgba(59,130,246,0.35)' },
} as const;

// ── Route Line Styles ────────────────────────────────────────
export const ROUTE = {
  main: { color: '#3b82f6', width: 5, opacity: 0.9 },
  shadow: { color: '#000000', width: 8, opacity: 0.12, blur: 3 },
  driverTo: { color: '#93c5fd', width: 4, dashArray: [8, 5] as readonly number[] },
  progress: { color: '#22c55e', width: 5, opacity: 0.9 },
} as const;

// ── Glassmorphism Tokens ─────────────────────────────────────
export const GLASS = {
  bg: 'rgba(255,255,255,0.72)',
  bgDark: 'rgba(15,15,35,0.78)',
  blur: 12,
  border: 'rgba(255,255,255,0.25)',
  borderDark: 'rgba(255,255,255,0.08)',
  radius: 16,
} as const;

// ── Map Element Colors ───────────────────────────────────────
export const MAP_COLORS = {
  pickup: '#22c55e',
  dropoff: '#EF4444',
  driver: '#3b82f6',
  driverSelf: '#FF4D00', // Brand orange — driver sees themselves in brand color
  brand: '#FF4D00',
  route: '#3b82f6',
  driverContainer: '#1a1a2e',
} as const;
