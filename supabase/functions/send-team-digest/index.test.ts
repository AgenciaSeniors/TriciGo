import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyUnsubscribeToken } from '../_shared/team-digest.ts';

// Runs the real send-team-digest handler. supabase-js (esm.sh) is replaced with a fake client
// whose rpc answers come from `db`; fetch (the calls to send-email) is stubbed per address; the
// template is the real one, wrapped so a test can make it throw for one person. Date is fixed at
// 2026-10-11 12:00 UTC (Havana yesterday = 2026-10-10); timers are real.

const db = vi.hoisted(() => ({
  claim: true as unknown,
  claimError: null as null | { message: string },
  metrics: null as unknown,
  metricsError: null as null | { message: string },
  recipients: [] as Array<{ user_id: string; role: string; email: string; full_name: string }>,
  recipientsError: null as null | { message: string },
  finishResult: true as unknown,
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
      if (fn === 'team_digest_recipients') {
        return Promise.resolve(db.recipientsError ? { data: null, error: db.recipientsError } : { data: db.recipients, error: null });
      }
      if (fn === 'finish_team_digest') return Promise.resolve({ data: db.finishResult, error: null });
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    },
  }),
}));

const render = vi.hoisted(() => ({ throwFor: null as string | null }));
vi.mock('../_shared/email-templates/team_daily_digest.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../_shared/email-templates/team_daily_digest.ts')>();
  return {
    ...real,
    teamDailyDigestHtml: (d: Parameters<typeof real.teamDailyDigestHtml>[0]) => {
      if (render.throwFor !== null && d.name === render.throwFor) throw new Error('render boom');
      return real.teamDailyDigestHtml(d);
    },
  };
});

const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
  // The 1 s wait before the retry, made 0 so the tests stay fast.
  TEAM_DIGEST_RETRY_DELAY_MS: '0',
};

let handler: (req: Request) => Promise<Response>;
// Per address, the answers of send-email in order ('throw' = fetch rejects); then 200.
let emailPlan: Record<string, Array<number | 'throw'>> = {};
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(init?.body as string) as { recipient_email: string };
  const next = emailPlan[body.recipient_email]?.shift() ?? 200;
  if (next === 'throw') throw new TypeError('network down');
  return new Response(JSON.stringify(next === 200 ? { success: true } : { error: 'send_failed' }), { status: next });
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
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
const SUPER = 'a1000000-0000-4000-8000-000000000002';
const MKT = 'a1000000-0000-4000-8000-000000000003';
const OPERATOR = 'a1000000-0000-4000-8000-000000000004';
const ADDRESSES = ['ana@example.com', 'sam@example.com', 'mia@example.com'];

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

let logged: unknown[] = [];

beforeEach(() => {
  fetchMock.mockClear();
  emailPlan = {};
  render.throwFor = null;
  db.claim = true;
  db.claimError = null;
  db.metrics = METRICS;
  db.metricsError = null;
  db.recipients = [
    { user_id: ADMIN, role: 'admin', email: 'ana@example.com', full_name: 'Ana Admin' },
    { user_id: MKT, role: 'marketing', email: 'mia@example.com', full_name: 'Mia' },
  ];
  db.recipientsError = null;
  db.finishResult = true;
  db.rpcCalls = [];
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });
  }
});

afterEach(() => {
  delete env.TEAM_DIGEST_SECRET;
  vi.restoreAllMocks();
});

const callRaw = (body: string | null, headers: Record<string, string> = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }) =>
  handler(new Request('https://example.supabase.co/functions/v1/send-team-digest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  }));
const call = (body: unknown, internal = true) => callRaw(JSON.stringify(body), internal ? undefined : {});

const sentBodies = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string) as {
    template: string; subject: string; recipient_email: string; data: Record<string, unknown>;
  });
const sentTo = () => sentBodies().map((b) => b.recipient_email);
const fns = () => db.rpcCalls.map((c) => c.fn);
const finishArgs = () => db.rpcCalls.find((c) => c.fn === 'finish_team_digest')?.args;
const logText = () => JSON.stringify(logged.map(String));
const linkIn = (html: string) => html.match(/https:\/\/tricigo\.com\/resumen-diario\/baja#u=([0-9a-f-]+)&amp;t=([0-9a-f]{64})/);

describe('send-team-digest: who may call it', () => {
  it('401 without the service key', async () => {
    const res = await call({ day: '2026-10-07' }, false);
    expect(res.status).toBe(401);
    expect(db.rpcCalls).toEqual([]);
  });

  it('401 when headers are present but neither is the exact service key', async () => {
    const jwtLike = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl';
    const res = await callRaw(JSON.stringify({ day: '2026-10-07' }), { Authorization: `Bearer ${jwtLike}`, apikey: 'sb_publishable_x' });
    expect(res.status).toBe(401);
    const almost = await callRaw(JSON.stringify({ day: '2026-10-07' }), { apikey: `${SERVICE_KEY}x`, Authorization: `Bearer ${SERVICE_KEY}x` });
    expect(almost.status).toBe(401);
    expect(db.rpcCalls).toEqual([]);
  });
});

describe('send-team-digest: input', () => {
  it('400 for a day that is not YYYY-MM-DD', async () => {
    expect((await call({ day: '2026-02-30' })).status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it('400 for a day that is not a string: it must not quietly claim yesterday instead', async () => {
    expect((await call({ day: 20261007 })).status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it('400 for a body that is not valid JSON, or not a JSON object', async () => {
    expect((await callRaw('not json')).status).toBe(400);
    expect((await callRaw('{"day":')).status).toBe(400);
    expect((await callRaw('[]')).status).toBe(400);
    expect((await callRaw('"2026-10-07"')).status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it('400 for a day after the Havana day before: a future day must not block its real run', async () => {
    expect((await call({ day: '2026-10-11' })).status).toBe(400);
    expect((await call({ day: '2099-01-01' })).status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
    expect((await call({ day: '2026-10-10' })).status).toBe(202);
  });

  it('without a day, sends the Havana day before (missing body, null body, null day, empty object)', async () => {
    for (const send of [() => callRaw(null), () => callRaw(''), () => callRaw('null'), () => call({ day: null }), () => call({})]) {
      db.rpcCalls = [];
      const res = await send();
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ accepted: true, day: '2026-10-10' });
      expect(db.rpcCalls[0].args).toEqual({ p_day: '2026-10-10' });
    }
  });
});

describe('send-team-digest: the run', () => {
  it('reads first, then claims, sends each person their version through send-email, and records the outcome', async () => {
    const res = await call({ day: '2026-10-07' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, day: '2026-10-07' });

    expect(fns()).toEqual(['team_daily_metrics', 'team_digest_recipients', 'claim_team_digest', 'finish_team_digest']);
    expect(db.rpcCalls[0].args).toEqual({ p_day: '2026-10-07' });
    expect(db.rpcCalls[2].args).toEqual({ p_day: '2026-10-07' });
    expect(fetchMock.mock.calls.every(([u]) => u === 'https://example.supabase.co/functions/v1/send-email')).toBe(true);
    expect(fetchMock.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);

    const [admin, mkt] = sentBodies();
    expect(admin.recipient_email).toBe('ana@example.com');
    expect(admin.subject).toBe('TriciGo · resumen del miércoles 7 de octubre');
    expect(admin.data).toEqual({});
    expect(admin.template).toContain('Cobrado en viajes');
    expect(mkt.recipient_email).toBe('mia@example.com');
    expect(mkt.template).not.toContain('CUP');
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 2, p_sent: 2, p_failed: 0, p_error: null });
  });

  it("sends a body that takes send-email's raw-HTML path (not a template key, subject set)", async () => {
    await call({ day: '2026-10-07' });
    for (const b of sentBodies()) {
      // send-email rejects a bare slug as an unregistered key, and a raw body without a subject.
      expect(/^[A-Za-z0-9_-]+$/.test(b.template.trim())).toBe(false);
      expect(b.template.trim().startsWith('<')).toBe(true);
      expect(b.subject.length).toBeGreaterThan(0);
    }
  });

  it('an operator gets the pending block and none of the money (00668)', async () => {
    db.recipients = [{ user_id: OPERATOR, role: 'operator', email: 'ora@example.com', full_name: 'Ora' }];
    await call({ day: '2026-10-07' });
    expect(sentTo()).toEqual(['ora@example.com']);
    const html = sentBodies()[0].template;
    expect(html).toContain('Pendiente ahora');
    expect(html).toContain('Conductores esperando aprobaci');
    expect(html).toContain('Disputas abiertas');
    // The money block and its amounts (3,500 charged, 525 commission, 5,000 recharged).
    for (const leak of ['Dinero', 'Cobrado en viajes', 'Comisi', 'Saldo recargado', 'CUP', '3,500', '525', '5,000']) {
      expect(html).not.toContain(leak);
    }
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 1, p_sent: 1, p_failed: 0, p_error: null });
  });

  it('puts a signed unsubscribe link for that person in each e-mail, account and token in the fragment', async () => {
    await call({ day: '2026-10-07' });
    const m = linkIn(sentBodies()[0].template);
    expect(m?.[1]).toBe(ADMIN);
    expect(await verifyUnsubscribeToken(SERVICE_KEY, ADMIN, m![2])).toBe(true);
    expect(sentBodies()[0].template).not.toContain('/resumen-diario/baja?');
  });

  it('with TEAM_DIGEST_SECRET set, the link is signed with it and not with the service key', async () => {
    env.TEAM_DIGEST_SECRET = 'own-digest-secret';
    await call({ day: '2026-10-07' });
    const m = linkIn(sentBodies()[1].template);
    expect(m?.[1]).toBe(MKT);
    expect(await verifyUnsubscribeToken('own-digest-secret', MKT, m![2])).toBe(true);
    expect(await verifyUnsubscribeToken(SERVICE_KEY, MKT, m![2])).toBe(false);
  });

  it('with nobody to send to, still records the claimed run (0 recipients, no error)', async () => {
    db.recipients = [];
    await call({ day: '2026-10-07' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fns()).toEqual(['team_daily_metrics', 'team_digest_recipients', 'claim_team_digest', 'finish_team_digest']);
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 0, p_sent: 0, p_failed: 0, p_error: null });
  });

  it('logs, without addresses, when the result could not be recorded (the run was already swept)', async () => {
    db.finishResult = false;
    await call({ day: '2026-10-07' });
    expect(logText()).toMatch(/2026-10-07: result not recorded/);
    expect(logText()).toContain('sent=2');
    for (const a of ADDRESSES) expect(logText()).not.toContain(a);
  });
});

describe('send-team-digest: nothing is claimed until the reads succeed', () => {
  it('a metrics error claims nothing, records nothing and sends nothing', async () => {
    db.metricsError = { message: 'boom' };
    expect((await call({ day: '2026-10-07' })).status).toBe(202);
    expect(fns()).toEqual(['team_daily_metrics']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logText()).toContain('boom');
  });

  it('metrics with an unexpected shape claim nothing', async () => {
    db.metrics = { day: '2026-10-07' };
    await call({ day: '2026-10-07' });
    expect(fns()).toEqual(['team_daily_metrics']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a recipients error claims nothing, records nothing and sends nothing', async () => {
    db.recipientsError = { message: 'permission denied' };
    await call({ day: '2026-10-07' });
    expect(fns()).toEqual(['team_daily_metrics', 'team_digest_recipients']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logText()).toContain('permission denied');
  });

  it('a lost claim after the reads sends nothing and records nothing', async () => {
    db.claim = false;
    expect((await call({ day: '2026-10-07' })).status).toBe(202);
    expect(fns()).toEqual(['team_daily_metrics', 'team_digest_recipients', 'claim_team_digest']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a claim error sends nothing and records nothing', async () => {
    db.claimError = { message: 'connection reset' };
    await call({ day: '2026-10-07' });
    expect(fns()).toEqual(['team_daily_metrics', 'team_digest_recipients', 'claim_team_digest']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('send-team-digest: one person never stops the others', () => {
  it('a first answer of 500 and a second of 200 counts as sent', async () => {
    emailPlan = { 'ana@example.com': [500, 200] };
    await call({ day: '2026-10-07' });
    expect(sentTo()).toEqual(['ana@example.com', 'ana@example.com', 'mia@example.com']);
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 2, p_sent: 2, p_failed: 0, p_error: null });
  });

  it('a fetch that throws once and then succeeds counts as sent', async () => {
    emailPlan = { 'mia@example.com': ['throw'] };
    await call({ day: '2026-10-07' });
    expect(sentTo()).toEqual(['ana@example.com', 'mia@example.com', 'mia@example.com']);
    expect(finishArgs()).toMatchObject({ p_sent: 2, p_failed: 0, p_error: null });
  });

  it('two failures count as failed, and the next person is still sent', async () => {
    emailPlan = { 'ana@example.com': [500, 500] };
    await call({ day: '2026-10-07' });
    expect(sentTo()).toEqual(['ana@example.com', 'ana@example.com', 'mia@example.com']);
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 2, p_sent: 1, p_failed: 1, p_error: `${ADMIN}: send_failed` });
  });

  it('a render error for the second of three counts as failed and the third is still sent', async () => {
    db.recipients = [
      { user_id: ADMIN, role: 'admin', email: 'ana@example.com', full_name: 'Ana Admin' },
      { user_id: SUPER, role: 'super_admin', email: 'sam@example.com', full_name: 'Sam' },
      { user_id: MKT, role: 'marketing', email: 'mia@example.com', full_name: 'Mia' },
    ];
    render.throwFor = 'Sam';
    await call({ day: '2026-10-07' });
    expect(sentTo()).toEqual(['ana@example.com', 'mia@example.com']);
    expect(finishArgs()).toEqual({ p_day: '2026-10-07', p_recipients: 3, p_sent: 2, p_failed: 1, p_error: `${SUPER}: render boom` });
    expect(logText()).toContain('render boom');
    for (const a of ADDRESSES) expect(logText()).not.toContain(a);
  });

  it('never writes an address or an unsubscribe token to the logs or the run log', async () => {
    emailPlan = { 'ana@example.com': [500, 500], 'mia@example.com': ['throw', 'throw'] };
    await call({ day: '2026-10-07' });
    const token = linkIn(sentBodies()[0].template)![2];
    const text = logText() + JSON.stringify(finishArgs());
    for (const a of ADDRESSES) expect(text).not.toContain(a);
    expect(text).not.toContain(token);
    expect(finishArgs()).toMatchObject({ p_sent: 0, p_failed: 2 });
  });
});
