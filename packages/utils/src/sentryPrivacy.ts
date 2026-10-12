// ============================================================
// Sentry privacy: no secret carried in a URL reaches Sentry from the web.
//
// tricigo.com receives secrets in three places of the URL:
//   - the fragment: the Supabase session after Google/Apple and the e-mail login link
//     (/auth/callback#access_token=…&refresh_token=…, implicit flow; the home page if GoTrue falls
//     back to the Site URL) and the team digest opt-out token (/resumen-diario/baja#u=…&t=…);
//   - the path: the trip share token (/track/share/<token>, also /ride/share/<token> and the old
//     /delivery/<token>). Whoever holds it watches the trip until 48 h after it ends;
//   - the query: the single-use e-mail confirmation token (/auth/email-confirmed?token=…), valid 24 h
//     until the page redeems it, and the PostgREST filter share_token=eq.<token>.
// The browser SDK copies the page URL into what it sends:
//   - event.request.url: document.location.href, fragment included (httpContextIntegration on every
//     event; for a pageload transaction, captured when the span starts, at SDK init, before GoTrue
//     clears the hash, and set as `request`), and request.headers.Referer (document.referrer);
//   - breadcrumbs: navigation data.from / data.to (history instrumentation, relative URL with the
//     fragment; Next's first history.replaceState writes it), fetch/xhr data.url;
//   - fetch/xhr spans: data.url, data['http.url'], data['http.query'], description,
//     data['http.fragment'] (the fragment alone);
//   - the transaction name and the INP span's `transaction`, raw if the route manifest misses a path;
//   - any other string that quotes the URL (messages, exception values, extra).
// The server SDK (http.server transactions and request errors) keeps the raw path and query in
// http.target / url.path / url.query / request.url / request.query_string, and every request header
// as http.request.header.*: referer, next_url (the page the browser is on) and next_router_state_tree
// (Next's router tree, URL-encoded JSON: a dynamic segment is ["token","<value>","d"] and a page's
// query is __PAGE__?{"token":"<value>"}). The envelope's `trace` header is the event's
// sdkProcessingMetadata.dynamicSamplingContext, whose `transaction` may be a raw path.
// scrubUrlSecrets() cuts the fragment from every URL wherever it appears in an event, drops
// 'http.fragment', blanks the value of every *token parameter and replaces the share token path
// segment with [token]. A fragment has no diagnostic value, so it does not try to tell pages apart.
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
 * The value of any parameter whose name ends in `token`, wherever it sits: GoTrue's session
 * (access_token, refresh_token, provider_token, provider_refresh_token) in a fragment that is not part
 * of a URL, a query or a URL-encoded `return=`; ?token= of the e-mail confirmation;
 * share_token=eq.<value> in a PostgREST URL; "token","<value>" and \"token\":\"<value>\" in Next's
 * router tree, URL-encoded or not. After `token` comes a run of separators (= : , " \ or their %XX
 * forms) and then the value, which shares no character with the separators: a crafted run of
 * separators only backtracks over itself, so the match stays linear.
 */
const TOKEN_PARAM_RE = /(token(?:%22|%5C|%3A|%2C|%3D|["\\:,=])+)[^&#%"\\:,=;\s'`<>]+/gi;

/**
 * The trip share token in a path, plain or URL-encoded. The segment is limited to URL-unreserved
 * characters, so a name the SDK already parameterized (`:token`, `[token]`) stays as it is.
 */
const SHARE_PATH_RE = /((?:\/|%2F)(?:track(?:\/|%2F)share|ride(?:\/|%2F)share|delivery)(?:\/|%2F))[\w.~-]+/gi;

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
 * Removes the fragment of every URL in `text`, the value of every *token parameter and the trip share
 * token of every share path. Text without any of them comes back unchanged.
 */
export function stripUrlSecrets(text: string): string {
  const cut = text.includes('#') ? text.replace(RUN_RE, (run) => (run.includes('#') ? cutRun(run) : run)) : text;
  return cut.replace(TOKEN_PARAM_RE, '$1[Filtered]').replace(SHARE_PATH_RE, '$1[token]');
}

function scrubNode(node: object, seen: WeakSet<object>): void {
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item: unknown = node[i];
      if (typeof item === 'string') {
        const clean = stripUrlSecrets(item);
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
      const clean = stripUrlSecrets(value);
      if (clean !== value) record[key] = clean;
    } else if (value && typeof value === 'object') {
      scrubNode(value, seen);
    }
  }
}

/**
 * Removes the secrets that URLs carry (see stripUrlSecrets) from a Sentry event, transaction or span,
 * in place, and returns the same object. Use it in `beforeSend` (after the noise filter),
 * `beforeSendTransaction` and `beforeSendSpan`.
 */
export function scrubUrlSecrets<E extends object>(event: E): E {
  const seen = new WeakSet<object>();
  scrubNode(event, seen);
  // sdkProcessingMetadata is never walked, but its dynamicSamplingContext (plain strings) becomes the
  // envelope's `trace` header (core createEventEnvelopeHeaders). The SDK may share that object with the
  // live root span (_frozenDsc), so it gets a scrubbed copy instead of an edit.
  const meta: unknown = (event as { sdkProcessingMetadata?: unknown }).sdkProcessingMetadata;
  if (meta && typeof meta === 'object') {
    const holder = meta as { dynamicSamplingContext?: unknown };
    const dsc = holder.dynamicSamplingContext;
    if (dsc && typeof dsc === 'object' && !Array.isArray(dsc)) {
      const copy = { ...(dsc as Record<string, unknown>) };
      scrubNode(copy, seen);
      holder.dynamicSamplingContext = copy;
    }
  }
  return event;
}
