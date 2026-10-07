import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real add-email-with-verification handler. Three things are replaced:
//  - supabase-js (imported from esm.sh, which vitest cannot load): a fake client that
//    records every query and answers like an empty database;
//  - the rate limiter (DB-backed, and it imports supabase-js too): the test decides
//    which buckets are full;
//  - fetch, so the relay to send-email is observed instead of sent.
const limiter = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  rateLimitResponse: vi.fn(
    (retryAfterMs: number) =>
      new Response(JSON.stringify({ error: 'Too many requests. Try again later.' }), {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
      }),
  ),
}));
vi.mock('../_shared/rate-limiter.ts', () => limiter);

interface Call {
  table: string;
  op: string;
  args: unknown[];
}

const db = vi.hoisted(() => ({
  calls: [] as Call[],
  user: null as { id: string } | null,
  fullName: null as string | null,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => {
  // A query builder that records each step and resolves like PostgREST with no rows,
  // except a users select that asks for full_name, which returns db.fullName.
  function query(table: string) {
    let selected = '';
    const q: Record<string, unknown> = {};
    const step = (op: string) => (...args: unknown[]) => {
      db.calls.push({ table, op, args });
      if (op === 'select') selected = String(args[0]);
      return q;
    };
    for (const op of ['select', 'ilike', 'eq', 'delete', 'insert', 'update']) q[op] = step(op);
    const result = () =>
      table === 'users' && selected.includes('full_name')
        ? { data: { full_name: db.fullName }, error: null }
        : { data: null, error: null };
    q.maybeSingle = async () => result();
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, ko);
    return q;
  }
  return {
    createClient: () => ({
      auth: {
        getUser: async () =>
          db.user
            ? { data: { user: db.user }, error: null }
            : { data: { user: null }, error: { message: 'invalid JWT' } },
      },
      from: (table: string) => query(table),
      rpc: async (fn: string, args: unknown) => {
        db.calls.push({ table: `rpc:${fn}`, op: 'rpc', args: [args] });
        return { data: null, error: null };
      },
    }),
  };
});

// Fake key material: same shape as a real secret key, not a credential.
const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const CLIENT_IP = '152.206.10.20'; // a Cuban mobile address, as the gateway reports it

const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
};

const relay = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));

let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (name: string) => env[name] },
    serve: (h: typeof handler) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', relay);
  await import('./index.ts');
});

beforeEach(() => {
  limiter.rateLimit.mockReset();
  limiter.rateLimitResponse.mockClear();
  relay.mockClear();
  db.calls = [];
  db.user = { id: USER_ID };
  db.fullName = null;
});

/** Buckets whose key starts with one of `full` are over their limit; the rest have room. */
function buckets(...full: string[]) {
  limiter.rateLimit.mockImplementation(async (key: string) => {
    const allowed = !full.some((prefix) => key.startsWith(prefix));
    return { allowed, remaining: allowed ? 1 : 0, retryAfterMs: allowed ? 0 : 1_200_000 };
  });
}

function addEmail(headers: Record<string, string> = {}, email = 'ana@example.com'): Request {
  return new Request('https://example.supabase.co/functions/v1/add-email-with-verification', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer user.jwt.token',
      'x-forwarded-for': `${CLIENT_IP}, 10.0.0.1`,
      ...headers,
    },
    body: JSON.stringify({ email }),
  });
}

function relayedBody(): { template: string; recipient_email: string; data: Record<string, unknown> } {
  const init = (relay.mock.calls[0] as unknown as [string, RequestInit])[1];
  return JSON.parse(String(init.body));
}

const tokenInserts = () =>
  db.calls.filter((c) => c.table === 'email_verification_tokens' && c.op === 'insert');

describe('add-email-with-verification', () => {
  it('relays the verification e-mail to send-email with the service key', async () => {
    buckets();

    const res = await handler(addEmail());

    expect(res.status).toBe(200);
    expect(relay).toHaveBeenCalledTimes(1);
    const [url, init] = relay.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.supabase.co/functions/v1/send-email');
    expect((init.headers as Record<string, string>).apikey).toBe(SERVICE_KEY);
    expect(relayedBody()).toMatchObject({ template: 'email_verification', recipient_email: 'ana@example.com' });
  });

  it("counts every signed-in request against the client's IP: 10 an hour", async () => {
    buckets();

    await handler(addEmail());

    expect(limiter.rateLimit).toHaveBeenCalledWith(`add-email-ip:${CLIENT_IP}`, 10, 3_600_000);
  });

  it('keeps the per-user limit: 5 an hour', async () => {
    buckets();

    await handler(addEmail());

    expect(limiter.rateLimit).toHaveBeenCalledWith(`add-email:${USER_ID}`, 5, 3_600_000);
  });

  it('answers 429 and sends nothing once the IP bucket is full, even for a fresh account', async () => {
    buckets('add-email-ip:');

    const res = await handler(addEmail());

    expect(res.status).toBe(429);
    expect(limiter.rateLimitResponse).toHaveBeenCalledWith(1_200_000, expect.any(Object));
    expect(relay).not.toHaveBeenCalled();
    expect(tokenInserts()).toHaveLength(0);
  });

  it('counts the IP bucket before reading the body, so taken-address probes are capped too', async () => {
    buckets('add-email-ip:');
    const req = addEmail({}, 'not-an-email');

    const res = await handler(req);

    expect(res.status).toBe(429);
    expect(req.bodyUsed).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  it('puts a request without x-forwarded-for in one shared bucket, and still enforces it', async () => {
    buckets('add-email-ip:unknown');
    const req = addEmail();
    req.headers.delete('x-forwarded-for');

    const res = await handler(req);

    expect(limiter.rateLimit).toHaveBeenCalledWith('add-email-ip:unknown', 10, 3_600_000);
    expect(res.status).toBe(429);
    expect(relay).not.toHaveBeenCalled();
  });

  it('does not count a request without a session against the IP bucket', async () => {
    buckets();

    const res = await handler(addEmail({ Authorization: '' }));

    expect(res.status).toBe(401);
    expect(limiter.rateLimit).not.toHaveBeenCalled();
  });

  it('does not count a request with an invalid session against the IP bucket', async () => {
    buckets();
    db.user = null;

    const res = await handler(addEmail());

    expect(res.status).toBe(401);
    expect(limiter.rateLimit).not.toHaveBeenCalled();
  });

  it("leaves the account's name out of the e-mail: its owner writes it, and anyone can be the recipient", async () => {
    buckets();
    db.fullName = 'Tu cuenta fue suspendida, entra en evil.example';

    await handler(addEmail());

    expect(relayedBody().data).not.toHaveProperty('full_name');
    expect(JSON.stringify(relayedBody())).not.toContain('evil.example');
  });
});
