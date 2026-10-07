import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real send-email handler. Two things are replaced:
//  - the rate limiter: it is DB-backed (check_rate_limit RPC) and imports supabase-js
//    from esm.sh, which vitest cannot load. The test decides whether the bucket is full;
//  - fetch, so nothing reaches Resend.
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

// Fake key material: same shape as a real secret key, not a credential.
const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const NEAR_MISS_KEY = 'sb_secret_TESTtestTESTtestTESTtest02';
const PG_NET_IP = '44.234.196.74'; // every database trigger and cron leaves from here
const OUTSIDE_IP = '203.0.113.7'; // TEST-NET-3

const env: Record<string, string> = {
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
  RESEND_API_KEY: 're_test_not_a_key',
};

const resend = vi.fn(
  async () =>
    new Response(JSON.stringify({ id: 'email_test_1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
);

let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (name: string) => env[name] },
    serve: (h: typeof handler) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', resend);
  await import('./index.ts');
});

beforeEach(() => {
  limiter.rateLimit.mockReset();
  limiter.rateLimitResponse.mockClear();
  resend.mockClear();
});

function bucket(allowed: boolean) {
  limiter.rateLimit.mockResolvedValue({ allowed, remaining: 0, retryAfterMs: allowed ? 0 : 30_000 });
}

// A raw-HTML alert, like the watchdog and support e-mails the database queues.
function sendEmail(headers: Record<string, string>): Request {
  return new Request('https://example.supabase.co/functions/v1/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      template: '<p>Hola {{name}}</p>',
      data: { name: 'Ana' },
      recipient_email: 'alertas@example.com',
      subject: 'Prueba',
    }),
  });
}

describe('send-email rate limit', () => {
  it('sends a call that carries the service key even when its IP bucket is full', async () => {
    bucket(false);

    const res = await handler(
      sendEmail({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'x-forwarded-for': PG_NET_IP }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, email_id: 'email_test_1' });
    expect(limiter.rateLimit).not.toHaveBeenCalled();
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('also skips the limiter when the service key only comes as a Bearer token', async () => {
    bucket(false);

    const res = await handler(sendEmail({ Authorization: `Bearer ${SERVICE_KEY}`, 'x-forwarded-for': PG_NET_IP }));

    expect(res.status).toBe(200);
    expect(limiter.rateLimit).not.toHaveBeenCalled();
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('still answers 429 to a caller without a key once its IP bucket is full', async () => {
    bucket(false);

    const res = await handler(sendEmail({ 'x-forwarded-for': OUTSIDE_IP }));

    expect(res.status).toBe(429);
    expect(limiter.rateLimit).toHaveBeenCalledWith(`send-email:${OUTSIDE_IP}`, 10, 60_000);
    expect(limiter.rateLimitResponse).toHaveBeenCalledWith(30_000);
    expect(resend).not.toHaveBeenCalled();
  });

  it('counts a near-miss key against the limiter and rejects it with 401', async () => {
    bucket(true);

    const res = await handler(
      sendEmail({ apikey: NEAR_MISS_KEY, Authorization: `Bearer ${NEAR_MISS_KEY}`, 'x-forwarded-for': OUTSIDE_IP }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Forbidden: send-email is internal-only' });
    expect(limiter.rateLimit).toHaveBeenCalledTimes(1);
    expect(limiter.rateLimit).toHaveBeenCalledWith(`send-email:${OUTSIDE_IP}`, 10, 60_000);
    expect(resend).not.toHaveBeenCalled();
  });

  it('reads the key the same way as the auth check: a wrong apikey wins over a valid Bearer', async () => {
    bucket(true);

    const res = await handler(
      sendEmail({ apikey: NEAR_MISS_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'x-forwarded-for': OUTSIDE_IP }),
    );

    expect(res.status).toBe(401);
    expect(limiter.rateLimit).toHaveBeenCalledTimes(1);
    expect(resend).not.toHaveBeenCalled();
  });
});
