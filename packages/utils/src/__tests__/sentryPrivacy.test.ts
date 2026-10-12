import { describe, it, expect } from 'vitest';
import { makeSentryBeforeSend } from '../sentryNoise';
import { scrubUrlFragments, stripUrlFragments } from '../sentryPrivacy';

// Fake session, shaped like what GoTrue puts in the fragment after Google/Apple or the e-mail link.
const ACCESS = 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImZha2UiLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiJmYWtlLXVzZXIifQ.ZmFrZS1zaWduYXR1cmU';
const REFRESH = 'k3xq9fakerefresh7';
const LOGIN_FRAGMENT = `#access_token=${ACCESS}&expires_at=1760188000&expires_in=3600&provider_token=ya29.fakeprovider&refresh_token=${REFRESH}&token_type=bearer`;
const CALLBACK = 'https://tricigo.com/auth/callback';

// Team digest opt-out link (00656).
const U = '3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b';
const T = '9e107d9d372bb6826bd81d3542a419d6c0ffee00deadbeef0123456789abcdef';
const OPT_OUT = 'https://tricigo.com/resumen-diario/baja';
const OPT_OUT_FRAGMENT = `#u=${U}&t=${T}`;

/** What the SDK sends: the envelope drops sdkProcessingMetadata (core envelope.js). */
function serialized(event: Record<string, unknown>): string {
  const { sdkProcessingMetadata: _dropped, ...sent } = event;
  return JSON.stringify(sent);
}

/**
 * A pageload transaction shaped like the one @sentry/nextjs 10.43 builds when the browser lands on
 * `page + fragment`:
 * - request.url is document.location.href captured when the pageload span starts, at SDK init and
 *   before GoTrue clears the hash (browserTracingIntegration: setSDKProcessingMetadata({
 *   normalizedRequest: getHttpRequestData() }), then sentrySpan._convertSpanToTransaction:
 *   request: normalizedRequest);
 * - transaction is WINDOW.location.pathname (appRouterRoutingInstrumentation);
 * - fetch spans carry url / http.url / http.query / http.fragment (core fetch.js getFetchSpanAttributes);
 * - navigation breadcrumbs carry data.from / data.to as relative URLs with the hash (Next's first
 *   history.replaceState writes the canonical URL, hash included; breadcrumbs.js keeps parsedTo.relative);
 *   console breadcrumbs carry the logged text.
 */
function pageloadTransaction(page: string, fragment: string): Record<string, unknown> {
  const path = new URL(page).pathname;
  const capturedSpanScope: Record<string, unknown> = { name: 'scope' };
  capturedSpanScope.self = capturedSpanScope; // real scopes are cyclic; never walked or sent
  capturedSpanScope.note = `${page}${fragment}`; // proves the walker stays out of it
  return {
    type: 'transaction',
    transaction: path,
    transaction_info: { source: 'url' },
    start_timestamp: 1760184300.1,
    timestamp: 1760184302.4,
    contexts: {
      trace: {
        trace_id: '0af7651916cd43dd8448eb211c80319c',
        span_id: 'b7ad6b7169203331',
        op: 'pageload',
        origin: 'auto.pageload.nextjs.app_router_instrumentation',
        data: {
          'sentry.op': 'pageload',
          'sentry.source': 'url',
          'sentry.sample_rate': 0.2,
          'lcp.element': 'body > div#__next > main > div > h1',
        },
      },
    },
    spans: [
      {
        op: 'http.client',
        description: 'GET https://lqaufszburqvlslpcuac.supabase.co/auth/v1/user',
        origin: 'auto.http.browser',
        data: {
          url: 'https://lqaufszburqvlslpcuac.supabase.co/auth/v1/user',
          type: 'fetch',
          'http.method': 'GET',
          'http.url': 'https://lqaufszburqvlslpcuac.supabase.co/auth/v1/user',
          'server.address': 'lqaufszburqvlslpcuac.supabase.co',
        },
      },
      {
        op: 'http.client',
        description: `GET ${path}?_rsc=1x2y3${fragment}`,
        origin: 'auto.http.browser',
        data: {
          url: `${path}?_rsc=1x2y3${fragment}`,
          type: 'fetch',
          'http.method': 'GET',
          'http.url': `${page}?_rsc=1x2y3${fragment}`,
          'http.query': '?_rsc=1x2y3',
          'http.fragment': fragment,
          'server.address': 'tricigo.com',
        },
      },
    ],
    request: {
      url: `${page}${fragment}`,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://accounts.google.com/' },
    },
    breadcrumbs: [
      { category: 'navigation', timestamp: 1, data: { from: undefined, to: `${path}${fragment}` } },
      { category: 'navigation', timestamp: 2, data: { from: `${path}${fragment}`, to: '/book' } },
      { category: 'fetch', type: 'http', timestamp: 3, data: { method: 'GET', url: `${path}?_rsc=1x2y3${fragment}`, status_code: 200 } },
      { category: 'console', timestamp: 4, message: `Opened ${page}${fragment} from the e-mail` },
    ],
    sdkProcessingMetadata: {
      capturedSpanScope,
      dynamicSamplingContext: { transaction: path, sample_rate: '0.2' },
    },
  };
}

describe('scrubUrlFragments', () => {
  it('leaves no trace of the session tokens in a pageload transaction of the login callback', () => {
    const event = pageloadTransaction(CALLBACK, LOGIN_FRAGMENT);
    expect(serialized(event)).toContain(REFRESH); // the fixture really carries them
    expect(serialized(event)).toContain(ACCESS);

    const sent = serialized(scrubUrlFragments(event));

    expect(sent).not.toContain(ACCESS);
    expect(sent).not.toContain(REFRESH);
    expect(sent).not.toContain('access_token');
    expect(sent).not.toContain('refresh_token');
    expect(sent).not.toContain('provider_token');
    expect(sent).not.toContain('ya29.');
  });

  it('keeps every URL of that transaction, query included, minus its fragment', () => {
    const out = scrubUrlFragments(pageloadTransaction(CALLBACK, LOGIN_FRAGMENT));

    const request = out.request as { url: string; headers: Record<string, string> };
    expect(request.url).toBe(CALLBACK);
    expect(request.headers.Referer).toBe('https://accounts.google.com/');

    type SpanJson = { description: string; data: Record<string, unknown> };
    const spans = out.spans as [SpanJson, SpanJson];
    expect(spans[1].description).toBe('GET /auth/callback?_rsc=1x2y3');
    expect(spans[1].data.url).toBe('/auth/callback?_rsc=1x2y3');
    expect(spans[1].data['http.url']).toBe(`${CALLBACK}?_rsc=1x2y3`);
    expect(spans[1].data['http.query']).toBe('?_rsc=1x2y3');
    expect('http.fragment' in spans[1].data).toBe(false);
    // A span that never had a fragment is untouched.
    const fresh = pageloadTransaction(CALLBACK, LOGIN_FRAGMENT).spans as [SpanJson, SpanJson];
    expect(spans[0]).toEqual(fresh[0]);

    type Crumb = { data?: Record<string, unknown>; message?: string };
    const crumbs = out.breadcrumbs as [Crumb, Crumb, Crumb, Crumb];
    expect(crumbs[0].data?.to).toBe('/auth/callback');
    expect(crumbs[1].data).toEqual({ from: '/auth/callback', to: '/book' });
    expect(crumbs[2].data?.url).toBe('/auth/callback?_rsc=1x2y3');
    expect(crumbs[3].message).toBe(`Opened ${CALLBACK} from the e-mail`);

    expect(out.transaction).toBe('/auth/callback');
    const trace = (out.contexts as { trace: { data: Record<string, unknown> } }).trace;
    expect(trace.data['lcp.element']).toBe('body > div#__next > main > div > h1');
  });

  it('covers the site-URL fallback, where the tokens land on the home page', () => {
    for (const page of ['https://tricigo.com/', 'https://tricigo.com']) {
      const out = scrubUrlFragments({ request: { url: `${page}${LOGIN_FRAGMENT}` } });
      expect(out.request.url).toBe(page);
    }
    const crumb = scrubUrlFragments({ data: { from: undefined, to: `/${LOGIN_FRAGMENT}` } });
    expect(crumb.data.to).toBe('/');
  });

  it('still covers the team digest opt-out link', () => {
    const event = pageloadTransaction(OPT_OUT, OPT_OUT_FRAGMENT);
    const sent = serialized(scrubUrlFragments(event));
    expect(sent).not.toContain(T);
    expect(sent).not.toContain(U);
    expect((event.request as { url: string }).url).toBe(OPT_OUT);
  });

  it('cuts the fragment of every page, not only the ones that carry tokens', () => {
    const out = scrubUrlFragments({
      request: { url: 'https://tricigo.com/blog#comentarios', headers: {} },
      breadcrumbs: [{ category: 'navigation', data: { from: '/blog', to: '/blog/post/?ref=ig#seccion-2' } }],
      spans: [{ data: { url: '/blog#x', 'http.url': 'https://tricigo.com/blog#x', 'http.fragment': '#x' } }],
      extra: { link: 'ver https://tricigo.com/terms#pagos y listo', quoted: '"//cdn.example.com/a.svg#icon"' },
    });
    expect(out.request.url).toBe('https://tricigo.com/blog');
    expect(out.breadcrumbs[0]?.data.to).toBe('/blog/post/?ref=ig');
    expect(out.spans[0]?.data).toEqual({ url: '/blog', 'http.url': 'https://tricigo.com/blog' });
    expect(out.extra).toEqual({ link: 'ver https://tricigo.com/terms y listo', quoted: '"//cdn.example.com/a.svg"' });
  });

  it('leaves alone a # that is not part of a URL', () => {
    const event = {
      message: 'Minified React error #418; visit https://react.dev/errors/418?args[]=text for the full message',
      exception: { values: [{ type: 'Error', value: 'Expected #ff6a00 but got #000' }] },
      breadcrumbs: [{ category: 'ui.click', message: 'body > div#__next > button#cta.primary' }],
      tags: { selector: '#root', ticket: 'BUG-201#2' },
    };
    const before = structuredClone(event);
    expect(scrubUrlFragments(event)).toEqual(before);
  });

  it('returns the same event object and never walks sdkProcessingMetadata', () => {
    const event = pageloadTransaction(CALLBACK, LOGIN_FRAGMENT);
    const meta = event.sdkProcessingMetadata as { capturedSpanScope: { note: string } };
    expect(() => scrubUrlFragments(event)).not.toThrow();
    expect(scrubUrlFragments(event)).toBe(event);
    expect(event.sdkProcessingMetadata).toBe(meta);
    expect(meta.capturedSpanScope.note).toBe(`${CALLBACK}${LOGIN_FRAGMENT}`);
  });

  it('composes with makeSentryBeforeSend the way instrumentation-client.ts does', () => {
    const dropNoise = makeSentryBeforeSend();
    const beforeSend = <E extends Record<string, unknown>>(event: E): E | null => {
      const kept = dropNoise(event);
      return kept && scrubUrlFragments(kept);
    };
    expect(beforeSend({ message: 'Failed to fetch', request: { url: `${CALLBACK}${LOGIN_FRAGMENT}` } })).toBeNull();
    const kept = beforeSend({
      message: 'Boom',
      request: { url: `${CALLBACK}${LOGIN_FRAGMENT}`, headers: { Authorization: `Bearer ${ACCESS}` } },
    });
    expect(kept?.request).toEqual({ url: CALLBACK, headers: {} });
    expect(JSON.stringify(kept)).not.toContain(ACCESS);
  });
});

describe('stripUrlFragments', () => {
  it('cuts the fragment of an app deep link, so a log line can keep where the browser came back to', () => {
    expect(stripUrlFragments(`tricigo-driver://auth/callback${LOGIN_FRAGMENT}`)).toBe('tricigo-driver://auth/callback');
    expect(stripUrlFragments(`tricigo://auth/callback?error=access_denied#error_description=x`)).toBe(
      'tricigo://auth/callback?error=access_denied',
    );
  });

  it('returns text without URL fragments unchanged', () => {
    expect(stripUrlFragments('tricigo-driver://auth/callback')).toBe('tricigo-driver://auth/callback');
    expect(stripUrlFragments('error #418')).toBe('error #418');
  });
});
