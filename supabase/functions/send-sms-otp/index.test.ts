import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real send-sms-otp handler. Replaced: supabase-js (esm.sh) with a fake
// client that records otp_codes writes, the DB-backed rate limiter (the test decides
// which buckets are full and sees every refund), and the D7 sender.
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

const d7 = vi.hoisted(() => ({ sendSmsViaD7: vi.fn() }));
vi.mock('../_shared/d7.ts', () => d7);

const db = vi.hoisted(() => ({ inserted: [] as Array<Record<string, unknown>> }));
vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const op of ['delete', 'eq', 'is']) q[op] = () => q;
      q.insert = async (row: Record<string, unknown>) => {
        db.inserted.push(row);
        return { error: null };
      };
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok);
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
  }),
}));

const PHONE = '+5355512345';
const DEMO = '+5355550100';
const DAY_KEY = `otp-send-day:${PHONE}`;
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_TESTtestTESTtestTESTtest01' }),
  D7_API_TOKEN: 'd7-test',
  DEMO_PHONE: DEMO,
  DEMO_OTP_CODE: '482915',
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
  limiter.rateLimitResponse.mockClear();
  d7.sendSmsViaD7.mockReset();
  d7.sendSmsViaD7.mockResolvedValue({ ok: true });
  db.inserted = [];
});

/** Buckets whose key starts with one of `full` are over their limit; the rest have room. */
function buckets(...full: string[]) {
  limiter.rateLimit.mockImplementation(async (key: string) => {
    const allowed = !full.some((prefix) => key.startsWith(prefix));
    return { allowed, remaining: allowed ? 1 : 0, retryAfterMs: allowed ? 0 : 3_600_000 };
  });
}

const send = (phone = PHONE) =>
  handler(
    new Request('https://example.supabase.co/functions/v1/send-sms-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '152.206.10.20' },
      body: JSON.stringify({ phone }),
    }),
  );

const dayCalls = () => limiter.rateLimit.mock.calls.filter(([key]) => String(key).startsWith('otp-send-day:'));

describe('send-sms-otp daily cap per number', () => {
  it('takes one token a day per number, from a budget of 15', async () => {
    buckets();
    const res = await send();
    expect(res.status).toBe(200);
    expect(dayCalls()).toEqual([[DAY_KEY, 15, 24 * 60 * 60 * 1000]]);
    expect(d7.sendSmsViaD7).toHaveBeenCalledTimes(1);
  });

  it('sends nothing once the number used its day, and gives back the 10-minute token', async () => {
    buckets('otp-send-day:');
    const res = await send();
    expect(res.status).toBe(429);
    expect(d7.sendSmsViaD7).not.toHaveBeenCalled();
    expect(db.inserted).toEqual([]);
    expect(limiter.refundRateLimit).toHaveBeenCalledWith(`send-sms-otp:phone:${PHONE}`, 10 * 60 * 1000);
    expect(limiter.refundRateLimit).not.toHaveBeenCalledWith(DAY_KEY, expect.anything());
  });

  it('gives the day token back when D7 does not send', async () => {
    buckets();
    d7.sendSmsViaD7.mockResolvedValue({ ok: false, error: 'rejected' });
    const res = await send();
    expect(res.status).toBe(502);
    expect(limiter.refundRateLimit).toHaveBeenCalledWith(DAY_KEY, 24 * 60 * 60 * 1000);
  });

  it('leaves the store-review demo numbers out of it (fixed code, no SMS)', async () => {
    buckets('otp-send-day:');
    const res = await send(DEMO);
    expect(res.status).toBe(200);
    expect(dayCalls()).toEqual([]);
    expect(d7.sendSmsViaD7).not.toHaveBeenCalled();
  });
});

describe('send-sms-otp code', () => {
  it('stores and texts the same six-digit code', async () => {
    buckets();
    await send();
    const code = String(db.inserted[0]?.code);
    expect(code).toMatch(/^\d{6}$/);
    expect(String(d7.sendSmsViaD7.mock.calls[0][1])).toContain(code);
  });
});
