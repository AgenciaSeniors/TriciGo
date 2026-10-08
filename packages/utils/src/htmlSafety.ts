// Helpers for putting text we did not write into HTML, a <script> element or a
// redirect. Pure functions, safe on the server, in the browser and in React Native.

/** Escapes text for an HTML element body or a double- or single-quoted attribute. */
export function escapeHtml(value: string | number | null | undefined): string {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON for a `<script type="application/ld+json">` element. `JSON.stringify` leaves `<`
 * as is, so a value holding `</script>` would end the element and the rest would run as
 * page script. The escapes below are valid JSON, so crawlers read the same data.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const PROBE_ORIGIN = 'https://internal.invalid';

/**
 * A path on this same site to send a user to after login, or null. Browsers read a
 * backslash in a URL as a slash and drop tabs and line breaks, so "/\evil.example"
 * means "//evil.example": a link to another site that a plain "starts with / but not
 * with //" check lets through.
 */
export function safeInternalPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;
  return url.pathname + url.search + url.hash;
}
