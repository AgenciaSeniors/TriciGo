import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real register-login-device handler. Three things are replaced:
//  - supabase-js (imported from esm.sh, which vitest cannot load): a fake client over
//    a small in-memory state, with the caller's JWT always valid;
//  - the rate limiter (DB-backed, and it imports supabase-js too): the test decides
//    whether the user's alert budget is spent;
//  - fetch, so the call to send-email is observed instead of sent.
//
// The new-device alert goes only to an address mailable_user_emails (00635) calls
// proven. Before, it went only to users.email_verified_at, which no account in prod
// has, so the alert reached nobody, not even the accounts whose Google or Apple
// identity proves the address.

const USER = '00000000-0000-4000-8000-0000000000a1';

const limiter = vi.hoisted(() => ({ rateLimit: vi.fn() }));
vi.mock('../_shared/rate-limiter.ts', () => limiter);

const db = vi.hoisted(() => ({
  // What the account typed into its profile. Only the RPC decides if it is mailable.
  users: { email: 'typed@x.test', email_verified_at: null as string | null },
  proven: {} as Record<string, string>,
  rpcError: null as { message: string } | null,
  priorDevices: 1,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => {
  function query(table: string) {
    let counting = false;
    const q: Record<string, unknown> = {};
    q.select = (_cols: string, opts?: { count?: string }) => {
      counting = !!opts?.count;
      return q;
    };
    q.eq = () => q;
    q.update = () => q;
    q.insert = () => Promise.resolve({ error: null });
    q.maybeSingle = async () =>
      table === 'users' ? { data: db.users, error: null } : { data: null, error: null };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve(counting ? { count: db.priorDevices, error: null } : { data: null, error: null }).then(ok, ko);
    return q;
  }
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
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
  SUPABASE_ANON_KEY: 'sb_publishable_TESTtestTESTtest01',
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

beforeEach(() => {
  sent.length = 0;
  db.rpcCalls.length = 0;
  db.users = { email: 'typed@x.test', email_verified_at: null };
  db.proven = {};
  db.rpcError = null;
  db.priorDevices = 1;
  limiter.rateLimit.mockReset();
  limiter.rateLimit.mockResolvedValue({ allowed: true, remaining: 2, retryAfterMs: 0 });
});

const login = () => handler(new Request('https://example.supabase.co/functions/v1/register-login-device', {
  method: 'POST',
  headers: { Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json' },
  body: JSON.stringify({ device_id: 'new-install-uuid', platform: 'android', model: 'Pixel 9' }),
}));

describe('register-login-device', () => {
  it('does not alert an address the account typed but never proved', async () => {
    const res = await login();
    expect(await res.json()).toEqual({ ok: true, is_new: true, emailed: false });
    expect(sent).toEqual([]);
    expect(limiter.rateLimit).not.toHaveBeenCalled();
  });

  it('alerts the proven address once', async () => {
    // A Google/Apple-proven address: email_verified_at is still null, as in prod.
    db.users = { email: ' Flor@X.test ', email_verified_at: null };
    db.proven = { [USER]: 'Flor@X.test' };
    const res = await login();
    expect(await res.json()).toEqual({ ok: true, is_new: true, emailed: true });
    expect(sent).toEqual([{ template: 'new_device_login', recipient_email: 'Flor@X.test' }]);
    expect(db.rpcCalls).toEqual([{ fn: 'mailable_user_emails', args: { p_user_ids: [USER] } }]);
  });

  it('keeps the per-user budget of 3 alerts a day', async () => {
    db.proven = { [USER]: 'flor@x.test' };
    limiter.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await login();
    expect(limiter.rateLimit).toHaveBeenCalledWith(`new-device-email:${USER}`, 3, 24 * 60 * 60 * 1000);
    expect(await res.json()).toEqual({ ok: true, is_new: true, emailed: false });
    expect(sent).toEqual([]);
  });

  it('mails nobody when the check cannot be made', async () => {
    // Even an address users.email_verified_at marks confirmed: the rule lives in one place.
    db.users = { email: 'flor@x.test', email_verified_at: '2026-10-01T00:00:00Z' };
    db.rpcError = { message: 'function mailable_user_emails does not exist' };
    const res = await login();
    expect(await res.json()).toEqual({ ok: true, is_new: true, emailed: false });
    expect(sent).toEqual([]);
  });

  it('records the first device of an account silently', async () => {
    db.proven = { [USER]: 'flor@x.test' };
    db.priorDevices = 0;
    const res = await login();
    expect(await res.json()).toEqual({ ok: true, is_new: true, emailed: false });
    expect(sent).toEqual([]);
  });
});
