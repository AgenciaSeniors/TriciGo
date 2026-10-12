// ============================================================
// Sentry privacy: no URL fragment reaches Sentry from the web.
//
// tricigo.com receives secrets in the URL fragment: the Supabase session after Google/Apple and the
// e-mail login link (/auth/callback#access_token=…&refresh_token=…, implicit flow; the home page if
// GoTrue falls back to the Site URL) and the team digest opt-out token (/resumen-diario/baja#u=…&t=…).
// The fragment never reaches our server, but the browser SDK copies the page URL into what it sends:
//   - event.request.url: document.location.href, fragment included (httpContextIntegration on every
//     event; for a pageload transaction, captured when the span starts, at SDK init, before GoTrue
//     clears the hash, and set as `request`);
//   - breadcrumbs: navigation data.from / data.to (history instrumentation, relative URL with the
//     fragment; Next's first history.replaceState writes it), fetch/xhr data.url;
//   - fetch/xhr spans: data.url, data['http.url'], description, data['http.fragment'] (the fragment alone);
//   - any other string that quotes the URL (messages, exception values, extra).
// scrubUrlFragments() cuts the fragment from every URL wherever it appears in an event and drops
// 'http.fragment'. A fragment has no diagnostic value, so it does not try to tell pages apart.
// Pure and dependency-free, like sentryNoise.ts.
// ============================================================

/**
 * A run of text a URL can sit in: it ends at a space, quote or angle bracket. A fragment runs to the
 * end of its run, `)` included (a fragment may hold one).
 */
const RUN_RE = /[^\s"'`<>]+/g;
/**
 * Characters inside a run after which a `/` starts a URL. With the start of the run they cover a path
 * (`/…`), a protocol-relative URL (`//host…`) and a URL with a scheme (`https://…`,
 * `tricigo-driver://…`: the `/` follows the `:`). So `div#root`, `error #418` and `#ff6a00` are not URLs.
 */
const URL_START_AFTER = '(=:,;[{';

/**
 * GoTrue's session parameters, wherever they sit (a fragment that is not part of a URL, a query, a
 * URL-encoded `return=`): their value goes. Names longest first, so provider_refresh_token wins.
 */
const SESSION_PARAM_RE = /((?:provider_refresh_token|provider_token|refresh_token|access_token)(?:=|%3D))[^&#%\s"'`<>]*/gi;

/** Holds SDK scopes (cyclic) and is deleted before the envelope is built: never walked. */
const SKIP_KEYS = new Set(['sdkProcessingMetadata']);

/**
 * Cuts a run at the first `#` that ends a URL. One pass, no backtracking: a crafted link of hundreds
 * of KB reaches every event as a breadcrumb, and a regex that backtracks froze the page (229 s on
 * 500 KB of `,/`).
 */
function cutRun(run: string): string {
  let inUrl = false;
  for (let i = 0; i < run.length; i++) {
    const c = run[i];
    if (c === '#') {
      if (inUrl) return run.slice(0, i);
      inUrl = false;
    } else if (c === '/' && !inUrl && (i === 0 || URL_START_AFTER.includes(run[i - 1] as string))) {
      inUrl = true;
    }
  }
  return run;
}

/**
 * Removes the fragment of every URL in `text` and the value of every session token parameter. Text
 * without either comes back unchanged.
 */
export function stripUrlFragments(text: string): string {
  const cut = text.includes('#') ? text.replace(RUN_RE, (run) => (run.includes('#') ? cutRun(run) : run)) : text;
  return cut.replace(SESSION_PARAM_RE, '$1[Filtered]');
}

function scrubNode(node: object, seen: WeakSet<object>): void {
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item: unknown = node[i];
      if (typeof item === 'string') {
        const clean = stripUrlFragments(item);
        if (clean !== item) node[i] = clean;
      } else if (item && typeof item === 'object') {
        scrubNode(item, seen);
      }
    }
    return;
  }

  const record = node as Record<string, unknown>;
  // Fetch/XHR spans keep the fragment alone in 'http.fragment', next to the URL it came from.
  if ('http.fragment' in record) delete record['http.fragment'];
  for (const key of Object.keys(record)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = record[key];
    if (typeof value === 'string') {
      const clean = stripUrlFragments(value);
      if (clean !== value) record[key] = clean;
    } else if (value && typeof value === 'object') {
      scrubNode(value, seen);
    }
  }
}

/**
 * Removes the fragment of every URL from a Sentry event or transaction, in place, and returns the
 * same event. Use it in `beforeSend` (after the noise filter) and in `beforeSendTransaction`.
 */
export function scrubUrlFragments<E extends object>(event: E): E {
  scrubNode(event, new WeakSet<object>());
  return event;
}
