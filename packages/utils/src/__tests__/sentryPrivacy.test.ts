import { describe, it, expect } from 'vitest';
import { makeSentryBeforeSend } from '../sentryNoise';
import { PRIVATE_FRAGMENT_PATHS, scrubPrivateFragments } from '../sentryPrivacy';

const U = '3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b';
const T = '9e107d9d372bb6826bd81d3542a419d6c0ffee00deadbeef0123456789abcdef';
const FRAGMENT = `#u=${U}&t=${T}`;
const PAGE = 'https://tricigo.com/resumen-diario/baja';

/** What the SDK sends: the envelope drops sdkProcessingMetadata (core envelope.js). */
function serialized(event: Record<string, unknown>): string {
  const { sdkProcessingMetadata: _dropped, ...sent } = event;
  return JSON.stringify(sent);
}

/**
 * A pageload transaction shaped like the one @sentry/nextjs 10.43 builds for this page:
 * - request.url is document.location.href captured when the pageload span starts
 *   (browserTracingIntegration: setSDKProcessingMetadata({ normalizedRequest: getHttpRequestData() }),
 *   then sentrySpan._convertSpanToTransaction: request: normalizedRequest);
 * - transaction is WINDOW.location.pathname (appRouterRoutingInstrumentation);
 * - fetch spans carry url / http.url / http.query / http.fragment (core fetch.js getFetchSpanAttributes,
 *   browser tracing/request.js);
 * - navigation breadcrumbs carry data.from / data.to, fetch breadcrumbs data.url (breadcrumbs.js).
 */
function pageloadTransaction(): Record<string, unknown> {
  const capturedSpanScope: Record<string, unknown> = { name: 'scope' };
  capturedSpanScope.self = capturedSpanScope; // real scopes are cyclic; never walked or sent
  capturedSpanScope.note = `${PAGE}${FRAGMENT}`; // proves the walker stays out of it
  return {
    type: 'transaction',
    transaction: '/resumen-diario/baja',
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
          'sentry.origin': 'auto.pageload.nextjs.app_router_instrumentation',
          'sentry.source': 'url',
          'sentry.sample_rate': 0.2,
          'performance.timeOrigin': 1760184300000,
          'lcp.element': 'body > main > div > h1',
        },
      },
    },
    spans: [
      {
        op: 'http.client',
        description: 'POST https://lqaufszburqvlslpcuac.supabase.co/functions/v1/team-digest-unsubscribe',
        origin: 'auto.http.browser',
        data: {
          url: 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/team-digest-unsubscribe',
          type: 'fetch',
          'http.method': 'POST',
          'http.url': 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/team-digest-unsubscribe',
          'server.address': 'lqaufszburqvlslpcuac.supabase.co',
          'sentry.op': 'http.client',
        },
      },
      {
        op: 'http.client',
        description: 'GET /resumen-diario/baja',
        origin: 'auto.http.browser',
        data: {
          url: `/resumen-diario/baja?_rsc=1x2y3${FRAGMENT}`,
          type: 'fetch',
          'http.method': 'GET',
          'http.url': `${PAGE}?_rsc=1x2y3${FRAGMENT}`,
          'http.query': '?_rsc=1x2y3',
          'http.fragment': FRAGMENT,
          'server.address': 'tricigo.com',
        },
      },
    ],
    request: {
      url: `${PAGE}${FRAGMENT}`,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mail.google.com/' },
    },
    breadcrumbs: [
      { category: 'navigation', timestamp: 1, data: { from: undefined, to: `/resumen-diario/baja${FRAGMENT}` } },
      { category: 'navigation', timestamp: 2, data: { from: `/resumen-diario/baja${FRAGMENT}`, to: '/resumen-diario/baja' } },
      { category: 'fetch', type: 'http', timestamp: 3, data: { method: 'GET', url: `/resumen-diario/baja?_rsc=1x2y3${FRAGMENT}`, status_code: 200 } },
      { category: 'console', timestamp: 4, message: `Opened ${PAGE}${FRAGMENT} from the e-mail` },
    ],
    sdkProcessingMetadata: {
      capturedSpanScope,
      dynamicSamplingContext: { transaction: '/resumen-diario/baja', sample_rate: '0.2' },
    },
  };
}

describe('scrubPrivateFragments', () => {
  it('covers the team digest opt-out page', () => {
    expect(PRIVATE_FRAGMENT_PATHS).toContain('/resumen-diario/baja');
  });

  it('leaves no trace of the token anywhere in a pageload transaction of the page', () => {
    const event = pageloadTransaction();
    expect(serialized(event)).toContain(`t=${T}`); // the fixture really carries it

    const out = scrubPrivateFragments(event);
    const sent = serialized(out);

    expect(sent).not.toContain('t=');
    expect(sent).not.toContain(T);
    expect(sent).not.toContain(U);
    expect(sent).not.toContain('#u=');

    const request = out.request as { url: string; headers: Record<string, string> };
    expect(request.url).toBe(PAGE);
    expect(request.headers.Referer).toBe('https://mail.google.com/');

    type SpanJson = { data: Record<string, unknown> };
    const spans = out.spans as [SpanJson, SpanJson];
    expect(spans[1].data.url).toBe('/resumen-diario/baja?_rsc=1x2y3');
    expect(spans[1].data['http.url']).toBe(`${PAGE}?_rsc=1x2y3`);
    expect(spans[1].data['http.query']).toBe('?_rsc=1x2y3');
    expect('http.fragment' in spans[1].data).toBe(false);
    // Spans that never pointed at the page are untouched.
    expect(spans[0].data).toEqual((pageloadTransaction().spans as [SpanJson, SpanJson])[0].data);

    type Crumb = { data?: Record<string, unknown>; message?: string };
    const crumbs = out.breadcrumbs as [Crumb, Crumb, Crumb, Crumb];
    expect(crumbs[0].data?.to).toBe('/resumen-diario/baja');
    expect(crumbs[1].data).toEqual({ from: '/resumen-diario/baja', to: '/resumen-diario/baja' });
    expect(crumbs[2].data?.url).toBe('/resumen-diario/baja?_rsc=1x2y3');
    expect(crumbs[3].message).toBe(`Opened ${PAGE} from the e-mail`);

    expect(out.transaction).toBe('/resumen-diario/baja');
  });

  it('returns the same event object and never walks sdkProcessingMetadata', () => {
    const event = pageloadTransaction();
    const meta = event.sdkProcessingMetadata as { capturedSpanScope: { note: string } };
    expect(() => scrubPrivateFragments(event)).not.toThrow();
    expect(scrubPrivateFragments(event)).toBe(event);
    expect(event.sdkProcessingMetadata).toBe(meta);
    expect(meta.capturedSpanScope.note).toBe(`${PAGE}${FRAGMENT}`);
  });

  it('cleans a full href in the transaction name, should an instrumentation ever put one there', () => {
    const out = scrubPrivateFragments({ type: 'transaction', transaction: `${PAGE}${FRAGMENT}` });
    expect(out.transaction).toBe(PAGE);
  });

  it('keeps the fragment of every other page', () => {
    const event = {
      exception: { values: [{ type: 'TypeError', value: 'x is undefined' }] },
      request: { url: 'https://tricigo.com/blog#comentarios', headers: {} },
      breadcrumbs: [{ category: 'navigation', data: { from: '/blog', to: '/blog#comentarios' } }],
      spans: [{ data: { url: '/blog#comentarios', 'http.url': 'https://tricigo.com/blog#comentarios', 'http.fragment': '#comentarios' } }],
      extra: {
        near: 'https://tricigo.com/resumen-diario/bajas#otra',
        nested: 'https://tricigo.com/x/resumen-diario/baja#otra',
        text: 'ver /docs/resumen-diario/baja#seccion',
      },
    };
    const before = structuredClone(event);
    expect(scrubPrivateFragments(event)).toEqual(before);
  });

  it('cleans the page URL that a breadcrumb carries into an event of another page', () => {
    const event = {
      request: { url: 'https://tricigo.com/blog#comentarios', headers: {} },
      breadcrumbs: [
        { category: 'navigation', data: { from: `/resumen-diario/baja${FRAGMENT}`, to: '/resumen-diario/baja' } },
        { category: 'navigation', data: { from: '/resumen-diario/baja', to: '/blog#comentarios' } },
      ],
    };
    const out = scrubPrivateFragments(event);
    expect(out.request.url).toBe('https://tricigo.com/blog#comentarios');
    expect(out.breadcrumbs[0]?.data.from).toBe('/resumen-diario/baja');
    expect(out.breadcrumbs[1]?.data.to).toBe('/blog#comentarios');
    expect(JSON.stringify(out)).not.toContain(T);
  });

  it('handles a trailing slash and a query before the fragment', () => {
    const out = scrubPrivateFragments({ request: { url: `${PAGE}/?utm_source=correo${FRAGMENT}` } });
    expect(out.request.url).toBe(`${PAGE}/?utm_source=correo`);
  });

  it('composes with makeSentryBeforeSend the way instrumentation-client.ts does', () => {
    const dropNoise = makeSentryBeforeSend();
    const beforeSend = <E extends Record<string, unknown>>(event: E): E | null => {
      const kept = dropNoise(event);
      return kept && scrubPrivateFragments(kept);
    };
    expect(beforeSend({ message: 'Failed to fetch', request: { url: `${PAGE}${FRAGMENT}` } })).toBeNull();
    const kept = beforeSend({
      message: 'Boom',
      request: { url: `${PAGE}${FRAGMENT}`, headers: { Authorization: 'Bearer secret' } },
    });
    expect(kept?.request).toEqual({ url: PAGE, headers: {} });
  });
});
