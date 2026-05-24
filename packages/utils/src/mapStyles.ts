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
// BUG-218: marker sizes rebalanced — pickup/dropoff slightly bigger as fixed
// targets, driver smaller so the vehicle icon doesn't dominate the map.
//
// MARKER-SIZE-1.5X (2026-05-24): user reported "se ve muy pequeño". Scaled
// every dimension 1.5× (rounded to nearest integer) to match Uber/Bolt
// visibility standards. Internal proportions (innerDot, tailH) scaled too
// so the visual shape stays identical, just bigger. Single source for
// driver + client + web map.
export const MARKER = {
  pickup: { size: 39, innerDot: 12, shadow: '0 3px 12px rgba(34,197,94,0.35)' },
  dropoff: { size: 48, innerDot: 17, tailH: 18, shadow: '0 3px 12px rgba(239,68,68,0.35)' },
  driver: { size: 45, ringSize: 60, shadow: '0 4px 16px rgba(59,130,246,0.35)' },
} as const;

// ── Route Line Styles ────────────────────────────────────────
// BUG-218: width reduced (5→4) and opacity reduced (0.9→0.75) so the route
// stops visually swallowing the pickup/dropoff markers when they sit on
// top of the line on Android.
export const ROUTE = {
  main: { color: '#3b82f6', width: 4, opacity: 0.75 },
  shadow: { color: '#000000', width: 6, opacity: 0.12, blur: 3 },
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
