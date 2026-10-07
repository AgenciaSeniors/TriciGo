import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real behavioral-emails handler (the daily welcome and win-back cron).
// supabase-js (esm.sh, which vitest cannot load) is replaced with a fake client over a
// small in-memory database, and fetch is stubbed so the calls to send-email are
// observed instead of sent.
//
// The case it pins down: anyone can sign up, type someone else's address into the
// profile and wait for this cron to mail it. Only addresses mailable_user_emails
// (migration 00635) calls proven may get a welcome or a win-back.

interface UserRow { id: string; email: string | null; full_name: string | null }

const db = vi.hoisted(() => ({
  users: [] as UserRow[],
  proven: {} as Record<string, string>,
  rpcError: null as { message: string } | null,
  rides: [] as Array<{ customer_id: string; completed_at: string; status: string }>,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  inserts: [] as Array<{ table: string; row: unknown }>,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => {
  function query(table: string) {
    const filters: Array<{ op: string; col: string; val: unknown }> = [];
    const q: Record<string, unknown> = {};
    for (const op of ['select', 'order', 'not']) q[op] = () => q;
    for (const op of ['eq', 'gte', 'lt', 'in']) {
      q[op] = (col: string, val: unknown) => {
        filters.push({ op, col, val });
        return q;
      };
    }
    q.insert = (row: unknown) => {
      db.inserts.push({ table, row });
      return Promise.resolve({ error: null });
    };
    const rows = (): unknown[] => {
      if (table === 'email_sends') return [];
      if (table === 'users') {
        const ids = filters.find((f) => f.op === 'in')?.val as string[] | undefined;
        return ids ? db.users.filter((u) => ids.includes(u.id)) : db.users;
      }
      if (table === 'rides') {
        const recent = filters.some((f) => f.op === 'gte');
        const cutoff = Date.now() - 7 * 86400000;
        return db.rides.filter((r) => (new Date(r.completed_at).getTime() >= cutoff) === recent);
      }
      return [];
    };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(ok, ko);
    return q;
  }
  return {
    createClient: () => ({
      from: (table: string) => query(table),
      rpc: (fn: string, args: { p_user_ids: string[] }) => {
        db.rpcCalls.push({ fn, args });
        if (db.rpcError) return Promise.resolve({ data: null, error: db.rpcError });
        const data = args.p_user_ids.filter((id) => id in db.proven).map((id) => ({ user_id: id, email: db.proven[id] }));
        return Promise.resolve({ data, error: null });
      },
    }),
  };
});

// Fake key material: same shape as a real secret key, not a credential.
const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
};

let handler: (req: Request) => Promise<Response>;
const sent: Array<{ template: string; recipient_email: string }> = [];

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => env[k] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    sent.push({ template: body.template, recipient_email: body.recipient_email });
    return new Response('{}', { status: 200 });
  }));
  await import('./index.ts');
});

const VICTIM = '00000000-0000-4000-8000-000000000001';  // typed someone else's address
const PROVEN = '00000000-0000-4000-8000-000000000002';  // confirmed (or Google/Apple-proven)
const PHONE = '00000000-0000-4000-8000-000000000003';   // phone-OTP placeholder only

beforeEach(() => {
  sent.length = 0;
  db.rpcCalls.length = 0;
  db.inserts.length = 0;
  db.rpcError = null;
  db.users = [
    { id: VICTIM, email: 'victim@x.test', full_name: 'Visita la web de spam' },
    { id: PROVEN, email: 'proven@x.test', full_name: 'Flor' },
    { id: PHONE, email: 'phone_5355555555@tricigo.app', full_name: 'Pepe' },
  ];
  db.proven = { [PROVEN]: 'proven@x.test' };
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  db.rides = [VICTIM, PROVEN, PHONE].map((id) => ({ customer_id: id, completed_at: old, status: 'completed' }));
});

const run = () => handler(new Request('https://example.supabase.co/functions/v1/behavioral-emails', {
  method: 'POST',
  headers: { apikey: SERVICE_KEY },
}));

describe('behavioral-emails', () => {
  it('sends the welcome and the win-back only to a proven address', async () => {
    const res = await run();
    expect(res.status).toBe(200);
    expect(sent).toEqual([
      { template: 'welcome', recipient_email: 'proven@x.test' },
      { template: 'win_back', recipient_email: 'proven@x.test' },
    ]);
    expect((await res.json()).results).toEqual({ welcome_sent: 1, win_back_sent: 1 });
  });

  it('asks mailable_user_emails about the candidates, not the addresses they typed', async () => {
    await run();
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['mailable_user_emails', 'mailable_user_emails']);
    for (const c of db.rpcCalls) {
      expect((c.args as { p_user_ids: string[] }).p_user_ids.sort()).toEqual([VICTIM, PROVEN, PHONE].sort());
    }
  });

  it('records only the sends that went out', async () => {
    await run();
    expect(db.inserts).toEqual([
      { table: 'email_sends', row: { user_id: PROVEN, template: 'welcome' } },
      { table: 'email_sends', row: { user_id: PROVEN, template: 'win_back' } },
    ]);
  });

  it('fails closed: with the check unavailable (00635 not applied) nobody is mailed', async () => {
    db.rpcError = { message: 'Could not find the function public.mailable_user_emails' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await run();
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(sent).toEqual([]);
  });
});
