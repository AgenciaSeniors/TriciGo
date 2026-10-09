import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real verify-otp handler up to the code check. Replaced: supabase-js
// (esm.sh) with a fake whose verify_cuba_otp answer each test sets, and the DB-backed
// rate limiter (the test decides which buckets are full and sees every refund).
// After a right code the handler goes on to find the account; the fake answers that
// lookup with an error, so those tests end in a 503 and only check the budget.
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
  recentlyVerified: false,
  rpcs: [] as string[],
}));
vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    rpc: async (fn: string) => {
      db.rpcs.push(fn);
      if (fn === 'verify_cuba_otp') return db.verify;
      return { data: null, error: { message: 'lookup down' } };
    },
    from: () => {
      const q: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'gte']) q[op] = () => q;
      q.limit = async () => ({ data: db.recentlyVerified ? [{ id: 'x' }] : [], error: null });
      return q;
    },
  }),
}));

const PHONE = '+5355512345';
const FAIL_KEY = `otp-fail-day:${PHONE}`;
const DAY = 24 * 60 * 60 * 1000;
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
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
  db.recentlyVerified = false;
  db.rpcs = [];
});

function buckets(...full: string[]) {
  limiter.rateLimit.mockImplementation(async (key: string) => {
    const allowed = !full.some((prefix) => key.startsWith(prefix));
    return { allowed, remaining: allowed ? 1 : 0, retryAfterMs: allowed ? 0 : 3_600_000 };
  });
}

const verify = (phone = PHONE, code = '123456') =>
  handler(
    new Request('https://example.supabase.co/functions/v1/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '152.206.10.20' },
      body: JSON.stringify({ phone, code }),
    }),
  );

describe('verify-otp daily budget of failed codes per number', () => {
  it('takes a token from the shared budget of 20 before checking the code', async () => {
    buckets();
    await verify();
    expect(limiter.rateLimit).toHaveBeenCalledWith(FAIL_KEY, 20, DAY);
  });

  it('keeps the token when the code is wrong', async () => {
    buckets();
    const res = await verify();
    expect(res.status).toBe(400);
    expect(limiter.refundRateLimit).not.toHaveBeenCalledWith(FAIL_KEY, DAY);
  });

  it('keeps it for an expired code too: a guess against a code verified in the last 3 minutes', async () => {
    buckets();
    db.verify = { data: { ok: false, error: 'no_active_code' }, error: null };
    const res = await verify();
    expect(res.status).toBe(400);
    expect(limiter.refundRateLimit).not.toHaveBeenCalledWith(FAIL_KEY, DAY);
  });

  it('gives the token back when the code is right', async () => {
    buckets();
    db.verify = { data: { ok: true }, error: null };
    await verify();
    expect(limiter.refundRateLimit).toHaveBeenCalledWith(FAIL_KEY, DAY);
  });

  it('gives it back on the 3-minute re-mint of a code that was already right', async () => {
    buckets();
    db.verify = { data: { ok: false, error: 'no_active_code' }, error: null };
    db.recentlyVerified = true;
    await verify();
    expect(limiter.refundRateLimit).toHaveBeenCalledWith(FAIL_KEY, DAY);
  });

  it('gives it back when the check itself fails (nothing was guessed)', async () => {
    buckets();
    db.verify = { data: null, error: { message: 'db down' } };
    const res = await verify();
    expect(res.status).toBe(503);
    expect(limiter.refundRateLimit).toHaveBeenCalledWith(FAIL_KEY, DAY);
  });

  it('does not check any code once the number spent its budget', async () => {
    buckets('otp-fail-day:');
    db.verify = { data: { ok: true }, error: null };
    const res = await verify();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ reason: 'too_many_attempts' });
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(db.rpcs).not.toContain('verify_cuba_otp');
  });

  it('keys the budget on the phone exactly as the code lookup sees it', async () => {
    buckets();
    await verify('5355512345');
    expect(limiter.rateLimit).toHaveBeenCalledWith(FAIL_KEY, 20, DAY);
  });
});
