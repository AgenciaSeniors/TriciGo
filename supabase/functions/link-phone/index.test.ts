import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real link-phone handler. Replaced: supabase-js (esm.sh) with a fake whose
// verify_cuba_otp answer each test sets, and the DB-backed rate limiter (the test
// decides which buckets are full and sees every refund).
const limiter = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  refundRateLimit: vi.fn(async () => {}),
  rateLimitResponse: vi.fn(
    (retryAfterMs: number) =>
      new Response(JSON.stringify({ error: 'Too many requests. Try again later.' }), {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
      }),
  ),
}));
vi.mock('../_shared/rate-limiter.ts', () => limiter);

const db = vi.hoisted(() => ({
  verify: { data: null as unknown, error: null as unknown },
  rpcs: [] as string[],
}));
vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u-1', created_at: '2026-01-01T00:00:00Z' } }, error: null }),
      admin: { updateUserById: async () => ({ error: null }) },
    },
    rpc: async (fn: string) => {
      db.rpcs.push(fn);
      if (fn === 'verify_cuba_otp') return db.verify;
      return { data: null, error: null };
    },
    from: () => {
      const q: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'neq', 'update']) q[op] = () => q;
      q.limit = async () => ({ data: [], error: null });
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok);
      return q;
    },
  }),
}));

const PHONE = '+5355512345';
const FAIL_KEY = `otp-fail-day:${PHONE}`;
const DAY = 24 * 60 * 60 * 1000;
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_TESTtestTESTtestTESTtest01' }),
};

let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (name: string) => env[name] },
    serve: (h: typeof handler) => {
      handler = h;
    },
  });
  await import('./index.ts');
});

beforeEach(() => {
  limiter.rateLimit.mockReset();
  limiter.refundRateLimit.mockClear();
  db.verify = { data: { ok: false, error: 'invalid_code', attempts_remaining: 3 }, error: null };
  db.rpcs = [];
});

function buckets(...full: string[]) {
  limiter.rateLimit.mockImplementation(async (key: string) => {
    const allowed = !full.some((prefix) => key.startsWith(prefix));
    return { allowed, remaining: allowed ? 1 : 0, retryAfterMs: allowed ? 0 : 3_600_000 };
  });
}

const link = () =>
  handler(
    new Request('https://example.supabase.co/functions/v1/link-phone', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer user.jwt.token',
        'x-forwarded-for': '152.206.10.20',
      },
      body: JSON.stringify({ phone: PHONE, code: '123456' }),
    }),
  );

describe('link-phone shares the daily budget of failed codes with verify-otp', () => {
  it('takes a token from the same per-number budget of 20', async () => {
    buckets();
    await link();
    expect(limiter.rateLimit).toHaveBeenCalledWith(FAIL_KEY, 20, DAY);
  });

  it('keeps the token when the code is wrong', async () => {
    buckets();
    const res = await link();
    expect(res.status).toBe(400);
    expect(limiter.refundRateLimit).not.toHaveBeenCalledWith(FAIL_KEY, DAY);
  });

  it('gives it back when the code is right', async () => {
    buckets();
    db.verify = { data: { ok: true }, error: null };
    const res = await link();
    expect(res.status).toBe(200);
    expect(limiter.refundRateLimit).toHaveBeenCalledWith(FAIL_KEY, DAY);
  });

  it('gives it back when the check itself fails', async () => {
    buckets();
    db.verify = { data: null, error: { message: 'db down' } };
    const res = await link();
    expect(res.status).toBe(503);
    expect(limiter.refundRateLimit).toHaveBeenCalledWith(FAIL_KEY, DAY);
  });

  it('does not check any code once the number spent its budget', async () => {
    buckets('otp-fail-day:');
    db.verify = { data: { ok: true }, error: null };
    const res = await link();
    expect(res.status).toBe(429);
    expect(db.rpcs).not.toContain('verify_cuba_otp');
  });
});
