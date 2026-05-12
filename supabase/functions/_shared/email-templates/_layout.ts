// ============================================================
// TriciGo — shared email layout & design tokens
//
// All transactional emails wrap their body content with `wrapHtml`
// so the brand expression (logo, hero, footer) is identical across
// welcome, win_back, wallet_receipt, etc. To add a new template,
// create a new file in this folder, render the body fragment, and
// pass it through wrapHtml(...).
//
// Email-HTML constraints honored:
// - Table-based layout (Outlook 2007+ compatibility)
// - Inline styles (Gmail strips <style> in some configurations)
// - Hex colors with 6 digits (some clients reject shorthand)
// - 600px max width (industry standard, mobile collapses to 100%)
// - System font stack (no @font-face — webmail clients strip it)
// - Hosted PNG logo (CIDs and base64 fail on iOS Mail dark mode)
// ============================================================

// ── Design tokens — re-exported from the shared brand module so
// PDF and HTML emit from a single source of truth. ───────────────
import { BRAND_HEX, FONT_STACK as SHARED_FONT_STACK, LOGO_URL as SHARED_LOGO_URL, LOGO_ICON_URL as SHARED_LOGO_ICON_URL, WEB_ORIGIN as SHARED_WEB_ORIGIN } from '../brand.ts';

export const COLORS = BRAND_HEX;
export const FONT_STACK = SHARED_FONT_STACK;
export const LOGO_URL = SHARED_LOGO_URL;
export const LOGO_ICON_URL = SHARED_LOGO_ICON_URL;
export const WEB_ORIGIN = SHARED_WEB_ORIGIN;

// ── Reusable component fragments ─────────────────────────────────

/**
 * Primary CTA button. Render as <a> (real <button> doesn't reliably
 * accept padding in Outlook). VML wrapper added for Outlook desktop.
 */
export function ctaButton(label: string, href: string): string {
  const esc = escapeHtml;
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
      <tr>
        <td align="center" bgcolor="${COLORS.primary}" style="border-radius: 8px;">
          <a href="${esc(href)}" target="_blank" rel="noopener"
             style="display: inline-block; padding: 14px 32px; font-family: ${FONT_STACK}; font-size: 15px; font-weight: 600; color: #FFFFFF; text-decoration: none; border-radius: 8px;">
            ${esc(label)}
          </a>
        </td>
      </tr>
    </table>`;
}

/**
 * Two-column key/value row for receipts and detail tables. Right
 * column is right-aligned with monospaced numerals.
 */
export function detailRow(
  label: string,
  value: string,
  opts: { strong?: boolean; muted?: boolean } = {},
): string {
  const labelColor = opts.muted ? COLORS.muted : COLORS.text;
  const valueWeight = opts.strong ? '600' : '400';
  const valueColor = opts.strong ? COLORS.ink : COLORS.text;
  return `
    <tr>
      <td style="padding: 10px 0; font-family: ${FONT_STACK}; font-size: 14px; color: ${labelColor}; border-bottom: 1px solid ${COLORS.border};">
        ${escapeHtml(label)}
      </td>
      <td align="right" style="padding: 10px 0; font-family: ${FONT_STACK}; font-size: 14px; font-weight: ${valueWeight}; color: ${valueColor}; border-bottom: 1px solid ${COLORS.border}; font-variant-numeric: tabular-nums;">
        ${escapeHtml(value)}
      </td>
    </tr>`;
}

/**
 * Total row — bigger type, primary color, no border.
 */
export function totalRow(label: string, value: string): string {
  return `
    <tr>
      <td style="padding: 16px 0 4px; font-family: ${FONT_STACK}; font-size: 16px; font-weight: 600; color: ${COLORS.ink};">
        ${escapeHtml(label)}
      </td>
      <td align="right" style="padding: 16px 0 4px; font-family: ${FONT_STACK}; font-size: 20px; font-weight: 700; color: ${COLORS.primary}; font-variant-numeric: tabular-nums;">
        ${escapeHtml(value)}
      </td>
    </tr>`;
}

// ── Master HTML wrapper ──────────────────────────────────────────

export interface LayoutOptions {
  /** Subject-like phrase shown right under the logo. e.g. "Tu recibo · TG-20260511-001". */
  preheader?: string;
  /** Big colored hero strip with title + optional subtitle. Skip for "quiet" emails. */
  hero?: { title: string; subtitle?: string };
  /** Inner HTML for the main content area (after hero, before footer). */
  body: string;
  /** Optional CTA at the bottom of the body. */
  cta?: { label: string; href: string };
  /** Footer brand line. Defaults to "TriciGo · Cuba". */
  footerBrand?: string;
  /** Optional small print under the footer brand (legal, support). */
  footerNote?: string;
}

export function wrapHtml(opts: LayoutOptions): string {
  const {
    preheader = '',
    hero,
    body,
    cta,
    footerBrand = 'TriciGo · Cuba',
    footerNote,
  } = opts;

  const heroBlock = hero
    ? `
      <tr>
        <td bgcolor="${COLORS.primary}" style="padding: 32px 32px 28px; text-align: center;">
          <h1 style="margin: 0 0 ${hero.subtitle ? '8px' : '0'}; font-family: ${FONT_STACK}; font-size: 24px; font-weight: 700; color: #FFFFFF; letter-spacing: -0.01em;">
            ${escapeHtml(hero.title)}
          </h1>
          ${hero.subtitle
            ? `<p style="margin: 0; font-family: ${FONT_STACK}; font-size: 15px; color: rgba(255,255,255,0.92); line-height: 1.5;">${escapeHtml(hero.subtitle)}</p>`
            : ''}
        </td>
      </tr>`
    : '';

  const ctaBlock = cta
    ? `
      <tr>
        <td style="padding: 8px 32px 32px; text-align: center;">
          ${ctaButton(cta.label, cta.href)}
        </td>
      </tr>`
    : '';

  const noteBlock = footerNote
    ? `
      <p style="margin: 8px 0 0; font-family: ${FONT_STACK}; font-size: 12px; color: ${COLORS.mutedLight}; line-height: 1.5;">
        ${footerNote}
      </p>`
    : '';

  // Preheader: hidden text that mail clients show in inbox preview.
  const preheaderBlock = preheader
    ? `<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">${escapeHtml(preheader)}</div>`
    : '';

  const rawHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>TriciGo</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${COLORS.bgPage}; font-family: ${FONT_STACK};">
${preheaderBlock}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${COLORS.bgPage}">
  <tr>
    <td align="center" style="padding: 24px 12px;">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; width: 100%; background-color: ${COLORS.bgCard}; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(15,23,42,0.05);">
        <tr>
          <td style="padding: 28px 32px 20px; text-align: center;">
            <a href="${WEB_ORIGIN}" target="_blank" rel="noopener"
               style="display: inline-block; text-decoration: none; color: ${COLORS.ink};">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                <tr>
                  <td valign="middle" style="padding-right: 12px;">
                    <img src="${LOGO_ICON_URL}" alt="" width="40" height="40"
                         style="display: block; width: 40px; height: 40px; border-radius: 8px;">
                  </td>
                  <td valign="middle">
                    <span style="display: inline-block; font-family: ${FONT_STACK}; font-size: 22px; font-weight: 700; letter-spacing: -0.01em; color: ${COLORS.ink}; line-height: 1;">
                      Trici<span style="color: ${COLORS.primary};">Go</span>
                    </span>
                  </td>
                </tr>
              </table>
            </a>
          </td>
        </tr>
        ${heroBlock}
        <tr>
          <td style="padding: 32px 32px 16px; font-family: ${FONT_STACK}; font-size: 15px; line-height: 1.6; color: ${COLORS.text};">
            ${body}
          </td>
        </tr>
        ${ctaBlock}
        <tr>
          <td bgcolor="${COLORS.bgPage}" style="padding: 24px 32px; text-align: center; border-top: 1px solid ${COLORS.border};">
            <p style="margin: 0; font-family: ${FONT_STACK}; font-size: 13px; font-weight: 600; color: ${COLORS.muted};">
              ${escapeHtml(footerBrand)}
            </p>
            ${noteBlock}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  // Final pass: collapse all non-ASCII codepoints into numeric HTML
  // entities. The body is now safe to ship over any 7-bit transport,
  // independent of the Content-Type charset declaration.
  return asciiSafeHtml(rawHtml);
}

// ── Utilities ────────────────────────────────────────────────────

export function escapeHtml(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert any non-ASCII codepoint (>= U+0080) to its numeric HTML
 * entity (&#NNN;). Run on the FINAL email body so the bytes leaving
 * Resend are 100% 7-bit ASCII — no dependency on the transport
 * declaring charset=utf-8 correctly. This eliminates the "tilde
 * shows as a square with ?" issue some mail clients exhibit when
 * they don't honor the inline <meta charset="UTF-8">.
 *
 * Surrogate pairs (e.g. emoji like 🛺 = U+1F6FA) collapse to a single
 * codepoint via String.codePointAt so we emit one entity, not two.
 */
export function asciiSafeHtml(html: string): string {
  let out = '';
  for (let i = 0; i < html.length; ) {
    const cp = html.codePointAt(i)!;
    if (cp < 0x80) {
      out += html[i]!;
      i += 1;
    } else {
      out += `&#${cp};`;
      // Skip the low surrogate when we just consumed a surrogate pair.
      i += cp > 0xFFFF ? 2 : 1;
    }
  }
  return out;
}

