import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real verify-otp handler. Replaced: supabase-js (esm.sh) with a fake whose
// verify_cuba_otp answer each test sets, and the DB-backed rate limiter (the test
// decides which buckets are full and sees every refund). After a right code the
// handler goes on to find the account: with db.lookupId unset the fake answers that
// lookup with an error, so the budget tests end in a 503. With it set, the fake holds
// an existing account with that phone confirmed and both sign-in paths answer a
// session for it, so a test can see how the session was minted.
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
  // Id the account lookup answers; null keeps the lookup failing (503).
  lookupId: null as string | null,
  // What public.users answers for password_set_at.
  mark: { data: null as unknown, error: null as unknown },
}));

const auth = vi.hoisted(() => {
  const session = (id: string | null) => ({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
    user: { id },
  });
  return {
    getUserById: vi.fn(async (id: string) => ({
      data: {
        user: {
          id,
          email: 'carl@gmail.com',
          phone: '5355512345', // GoTrue keeps E.164 digits without the +
          phone_confirmed_at: '2026-09-01T00:00:00Z',
          banned_until: null,
        },
      },
      error: null,
    })),
    signInWithPassword: vi.fn(async () => ({ data: { session: session(db.lookupId) }, error: null })),
    updateUserById: vi.fn(async () => ({ data: {}, error: null })),
    generateLink: vi.fn(async () => ({ data: { properties: { hashed_token: 'h' } }, error: null })),
    verifyOtp: vi.fn(async () => ({ data: { session: session(db.lookupId) }, error: null })),
  };
});

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    rpc: async (fn: string) => {
      db.rpcs.push(fn);
      if (fn === 'verify_cuba_otp') return db.verify;
      if (fn === 'lookup_auth_user_by_contact' && db.lookupId) return { data: db.lookupId, error: null };
      return { data: null, error: { message: 'lookup down' } };
    },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      if (table === 'users') {
        for (const op of ['select', 'eq']) q[op] = () => q;
        q.maybeSingle = async () => db.mark;
        return q;
      }
      for (const op of ['select', 'eq', 'gte']) q[op] = () => q;
      q.limit = async () => ({ data: db.recentlyVerified ? [{ id: 'x' }] : [], error: null });
      return q;
    },
    auth: {
      signInWithPassword: auth.signInWithPassword,
      verifyOtp: auth.verifyOtp,
      admin: {
        getUserById: auth.getUserById,
        updateUserById: auth.updateUserById,
        generateLink: auth.generateLink,
      },
    },
  }),
}));

const USER_ID = '11111111-2222-4333-8444-555555555555';

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
  db.lookupId = null;
  db.mark = { data: { password_set_at: null }, error: null };
  for (const fn of Object.values(auth)) fn.mockClear();
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

describe('verify-otp keeps a password the person chose', () => {
  beforeEach(() => {
    buckets();
    db.verify = { data: { ok: true }, error: null };
    db.lookupId = USER_ID;
  });

  it('with password_set_at, the session comes from the magic link and no password is tried or written', async () => {
    db.mark = { data: { password_set_at: '2026-10-16T00:00:00Z' }, error: null };
    const res = await verify();
    expect(res.status).toBe(200);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.updateUserById).not.toHaveBeenCalledWith(USER_ID, expect.objectContaining({ password: expect.anything() }));
    expect(auth.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'carl@gmail.com' });
  });

  it('when the mark cannot be read, it also uses the magic link', async () => {
    db.mark = { data: null, error: { message: 'column does not exist' } };
    const res = await verify();
    expect(res.status).toBe(200);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.generateLink).toHaveBeenCalled();
  });

  it('without the mark, it signs in with the derived password as before and writes nothing', async () => {
    db.mark = { data: { password_set_at: null }, error: null };
    const res = await verify();
    expect(res.status).toBe(200);
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(auth.updateUserById).not.toHaveBeenCalled();
    expect(auth.generateLink).not.toHaveBeenCalled();
  });
});
