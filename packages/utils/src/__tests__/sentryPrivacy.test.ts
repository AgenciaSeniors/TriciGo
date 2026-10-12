import { describe, it, expect } from 'vitest';
import { makeSentryBeforeSend } from '../sentryNoise';
import { scrubUrlSecrets, stripUrlSecrets } from '../sentryPrivacy';

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

describe('scrubUrlSecrets', () => {
  it('leaves no trace of the session tokens in a pageload transaction of the login callback', () => {
    const event = pageloadTransaction(CALLBACK, LOGIN_FRAGMENT);
    expect(serialized(event)).toContain(REFRESH); // the fixture really carries them
    expect(serialized(event)).toContain(ACCESS);

    const sent = serialized(scrubUrlSecrets(event));

    expect(sent).not.toContain(ACCESS);
    expect(sent).not.toContain(REFRESH);
    expect(sent).not.toContain('access_token');
    expect(sent).not.toContain('refresh_token');
    expect(sent).not.toContain('provider_token');
    expect(sent).not.toContain('ya29.');
  });

  it('keeps every URL of that transaction, query included, minus its fragment', () => {
    const out = scrubUrlSecrets(pageloadTransaction(CALLBACK, LOGIN_FRAGMENT));

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
      const out = scrubUrlSecrets({ request: { url: `${page}${LOGIN_FRAGMENT}` } });
      expect(out.request.url).toBe(page);
    }
    const crumb = scrubUrlSecrets({ data: { from: undefined, to: `/${LOGIN_FRAGMENT}` } });
    expect(crumb.data.to).toBe('/');
  });

  it('still covers the team digest opt-out link', () => {
    const event = pageloadTransaction(OPT_OUT, OPT_OUT_FRAGMENT);
    const sent = serialized(scrubUrlSecrets(event));
    expect(sent).not.toContain(T);
    expect(sent).not.toContain(U);
    expect((event.request as { url: string }).url).toBe(OPT_OUT);
  });

  it('cuts the fragment of every page, not only the ones that carry tokens', () => {
    const out = scrubUrlSecrets({
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
    expect(scrubUrlSecrets(event)).toEqual(before);
  });

  it('returns the same event object and never walks sdkProcessingMetadata', () => {
    const event = pageloadTransaction(CALLBACK, LOGIN_FRAGMENT);
    const meta = event.sdkProcessingMetadata as { capturedSpanScope: { note: string } };
    expect(() => scrubUrlSecrets(event)).not.toThrow();
    expect(scrubUrlSecrets(event)).toBe(event);
    expect(event.sdkProcessingMetadata).toBe(meta);
    expect(meta.capturedSpanScope.note).toBe(`${CALLBACK}${LOGIN_FRAGMENT}`);
  });

  it('composes with makeSentryBeforeSend the way instrumentation-client.ts does', () => {
    const dropNoise = makeSentryBeforeSend();
    const beforeSend = <E extends Record<string, unknown>>(event: E): E | null => {
      const kept = dropNoise(event);
      return kept && scrubUrlSecrets(kept);
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

describe('stripUrlSecrets', () => {
  it('cuts the fragment of an app deep link, so a log line can keep where the browser came back to', () => {
    expect(stripUrlSecrets(`tricigo-driver://auth/callback${LOGIN_FRAGMENT}`)).toBe('tricigo-driver://auth/callback');
    expect(stripUrlSecrets(`tricigo://auth/callback?error=access_denied#error_description=x`)).toBe(
      'tricigo://auth/callback?error=access_denied',
    );
  });

  it('returns text without URL fragments unchanged', () => {
    expect(stripUrlSecrets('tricigo-driver://auth/callback')).toBe('tricigo-driver://auth/callback');
    expect(stripUrlSecrets('error #418')).toBe('error #418');
  });

  it('takes linear time on a crafted link, so it cannot freeze the page', () => {
    // A link to tricigo.com/#a',/,/,/… reaches every event as a navigation breadcrumb, untruncated.
    const tail = ',/'.repeat(250_000);
    const crafted = `https://tricigo.com/#a'${tail}`;
    const t0 = performance.now();
    const out = stripUrlSecrets(crafted);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(out).toBe(`https://tricigo.com/'${tail}`);
  });

  it('cuts a later fragment in the same run once an earlier # was not a URL', () => {
    expect(stripUrlSecrets('div#x,/auth/callback#access_token=a')).toBe('div#x,/auth/callback');
    expect(stripUrlSecrets('a#/x#y')).toBe('a#/x#y');
  });

  it('redacts session tokens that are not in a URL fragment', () => {
    expect(stripUrlSecrets(`hash: #access_token=${ACCESS}&refresh_token=${REFRESH}&type=recovery`)).toBe(
      'hash: #access_token=[Filtered]&refresh_token=[Filtered]&type=recovery',
    );
    expect(stripUrlSecrets(`https://tricigo.com/?refresh_token=${REFRESH}&x=1`)).toBe(
      'https://tricigo.com/?refresh_token=[Filtered]&x=1',
    );
    expect(stripUrlSecrets(`/login?return=%2Fauth%2Fcallback%23access_token%3D${ACCESS}%26provider_refresh_token%3Dz`)).toBe(
      '/login?return=%2Fauth%2Fcallback%23access_token%3D[Filtered]%26provider_refresh_token%3D[Filtered]',
    );
  });
});

// Trip share link (00513): anyone holding https://tricigo.com/track/share/<token> watches the trip until
// 48 h after it ends. /ride/share/<token> (deep link) and /delivery/<token> (old SMS, redirected) carry
// the same token.
const SHARE = 'a3f19c0b7d2e4f6a8b9c1d0e';
const SHARE_PAGE = `https://tricigo.com/track/share/${SHARE}`;
const SHARE_PATH = `/track/share/${SHARE}`;
// Single-use e-mail confirmation token (add-email-with-verification), valid 24 h until redeemed.
const MAIL = '42f8bcff025a798f46d763068ff8c31238b75cabc3717b70e8502648afc3f541';
const CONFIRM_PAGE = `https://tricigo.com/auth/email-confirmed?token=${MAIL}`;

/**
 * An http.server transaction shaped like the ones the Next.js server SDK sends for an RSC request to the
 * share page (seen on tricigo-web, 2026-10: http.target keeps the raw path while the name is the route,
 * and every request header becomes http.request.header.*, next-url and next-router-state-tree included).
 * Next's router tree carries a dynamic segment as ["token","<value>","d"], URL-encoded
 * (get-dynamic-param.js).
 */
function serverShareTransaction(): Record<string, unknown> {
  const tree = encodeURIComponent(
    JSON.stringify(['', { children: ['ride', { children: ['share', { children: [['token', SHARE, 'd'], {}] }] }] }]),
  );
  return {
    type: 'transaction',
    transaction: 'GET /track/share/[token]',
    transaction_info: { source: 'route' },
    contexts: {
      trace: {
        op: 'http.server',
        data: {
          'http.target': `${SHARE_PATH}?_rsc=1umbt`,
          'url.path': SHARE_PATH,
          'url.query': '_rsc=1umbt',
          'http.url': `https://tricigo.com${SHARE_PATH}?_rsc=1umbt`,
          'http.route': '/track/share/[token]',
          'next.route': '/track/share/[token]',
          'http.request.header.referer': `https://tricigo.com/ride/share/${SHARE}`,
          'http.request.header.next_url': `/ride/share/${SHARE}`,
          'http.request.header.next_router_state_tree': tree,
        },
      },
    },
    request: {
      url: `https://tricigo.com${SHARE_PATH}?_rsc=1umbt`,
      query_string: '_rsc=1umbt',
      headers: { referer: `https://tricigo.com/ride/share/${SHARE}` },
    },
    sdkProcessingMetadata: {
      dynamicSamplingContext: { trace_id: 't', public_key: 'k', transaction: `GET ${SHARE_PATH}` },
    },
  };
}

describe('scrubUrlSecrets: trip share links', () => {
  it('leaves no trace of the share token in a pageload transaction of the share page', () => {
    const event = pageloadTransaction(SHARE_PAGE, '');
    expect(serialized(event)).toContain(SHARE);

    const out = scrubUrlSecrets(event);

    expect(serialized(out)).not.toContain(SHARE);
    expect((out.request as { url: string }).url).toBe('https://tricigo.com/track/share/[token]');
    expect(out.transaction).toBe('/track/share/[token]');
    type Crumb = { data?: Record<string, unknown> };
    const crumbs = out.breadcrumbs as Crumb[];
    expect(crumbs[0]?.data?.to).toBe('/track/share/[token]');
    expect(crumbs[2]?.data?.url).toBe('/track/share/[token]?_rsc=1x2y3');
    const spans = out.spans as { description: string; data: Record<string, unknown> }[];
    expect(spans[1]?.description).toBe('GET /track/share/[token]?_rsc=1x2y3');
    expect(spans[1]?.data['http.url']).toBe('https://tricigo.com/track/share/[token]?_rsc=1x2y3');
  });

  it('replaces the token in every path that carries it, encoded or in a deep link', () => {
    expect(stripUrlSecrets(`https://tricigo.com/ride/share/${SHARE}`)).toBe('https://tricigo.com/ride/share/[token]');
    expect(stripUrlSecrets(`/delivery/${SHARE}?utm=sms`)).toBe('/delivery/[token]?utm=sms');
    expect(stripUrlSecrets(`tricigo://ride/share/${SHARE}`)).toBe('tricigo://ride/share/[token]');
    expect(stripUrlSecrets(`/login?return=%2Ftrack%2Fshare%2F${SHARE}%3Fx%3D1`)).toBe(
      '/login?return=%2Ftrack%2Fshare%2F[token]%3Fx%3D1',
    );
    expect(stripUrlSecrets(`Sigue mi viaje: ${SHARE_PAGE}, llego en 10`)).toBe(
      'Sigue mi viaje: https://tricigo.com/track/share/[token], llego en 10',
    );
  });

  it('keeps a name the SDK already parameterized', () => {
    for (const name of ['/track/share/:token', 'GET /track/share/[token]', '/ride/share/:token']) {
      expect(stripUrlSecrets(name)).toBe(name);
    }
  });

  it('cleans a server transaction: raw target, request headers, the router tree and the envelope trace header', () => {
    const event = serverShareTransaction();
    const sdkDsc = (event.sdkProcessingMetadata as { dynamicSamplingContext: Record<string, string> }).dynamicSamplingContext;
    const out = scrubUrlSecrets(event);

    expect(JSON.stringify(out)).not.toContain(SHARE);
    // The SDK may share its DSC object with the live root span: it gets a copy, not an edit.
    expect(sdkDsc.transaction).toBe(`GET ${SHARE_PATH}`);
    const data = (out.contexts as { trace: { data: Record<string, unknown> } }).trace.data;
    expect(data['http.target']).toBe('/track/share/[token]?_rsc=1umbt');
    expect(data['http.request.header.next_url']).toBe('/ride/share/[token]');
    expect(data['http.request.header.referer']).toBe('https://tricigo.com/ride/share/[token]');
    expect(data['http.route']).toBe('/track/share/[token]');
    expect(out.transaction).toBe('GET /track/share/[token]');
    // The envelope `trace` header is this object (core createEventEnvelopeHeaders).
    const dsc = (out.sdkProcessingMetadata as { dynamicSamplingContext: Record<string, string> }).dynamicSamplingContext;
    expect(dsc).toEqual({ trace_id: 't', public_key: 'k', transaction: 'GET /track/share/[token]' });
  });

  it('redacts the token of a PostgREST filter on share_token', () => {
    const url = `https://lqaufszburqvlslpcuac.supabase.co/rest/v1/rides?select=*&share_token=eq.${SHARE}`;
    const out = scrubUrlSecrets({
      breadcrumbs: [{ category: 'fetch', data: { method: 'GET', url, status_code: 200 } }],
      spans: [{ description: `GET ${url}`, data: { url, 'http.query': `?select=*&share_token=eq.${SHARE}` } }],
    });
    expect(JSON.stringify(out)).not.toContain(SHARE);
    expect(out.breadcrumbs[0]?.data.url).toBe(
      'https://lqaufszburqvlslpcuac.supabase.co/rest/v1/rides?select=*&share_token=[Filtered]',
    );
    expect(out.spans[0]?.data['http.query']).toBe('?select=*&share_token=[Filtered]');
  });

  it('scrubs a standalone span (INP) the way beforeSendSpan gets it', () => {
    const span = { description: 'body > main > button', data: { transaction: SHARE_PATH, 'sentry.op': 'ui.interaction.click' } };
    expect(scrubUrlSecrets(span)).toBe(span);
    expect(span.data.transaction).toBe('/track/share/[token]');
  });
});

describe('scrubUrlSecrets: e-mail confirmation link', () => {
  it('redacts the single-use token in the query, on the client and on the server', () => {
    const page = scrubUrlSecrets(pageloadTransaction(CONFIRM_PAGE, ''));
    expect(serialized(page)).not.toContain(MAIL);
    expect((page.request as { url: string }).url).toBe('https://tricigo.com/auth/email-confirmed?token=[Filtered]');

    const server = scrubUrlSecrets({
      request: { url: CONFIRM_PAGE, query_string: `token=${MAIL}` },
      contexts: { trace: { data: { 'http.target': `/auth/email-confirmed?token=${MAIL}`, 'url.query': `token=${MAIL}` } } },
    });
    expect(JSON.stringify(server)).not.toContain(MAIL);
    expect(server.request.query_string).toBe('token=[Filtered]');
  });

  it("redacts it inside Next's router tree, where the page segment carries the query as JSON", () => {
    const page = `__PAGE__?${JSON.stringify({ token: MAIL })}`;
    const tree = encodeURIComponent(
      JSON.stringify(['', { children: ['auth', { children: ['email-confirmed', { children: [page, {}] }] }] }]),
    );
    const out = stripUrlSecrets(tree);
    expect(out).not.toContain(MAIL);
    const decoded = JSON.parse(decodeURIComponent(out.replace('[Filtered]', 'X'))) as unknown;
    expect(JSON.stringify(decoded)).toContain(JSON.stringify(`__PAGE__?${JSON.stringify({ token: 'X' })}`));
  });
});

describe('stripUrlSecrets: what it leaves alone', () => {
  it('keeps other paths and ordinary uses of the word token', () => {
    for (const text of [
      '/track/2e5f710f-4836-4b11-9842-fb525bcf35cc',
      '/blog/como-compartir-tu-viaje',
      '/ride/shared/abc',
      'https://x.supabase.co/storage/v1/object/public/delivery-photos/r/1.jpg',
      'Invalid token: expected a JWT',
      'tokens=3',
      'token_type=bearer',
      'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
    ]) {
      expect(stripUrlSecrets(text)).toBe(text);
    }
  });

  it('takes linear time on crafted share paths and token runs', () => {
    for (const crafted of [
      `${'/track/share/'.repeat(40_000)}x`,
      `token${','.repeat(250_000)} `,
      `token${'%22'.repeat(100_000)} `,
      'token,'.repeat(80_000),
      '%2Ftrack%2Fshare'.repeat(30_000),
    ]) {
      const t0 = performance.now();
      stripUrlSecrets(crafted);
      expect(performance.now() - t0).toBeLessThan(250);
    }
  });
});
