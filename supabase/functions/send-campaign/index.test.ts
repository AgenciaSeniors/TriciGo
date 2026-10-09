import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real send-campaign handler. supabase-js (esm.sh) is replaced with a fake client:
// sessions for auth.getUser, a role per user, campaigns by id, the ids claim_campaigns hands out,
// and the recipients campaign_recipient_ids returns. fetch is stubbed per Edge Function URL.

interface FakeCampaign {
  id: string; name: string; channel: string; message_title: string; message_body: string;
  promo_code_id: string | null; created_by: string | null; status: string;
}

const db = vi.hoisted(() => ({
  sessions: {} as Record<string, string>,
  roles: {} as Record<string, string>,
  campaigns: {} as Record<string, FakeCampaign>,
  claimable: [] as string[],
  recipients: [] as string[],
  recipientsError: null as null | { message: string },
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  updates: [] as Array<{ id: string; row: Record<string, unknown> }>,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => {
  function query(table: string) {
    const filters: Record<string, string> = {};
    let pendingUpdate: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, val: string) => {
      filters[col] = val;
      return q;
    };
    q.update = (row: Record<string, unknown>) => {
      pendingUpdate = row;
      return q;
    };
    q.single = () => {
      if (table === 'users') {
        const role = db.roles[filters.id];
        return Promise.resolve(role ? { data: { role }, error: null } : { data: null, error: { message: 'no rows' } });
      }
      const c = db.campaigns[filters.id];
      return Promise.resolve(c ? { data: c, error: null } : { data: null, error: { message: 'no rows' } });
    };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => {
      if (pendingUpdate && table === 'campaigns') {
        db.updates.push({ id: filters.id, row: pendingUpdate });
        const c = db.campaigns[filters.id];
        if (c && (!filters.status || c.status === filters.status)) Object.assign(c, pendingUpdate);
      }
      return Promise.resolve({ data: null, error: null }).then(ok, ko);
    };
    return q;
  }
  return {
    createClient: () => ({
      auth: {
        getUser: (token: string) =>
          Promise.resolve(
            db.sessions[token]
              ? { data: { user: { id: db.sessions[token] } }, error: null }
              : { data: { user: null }, error: { message: 'invalid JWT' } },
          ),
      },
      from: (table: string) => query(table),
      rpc: (fn: string, args: Record<string, unknown>) => {
        db.rpcCalls.push({ fn, args });
        if (fn === 'claim_campaigns') {
          const want = args.p_campaign_id as string | null;
          const ids = db.claimable.filter((id) => !want || id === want).slice(0, args.p_limit as number);
          db.claimable = db.claimable.filter((id) => !ids.includes(id));
          for (const id of ids) db.campaigns[id].status = 'sending';
          return Promise.resolve({ data: ids.map((id) => ({ ...db.campaigns[id] })), error: null });
        }
        if (fn === 'campaign_recipient_ids') {
          return Promise.resolve(db.recipientsError ? { data: null, error: db.recipientsError } : { data: db.recipients, error: null });
        }
        return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
      },
    }),
  };
});

const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
};

let handler: (req: Request) => Promise<Response>;
let pushResponse: Response | (() => Response);
let emailResponse: Response | (() => Response);
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  const pick = url.endsWith('/send-push') ? pushResponse : emailResponse;
  return typeof pick === 'function' ? pick() : pick.clone();
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

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const MKT1 = '00000000-0000-4000-8000-0000000000b1';
const MKT2 = '00000000-0000-4000-8000-0000000000b2';
const CUSTOMER = '00000000-0000-4000-8000-0000000000c1';
const CAMP = 'ca000000-0000-4000-8000-000000000001';
const CAMP2 = 'ca000000-0000-4000-8000-000000000002';

const campaign = (id: string, channel: string, created_by: string): FakeCampaign => ({
  id, name: id, channel, message_title: 'Viaja hoy', message_body: 'Hola <b>Ana</b>\nVen', promo_code_id: null,
  created_by, status: 'scheduled',
});

beforeEach(() => {
  fetchMock.mockClear();
  db.sessions = { 'jwt-admin': ADMIN, 'jwt-mkt1': MKT1, 'jwt-mkt2': MKT2, 'jwt-customer': CUSTOMER };
  db.roles = { [ADMIN]: 'admin', [MKT1]: 'marketing', [MKT2]: 'marketing', [CUSTOMER]: 'customer' };
  db.campaigns = { [CAMP]: campaign(CAMP, 'both', MKT1), [CAMP2]: campaign(CAMP2, 'push', MKT2) };
  db.claimable = [CAMP, CAMP2];
  db.recipients = ['u1', 'u2', 'u3'];
  db.recipientsError = null;
  db.rpcCalls = [];
  db.updates = [];
  pushResponse = new Response(JSON.stringify({ sent: 3, failed: 0 }), { status: 200 });
  emailResponse = new Response(JSON.stringify({ ok: true, sent: 2, failed: 0 }), { status: 200 });
});

const call = (body: unknown, opts: { token?: string; internal?: boolean } = {}) =>
  handler(
    new Request('https://example.supabase.co/functions/v1/send-campaign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.internal ? { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const lastUpdate = (id: string) => [...db.updates].reverse().find((u) => u.id === id)?.row;

describe('send-campaign: who may send', () => {
  it('401 without a session', async () => {
    expect((await call({ campaign_id: CAMP })).status).toBe(401);
    expect(db.rpcCalls).toEqual([]);
  });

  it('403 for a customer', async () => {
    expect((await call({ campaign_id: CAMP }, { token: 'jwt-customer' })).status).toBe(403);
    expect(db.rpcCalls).toEqual([]);
  });

  it("403 for marketing on another account's campaign, before any claim", async () => {
    expect((await call({ campaign_id: CAMP }, { token: 'jwt-mkt2' })).status).toBe(403);
    expect(db.rpcCalls).toEqual([]);
    expect(db.campaigns[CAMP].status).toBe('scheduled');
  });

  it('a due run needs the service key', async () => {
    expect((await call({ due: true }, { token: 'jwt-admin' })).status).toBe(403);
    expect(db.rpcCalls).toEqual([]);
  });

  it('400 without a campaign id', async () => {
    expect((await call({}, { token: 'jwt-admin' })).status).toBe(400);
  });
});

describe('send-campaign: sending', () => {
  it('marketing sends its own campaign: push with the campaign id, escaped e-mail, counts written', async () => {
    const res = await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: CAMP, status: 'sent', recipient_count: 3, push_sent: 3, email_sent: 2, sent_count: 3 });

    const [pushCall, emailCall] = fetchMock.mock.calls;
    expect(pushCall[0]).toBe('https://example.supabase.co/functions/v1/send-push');
    const pushInit = pushCall[1] as RequestInit;
    expect((pushInit.headers as Record<string, string>).apikey).toBe(SERVICE_KEY);
    expect(JSON.parse(pushInit.body as string)).toEqual({
      user_ids: ['u1', 'u2', 'u3'], title: 'Viaja hoy', body: 'Hola <b>Ana</b>\nVen', category: 'campaign',
      data: { deep_link: 'tricigo://home', content_type: 'campaign', content_id: CAMP },
    });
    expect(emailCall[0]).toBe('https://example.supabase.co/functions/v1/send-bulk-email');
    expect(JSON.parse((emailCall[1] as RequestInit).body as string)).toEqual({
      user_ids: ['u1', 'u2', 'u3'], subject: 'Viaja hoy',
      body_html: '<p>Hola &lt;b&gt;Ana&lt;/b&gt;<br/>Ven</p>', promo_code_id: null,
    });

    expect(lastUpdate(CAMP)).toMatchObject({
      status: 'sent', recipient_count: 3, push_sent: 3, email_sent: 2, sent_count: 3, last_error: null,
    });
    expect(db.campaigns[CAMP].status).toBe('sent');
  });

  it('an admin sends any campaign', async () => {
    expect((await call({ campaign_id: CAMP2 }, { token: 'jwt-admin' })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('409 when the campaign cannot be claimed (already sending, sent, cancelled or not due)', async () => {
    db.claimable = [];
    db.campaigns[CAMP].status = 'sending';
    const res = await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_claimable', status: 'sending' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nobody in the segment: no channel call, sent with zero', async () => {
    db.recipients = [];
    const res = await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastUpdate(CAMP)).toMatchObject({ status: 'sent', recipient_count: 0, sent_count: 0 });
  });

  it('push fails and e-mail works: sent, with the push error noted', async () => {
    pushResponse = new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(lastUpdate(CAMP)).toMatchObject({ status: 'sent', push_sent: 0, email_sent: 2, last_error: 'push: boom' });
  });

  it('every channel fails: failed', async () => {
    pushResponse = new Response('{}', { status: 502 });
    emailResponse = () => {
      throw new Error('network down');
    };
    const res = await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(res.status).toBe(200);
    expect(lastUpdate(CAMP)).toMatchObject({ status: 'failed', sent_count: 0 });
    expect(String(lastUpdate(CAMP)?.last_error)).toContain('email: network down');
  });

  it('the recipients cannot be read: failed, no channel call', async () => {
    db.recipientsError = { message: 'boom' };
    await call({ campaign_id: CAMP }, { token: 'jwt-mkt1' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastUpdate(CAMP)).toMatchObject({ status: 'failed', last_error: 'recipients: boom' });
  });
});

describe('send-campaign: due runs (cron)', () => {
  it('claims every due campaign, answers 202 and sends them', async () => {
    const res = await call({ due: true }, { internal: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ claimed: [CAMP, CAMP2] });
    expect(db.rpcCalls[0]).toEqual({ fn: 'claim_campaigns', args: { p_campaign_id: null, p_limit: 5 } });
    expect(db.campaigns[CAMP].status).toBe('sent');
    expect(db.campaigns[CAMP2].status).toBe('sent');
  });

  it('nothing due: 202 with nothing claimed', async () => {
    db.claimable = [];
    const res = await call({ due: true }, { internal: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ claimed: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
