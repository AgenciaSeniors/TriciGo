import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { havanaYesterday, verifyUnsubscribeToken } from '../_shared/team-digest.ts';

// Runs the real send-team-digest handler. supabase-js (esm.sh) is replaced with a fake client
// whose rpc answers come from `db`; fetch (the calls to send-email) is stubbed.

const db = vi.hoisted(() => ({
  claim: true as unknown,
  claimError: null as null | { message: string },
  metrics: null as unknown,
  metricsError: null as null | { message: string },
  recipients: [] as Array<{ user_id: string; role: string; email: string; full_name: string }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> | undefined }>,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    rpc: (fn: string, args?: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      if (fn === 'claim_team_digest') {
        return Promise.resolve(db.claimError ? { data: null, error: db.claimError } : { data: db.claim, error: null });
      }
      if (fn === 'team_daily_metrics') {
        return Promise.resolve(db.metricsError ? { data: null, error: db.metricsError } : { data: db.metrics, error: null });
      }
      if (fn === 'team_digest_recipients') return Promise.resolve({ data: db.recipients, error: null });
      if (fn === 'finish_team_digest') return Promise.resolve({ data: true, error: null });
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    },
  }),
}));

const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
};

let handler: (req: Request) => Promise<Response>;
let emailStatus: (to: string) => number = () => 200;
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(init?.body as string) as { recipient_email: string };
  const status = emailStatus(body.recipient_email);
  return new Response(JSON.stringify(status === 200 ? { success: true } : { error: 'send_failed' }), { status });
});

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => env[k] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', fetchMock);
  await import('./index.ts');
});

const ADMIN = 'a1000000-0000-4000-8000-000000000001';
const MKT = 'a1000000-0000-4000-8000-000000000003';

const zeroTotals = {
  rides: { requested: 7, completed: 2, canceled_by_rider: 1, canceled_by_driver: 1, no_driver: 2,
    no_driver_with_offer: 1, no_driver_without_offer: 1, hours_without_coverage: 21 },
  signups: { new_riders: 2, drivers_registered: 1, drivers_approved: 1, drivers_online: 2, drivers_with_ride: 1 },
  money: { charged: 3500, commission: 525, recharged: 5000 },
  marketing: { signups_with_code: 2, referrals: 1, first_rides: 1, campaigns_sent: 1, promotion_uses: 3 },
};
const METRICS = {
  day: '2026-10-07', current: zeroTotals, previous: zeroTotals, week_ago: zeroTotals,
  breakdowns: { municipalities: [], vehicles: [], bands: [] },
  pending: { drivers_under_review: 1, incidents_open: 2, sos_open: 1, disputes_open: 2, disputes_overdue: 1 },
  lists: { signup_codes: [], campaigns: [], promotions: [] },
};

beforeEach(() => {
  fetchMock.mockClear();
  emailStatus = () => 200;
  db.claim = true;
  db.claimError = null;
  db.metrics = METRICS;
  db.metricsError = null;
  db.recipients = [
    { user_id: ADMIN, role: 'admin', email: 'ana@example.com', full_name: 'Ana Admin' },
    { user_id: MKT, role: 'marketing', email: 'mia@example.com', full_name: 'Mia' },
  ];
  db.rpcCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const call = (body: unknown, internal = true) =>
  handler(new Request('https://example.supabase.co/functions/v1/send-team-digest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(internal ? { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  }));

const sentBodies = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string) as {
    template: string; subject: string; recipient_email: string; data: Record<string, unknown>;
  });
const finishArgs = () => db.rpcCalls.find((c) => c.fn === 'finish_team_digest')?.args;

describe('send-team-digest', () => {
  it('401 without the service key', async () => {
    const res = await call({ day: '2026-10-07' }, false);
    expect(res.status).toBe(401);
    expect(db.rpcCalls).toEqual([]);
  });

  it('400 for a day that is not YYYY-MM-DD', async () => {
    expect((await call({ day: '2026-02-30' })).status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it('400 for a day that is not a string: it must not quietly claim yesterday instead', async () => {
    expect((await call({ day: 20261007 })).status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it('claims the day, sends each person their version through send-email, and records the outcome', async () => {
    const res = await call({ day: '2026-10-07' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, day: '2026-10-07' });

    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['claim_team_digest', 'team_daily_metrics', 'team_digest_recipients', 'finish_team_digest']);
    expect(db.rpcCalls[0].args).toEqual({ p_day: '2026-10-07' });
    expect(fetchMock.mock.calls.every(([u]) => u === 'https://example.supabase.co/functions/v1/send-email')).toBe(true);

    const [admin, mkt] = sentBodies();
    expect(admin.recipient_email).toBe('ana@example.com');
    expect(admin.subject).toBe('TriciGo · resumen del miércoles 7 de octubre');
    expect(admin.data).toEqual({});
    expect(admin.template).toContain('Cobrado en viajes');
    expect(mkt.recipient_email).toBe('mia@example.com');
    expect(mkt.template).not.toContain('CUP');
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 2, p_sent: 2, p_failed: 0, p_error: null });
  });

  it('sends a body that takes send-email\'s raw-HTML path (not a template key, subject set)', async () => {
    await call({ day: '2026-10-07' });
    for (const b of sentBodies()) {
      // send-email rejects a bare slug as an unregistered key, and a raw body without a subject.
      expect(/^[A-Za-z0-9_-]+$/.test(b.template.trim())).toBe(false);
      expect(b.template.trim().startsWith('<')).toBe(true);
      expect(b.subject.length).toBeGreaterThan(0);
    }
  });

  it('puts a signed unsubscribe link for that person in each e-mail', async () => {
    await call({ day: '2026-10-07' });
    const html = sentBodies()[0].template;
    const m = html.match(/https:\/\/tricigo\.com\/resumen-diario\/baja#u=([0-9a-f-]+)&amp;t=([0-9a-f]{64})/);
    expect(m?.[1]).toBe(ADMIN);
    expect(await verifyUnsubscribeToken(SERVICE_KEY, ADMIN, m![2])).toBe(true);
  });

  it('a lost claim sends nothing and records nothing', async () => {
    db.claim = false;
    expect((await call({ day: '2026-10-07' })).status).toBe(202);
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['claim_team_digest']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a claim error sends nothing', async () => {
    db.claimError = { message: 'connection reset' };
    await call({ day: '2026-10-07' });
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['claim_team_digest']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('one failed address does not stop the others', async () => {
    emailStatus = (to) => (to === 'ana@example.com' ? 500 : 200);
    await call({ day: '2026-10-07' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 2, p_sent: 1, p_failed: 1, p_error: `${ADMIN}: send_failed` });
  });

  it('never writes an address or an unsubscribe token to the logs or the run log', async () => {
    const logged: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    emailStatus = () => 500;
    await call({ day: '2026-10-07' });
    const html = sentBodies()[0].template;
    const token = html.match(/&amp;t=([0-9a-f]{64})/)![1];
    const text = JSON.stringify(logged.map(String)) + JSON.stringify(finishArgs());
    expect(text).not.toContain('ana@example.com');
    expect(text).not.toContain('mia@example.com');
    expect(text).not.toContain(token);
  });

  it('a metrics error sends nothing and records the error', async () => {
    db.metricsError = { message: 'boom' };
    await call({ day: '2026-10-07' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 0, p_sent: 0, p_failed: 0, p_error: 'metrics: boom' });
  });

  it('without a day, sends the Havana day before', async () => {
    await call({});
    expect(db.rpcCalls[0].args).toEqual({ p_day: havanaYesterday(new Date()) });
  });
});
