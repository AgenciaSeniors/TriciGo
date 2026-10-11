import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { unsubscribeToken } from '../_shared/team-digest.ts';

// Runs the real handler. supabase-js and the DB-backed rate limiter are replaced; Deno is stubbed.
const db = vi.hoisted(() => ({
  result: true as unknown,
  error: null as null | { message: string },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> | undefined }>,
}));
vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    rpc: (fn: string, args?: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      return Promise.resolve(db.error ? { data: null, error: db.error } : { data: db.result, error: null });
    },
  }),
}));
const limiter = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  rateLimitResponse: vi.fn((ms: number, cors: Record<string, string> = {}) => new Response(JSON.stringify({ error: 'Too many requests.' }), {
    status: 429, headers: { ...cors, 'Retry-After': String(Math.ceil(ms / 1000)) },
  })),
}));
vi.mock('../_shared/rate-limiter.ts', () => limiter);

const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
  ALLOWED_ORIGINS: 'https://tricigo.com',
};
let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => env[k] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  });
  await import('./index.ts');
});

const USER = 'a1000000-0000-4000-8000-000000000001';
let TOKEN = '';

beforeEach(async () => {
  TOKEN = await unsubscribeToken(SERVICE_KEY, USER);
  db.result = true;
  db.error = null;
  db.rpcCalls = [];
  limiter.rateLimit.mockReset();
  limiter.rateLimit.mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
});

afterEach(() => {
  delete env.TEAM_DIGEST_SECRET;
  vi.restoreAllMocks();
});

const post = (body: unknown, raw = false) =>
  handler(new Request('https://example.supabase.co/functions/v1/team-digest-unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tricigo.com', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    body: raw ? (body as string) : JSON.stringify(body),
  }));

describe('team-digest-unsubscribe', () => {
  it('answers the browser preflight for tricigo.com', async () => {
    const res = await handler(new Request('https://example.supabase.co/functions/v1/team-digest-unsubscribe', {
      method: 'OPTIONS', headers: { Origin: 'https://tricigo.com' },
    }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://tricigo.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('content-type');
    // The allowed origin is echoed per request, so caches must key on Origin.
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('does not allow an origin outside ALLOWED_ORIGINS', async () => {
    const res = await handler(new Request('https://example.supabase.co/functions/v1/team-digest-unsubscribe', {
      method: 'OPTIONS', headers: { Origin: 'https://evil.example' },
    }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('refuses GET: a link scanner must never opt anyone out', async () => {
    const res = await handler(new Request(`https://example.supabase.co/functions/v1/team-digest-unsubscribe?u=${USER}&t=${TOKEN}`));
    expect(res.status).toBe(405);
    expect(db.rpcCalls).toEqual([]);
  });

  it('opts the person out with a valid link', async () => {
    const res = await post({ u: USER, t: TOKEN, action: 'out' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://tricigo.com');
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(await res.json()).toEqual({ ok: true, subscribed: false });
    expect(db.rpcCalls).toEqual([{ fn: 'set_team_digest_optout', args: { p_user: USER, p_out: true } }]);
  });

  it('brings the person back', async () => {
    const res = await post({ u: USER, t: TOKEN, action: 'in' });
    expect(await res.json()).toEqual({ ok: true, subscribed: true });
    expect(db.rpcCalls[0].args).toEqual({ p_user: USER, p_out: false });
  });

  it('403 for a token made for someone else, readable by the page', async () => {
    const other = await unsubscribeToken(SERVICE_KEY, 'a1000000-0000-4000-8000-000000000002');
    const res = await post({ u: USER, t: other, action: 'out' });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://tricigo.com');
    expect(await res.json()).toEqual({ error: 'bad_link' });
    expect(db.rpcCalls).toEqual([]);
  });

  it('with TEAM_DIGEST_SECRET set, only a token signed with it works, not one signed with the service key', async () => {
    env.TEAM_DIGEST_SECRET = 'own-digest-secret';
    const withServiceKey = await unsubscribeToken(SERVICE_KEY, USER);
    const rejected = await post({ u: USER, t: withServiceKey, action: 'out' });
    expect(rejected.status).toBe(403);
    expect(db.rpcCalls).toEqual([]);
    const withSecret = await unsubscribeToken('own-digest-secret', USER);
    const accepted = await post({ u: USER, t: withSecret, action: 'out' });
    expect(accepted.status).toBe(200);
    expect(db.rpcCalls).toEqual([{ fn: 'set_team_digest_optout', args: { p_user: USER, p_out: true } }]);
  });

  it('400 for malformed input', async () => {
    expect((await post({ u: 'x', t: TOKEN, action: 'out' })).status).toBe(400);
    expect((await post({ u: USER, t: 'abc', action: 'out' })).status).toBe(400);
    expect((await post({ u: USER, t: TOKEN, action: 'delete' })).status).toBe(400);
    expect((await post({ u: USER, t: TOKEN })).status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it('400 for a body that is not a JSON object', async () => {
    expect((await post('null', true)).status).toBe(400);
    expect((await post('not json', true)).status).toBe(400);
    expect((await post('[]', true)).status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it('404 when the account no longer exists', async () => {
    db.result = false;
    expect((await post({ u: USER, t: TOKEN, action: 'out' })).status).toBe(404);
  });

  it('500 when the database fails, without logging the token', async () => {
    const logged: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    db.error = { message: 'connection reset' };
    const res = await post({ u: USER, t: TOKEN, action: 'out' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(JSON.stringify(logged.map(String))).not.toContain(TOKEN);
  });

  it('counts each address in its own hourly bucket of 20', async () => {
    await post({ u: USER, t: TOKEN, action: 'out' });
    expect(limiter.rateLimit).toHaveBeenCalledWith('team-digest-unsub:203.0.113.7', 20, 60 * 60 * 1000);
  });

  it('429 once the address bucket is full', async () => {
    limiter.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 60_000 });
    const res = await post({ u: USER, t: TOKEN, action: 'out' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://tricigo.com');
    expect(db.rpcCalls).toEqual([]);
  });
});
