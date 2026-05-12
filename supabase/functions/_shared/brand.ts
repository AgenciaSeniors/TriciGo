// ============================================================
// TriciGo — shared brand tokens for edge functions.
//
// Single source of truth for the colors, asset URLs, and brand
// constants used by both HTML email templates (which need hex
// strings) and pdf-lib PDFs (which need 0..1 rgb tuples). When the
// palette changes, edit this file only.
//
// Imported by:
//   - _shared/email-templates/_layout.ts (HEX, FONT_STACK, LOGO_URL)
//   - generate-recharge-receipt/index.ts (RGB tuples + LOGO_URL)
// ============================================================

// ── Hex strings (HTML / CSS) ─────────────────────────────────────
export const BRAND_HEX = {
  primary: '#F97316',       // Orange-500
  primaryDark: '#EA580C',   // Orange-600 (button hover/border)
  primaryLight: '#FFF7ED',  // Orange-50 (subtle highlight bg)
  ink: '#0F172A',           // Slate-900
  text: '#334155',          // Slate-700
  muted: '#64748B',         // Slate-500
  mutedLight: '#94A3B8',    // Slate-400
  border: '#E2E8F0',        // Slate-200
  bgPage: '#F8FAFC',        // Slate-50
  bgCard: '#FFFFFF',
  success: '#16A34A',       // Green-600
  error: '#DC2626',         // Red-600
} as const;

// ── 0..1 rgb tuples (pdf-lib) ────────────────────────────────────
// pdf-lib's `rgb()` takes channels in [0..1], unlike CSS which uses
// [0..255]. Pre-converted here so the PDF renderer can pass the
// tuples straight to `rgb(...args)`.
export type RgbTuple = readonly [number, number, number];

function hexToRgbTuple(hex: string): RgbTuple {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b] as const;
}

export const BRAND_RGB = {
  primary: hexToRgbTuple(BRAND_HEX.primary),
  primaryDark: hexToRgbTuple(BRAND_HEX.primaryDark),
  primaryLight: hexToRgbTuple(BRAND_HEX.primaryLight),
  ink: hexToRgbTuple(BRAND_HEX.ink),
  text: hexToRgbTuple(BRAND_HEX.text),
  muted: hexToRgbTuple(BRAND_HEX.muted),
  mutedLight: hexToRgbTuple(BRAND_HEX.mutedLight),
  border: hexToRgbTuple(BRAND_HEX.border),
  bgPage: hexToRgbTuple(BRAND_HEX.bgPage),
  bgCard: hexToRgbTuple(BRAND_HEX.bgCard),
  success: hexToRgbTuple(BRAND_HEX.success),
  error: hexToRgbTuple(BRAND_HEX.error),
} as const;

// ── Asset URLs ───────────────────────────────────────────────────

// Logo strategy:
//   - LOGO_URL: the wordmark PNG, used by the *PDF* (where we have full
//     control of the canvas color so contrast is fine).
//   - LOGO_ICON_URL: square icon (192×192 source, displayed at 48×48 =
//     retina-4x). Used in *email* headers because Gmail Android force-
//     applies dark mode and the wordmark's black "Trici" disappears
//     against the dark background. The icon is single-color (orange on
//     white pin) and reads correctly on every theme.
const DEFAULT_LOGO_URL = 'https://tricigo.com/logo-wordmark.png';
export const LOGO_URL =
  (typeof Deno !== 'undefined' ? Deno.env.get('EMAIL_LOGO_URL') : undefined) ??
  DEFAULT_LOGO_URL;

const DEFAULT_LOGO_ICON_URL = 'https://tricigo.com/icon-192.png';
export const LOGO_ICON_URL =
  (typeof Deno !== 'undefined' ? Deno.env.get('EMAIL_LOGO_ICON_URL') : undefined) ??
  DEFAULT_LOGO_ICON_URL;

const DEFAULT_WEB_ORIGIN = 'https://tricigo.com';
export const WEB_ORIGIN =
  (typeof Deno !== 'undefined' ? Deno.env.get('EMAIL_WEB_ORIGIN') : undefined) ??
  DEFAULT_WEB_ORIGIN;

// ── Typography ───────────────────────────────────────────────────

export const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// ── Brand identity ───────────────────────────────────────────────

export const BRAND_NAME = 'TriciGo';
export const BRAND_TAGLINE_ES = 'Movilidad cubana, en la palma de tu mano.';
export const SUPPORT_EMAIL = 'soporte@tricigo.com';

// Deno typing — non-Deno tooling (IDE typecheck) needs this guard.
declare const Deno: { env: { get(k: string): string | undefined } } | undefined;
