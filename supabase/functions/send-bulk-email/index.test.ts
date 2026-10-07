import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real send-bulk-email handler (admin campaigns). supabase-js (esm.sh) is
// replaced with a fake client over an in-memory users table, and fetch is stubbed so
// the calls to Resend are observed instead of sent.
//
// A campaign goes to users who opted in to marketing (00618), but opting in an address
// says nothing about owning it: anyone could opt in someone else's inbox. Only the
// addresses mailable_user_emails (00635) calls proven may get one.

interface UserRow { id: string; email: string | null; full_name: string | null; marketing_opt_in: boolean }

const db = vi.hoisted(() => ({
  users: [] as UserRow[],
  proven: {} as Record<string, string>,
  rpcError: null as { message: string } | null,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => {
  function query(table: string) {
    let ids: string[] | null = null;
    let optIn: boolean | null = null;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.not = () => q;
    q.in = (_col: string, val: string[]) => { ids = val; return q; };
    q.eq = (col: string, val: unknown) => { if (col === 'marketing_opt_in') optIn = val as boolean; return q; };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => {
      const rows = table !== 'users' ? [] : db.users.filter((u) =>
        (!ids || ids.includes(u.id)) && u.email !== null && (optIn === null || u.marketing_opt_in === optIn));
      return Promise.resolve({ data: rows, error: null }).then(ok, ko);
    };
    return q;
  }
  return {
    createClient: () => ({
      from: (table: string) => query(table),
      rpc: (fn: string, args: { p_user_ids: string[] }) => {
        if (fn !== 'mailable_user_emails') return Promise.resolve({ data: null, error: { message: `unknown ${fn}` } });
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
  RESEND_API_KEY: 're_test',
};

let handler: (req: Request) => Promise<Response>;
const sent: Array<{ to: string; html: string }> = [];

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => env[k] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    sent.push({ to: body.to, html: body.html });
    return new Response('{}', { status: 200 });
  }));
  await import('./index.ts');
});

const VICTIM = '00000000-0000-4000-8000-000000000001';   // opted in an address it typed
const PROVEN = '00000000-0000-4000-8000-000000000002';   // opted in, proven address
const NO_OPT = '00000000-0000-4000-8000-000000000003';   // proven, but no consent

beforeEach(() => {
  sent.length = 0;
  db.rpcError = null;
  db.users = [
    { id: VICTIM, email: 'victim@x.test', full_name: 'Visita la web de spam', marketing_opt_in: true },
    { id: PROVEN, email: ' Proven@x.test ', full_name: 'Flor', marketing_opt_in: true },
    { id: NO_OPT, email: 'noopt@x.test', full_name: 'Nora', marketing_opt_in: false },
  ];
  db.proven = { [PROVEN]: 'Proven@x.test', [NO_OPT]: 'noopt@x.test' };
});

const campaign = () => handler(new Request('https://example.supabase.co/functions/v1/send-bulk-email', {
  method: 'POST',
  headers: { apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ user_ids: [VICTIM, PROVEN, NO_OPT], subject: 'Promo', body_html: '<p>Hola</p>' }),
}));

describe('send-bulk-email', () => {
  it('mails only users who opted in AND whose address is proven, at the proven address', async () => {
    const res = await campaign();
    expect(res.status).toBe(200);
    expect(sent.map((s) => s.to)).toEqual(['Proven@x.test']);
    expect(await res.json()).toEqual({ ok: true, sent: 1, failed: 0, total_targets: 1 });
  });

  it('fails closed: with the check unavailable (00635 not applied) the campaign mails nobody', async () => {
    db.rpcError = { message: 'Could not find the function public.mailable_user_emails' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await campaign();
    err.mockRestore();
    expect(sent).toEqual([]);
    expect((await res.json()).total_targets).toBe(0);
  });
});
