// ============================================================
// Sentry privacy: URL fragments that carry a personal token never reach Sentry.
//
// The team daily digest (00656) links to /resumen-diario/baja#u=<account>&t=<token>. The fragment
// never reaches our server, but the browser SDK copies the page URL into what it sends:
//   - event.request.url: document.location.href, fragment included (httpContextIntegration on every
//     event; for a pageload transaction, captured when the span starts and set as `request`);
//   - breadcrumbs: navigation data.from / data.to (history instrumentation, relative URL with the
//     fragment), fetch/xhr data.url;
//   - fetch/xhr spans: data.url, data['http.url'], data['http.fragment'] (the fragment alone);
//   - any other string that quotes the URL (messages, exception values, extra).
// scrubPrivateFragments() cuts the fragment from every URL of a listed page wherever it appears in
// an event, so it also cleans a breadcrumb that carries the page URL into an event of another page.
// URLs of other pages keep their fragments. Pure and dependency-free, like sentryNoise.ts.
// ============================================================

/** Pages whose URL fragment carries a personal token. */
export const PRIVATE_FRAGMENT_PATHS: readonly string[] = ['/resumen-diario/baja'];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The path counts only at the start of a string, right after a host (//host[:port]) or after a
// separator in free text, so /docs/resumen-diario/baja is another page. No lookbehind: this runs in
// browsers that lack it.
const PATH_PREFIX = String.raw`(^|\/\/[^\/\s"'<>?#]+|[\s"'(<=])`;
const PATHS = PRIVATE_FRAGMENT_PATHS.map(escapeRegExp).join('|');
/** prefix, then path + optional trailing slash + optional query, then the fragment to cut. */
const FRAGMENT_RE = new RegExp(String.raw`${PATH_PREFIX}((?:${PATHS})\/?(?:\?[^#\s"'<>]*)?)#[^\s"'<>]*`, 'g');
/** A URL of a listed page, with or without query/fragment. */
const PAGE_URL_RE = new RegExp(String.raw`${PATH_PREFIX}(?:${PATHS})\/?(?:[?#]|$)`);

/** Span/breadcrumb attributes that hold the URL whose fragment `http.fragment` repeats. */
const URL_KEYS = ['url', 'http.url', 'url.full'] as const;

/** Holds SDK scopes (cyclic) and is deleted before the envelope is built: never walked. */
const SKIP_KEYS = new Set(['sdkProcessingMetadata']);

function scrubString(value: string): string {
  return value.replace(FRAGMENT_RE, '$1$2');
}

function scrubNode(node: object, seen: WeakSet<object>): void {
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item: unknown = node[i];
      if (typeof item === 'string') {
        const clean = scrubString(item);
        if (clean !== item) node[i] = clean;
      } else if (item && typeof item === 'object') {
        scrubNode(item, seen);
      }
    }
    return;
  }

  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = record[key];
    if (typeof value === 'string') {
      const clean = scrubString(value);
      if (clean !== value) record[key] = clean;
    } else if (value && typeof value === 'object') {
      scrubNode(value, seen);
    }
  }

  // Fetch/XHR spans keep the fragment alone in 'http.fragment', next to the URL it came from.
  if ('http.fragment' in record) {
    const pointsAtPage = URL_KEYS.some((k) => {
      const v = record[k];
      return typeof v === 'string' && PAGE_URL_RE.test(v);
    });
    if (pointsAtPage) delete record['http.fragment'];
  }
}

/**
 * Removes the fragment of every URL of a PRIVATE_FRAGMENT_PATHS page from a Sentry event or
 * transaction, in place, and returns the same event. Events without such a URL are left as they
 * are. Use it in `beforeSend` (after the noise filter) and in `beforeSendTransaction`.
 */
export function scrubPrivateFragments<E extends object>(event: E): E {
  scrubNode(event, new WeakSet<object>());
  return event;
}
