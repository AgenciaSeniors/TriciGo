import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real send-push handler to check who may send which push (00641, marketing role).
// supabase-js (esm.sh) is replaced with a fake client: a session table for auth.getUser, a role
// per user, and empty answers for everything else (no device tokens, so nothing reaches Expo).
// The rate limiter is replaced too: it is DB-backed and imports supabase-js itself.

const db = vi.hoisted(() => ({
  sessions: {} as Record<string, string>,
  roles: {} as Record<string, string>,
  inserts: [] as Array<{ table: string; rows: unknown }>,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => {
  function query(table: string) {
    let id: string | null = null;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.in = () => q;
    q.not = () => q;
    q.eq = (col: string, val: string) => {
      if (col === 'id') id = val;
      return q;
    };
    q.single = () =>
      Promise.resolve(
        table === 'users' && id && db.roles[id]
          ? { data: { role: db.roles[id] }, error: null }
          : { data: null, error: { message: 'no rows' } },
      );
    q.insert = (rows: unknown) => {
      db.inserts.push({ table, rows });
      return Promise.resolve({ data: null, error: null });
    };
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(ok, ko);
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
    }),
  };
});

vi.mock('../_shared/rate-limiter.ts', () => ({
  rateLimit: vi.fn(async () => ({ allowed: true, remaining: 29, retryAfterMs: 0 })),
  rateLimitResponse: vi.fn(() => new Response('{}', { status: 429 })),
}));

// Fake key material: same shape as a real secret key, not a credential.
const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
};

let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => env[k] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { status: 200 })));
  await import('./index.ts');
});

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const MARKETING = '00000000-0000-4000-8000-0000000000b1';
const CUSTOMER = '00000000-0000-4000-8000-0000000000c1';
const TARGET = '00000000-0000-4000-8000-0000000000d1';

beforeEach(() => {
  db.inserts.length = 0;
  db.sessions = { 'jwt-admin': ADMIN, 'jwt-marketing': MARKETING, 'jwt-customer': CUSTOMER };
  db.roles = { [ADMIN]: 'admin', [MARKETING]: 'marketing', [CUSTOMER]: 'customer' };
});

const push = (token: string, category?: string) =>
  handler(
    new Request('https://example.supabase.co/functions/v1/send-push', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_ids: [TARGET], title: 'Hola', body: 'Cuerpo', ...(category ? { category } : {}) }),
    }),
  );

describe('send-push: who may send which push', () => {
  it.each(['campaign', 'announcement', 'promo', 'blog'])('marketing may send a %s push', async (category) => {
    const res = await push('jwt-marketing', category);
    expect(res.status).toBe(200);
    expect(db.inserts.map((i) => i.table)).toEqual(['notifications']);
  });

  it.each(['ride_offer', 'system', 'sos', 'payment'])('marketing may not send a %s push', async (category) => {
    const res = await push('jwt-marketing', category);
    expect(res.status).toBe(403);
    expect(db.inserts).toEqual([]);
  });

  // Uncategorized pushes are sendToUser's system notices (driver approval, documents). The
  // Notificaciones page's one-user push is an 'announcement', which the server allows (see the
  // tests above, which also target one user); the panel keeps that page admin-only.
  it("marketing may not send an uncategorized push (sendToUser's system notices)", async () => {
    const res = await push('jwt-marketing');
    expect(res.status).toBe(403);
    expect(db.inserts).toEqual([]);
  });

  it('an admin still sends any category', async () => {
    expect((await push('jwt-admin', 'system')).status).toBe(200);
    expect((await push('jwt-admin')).status).toBe(200);
  });

  it('a customer is still refused', async () => {
    expect((await push('jwt-customer', 'campaign')).status).toBe(403);
    expect(db.inserts).toEqual([]);
  });
});

// Internal calls (service key: database triggers, crons) carry no JWT and have no role.
// The category gate must never apply to them: ride offers depend on it.
const internalPush = (category?: string) =>
  handler(
    new Request('https://example.supabase.co/functions/v1/send-push', {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_ids: [TARGET], title: 'Hola', body: 'Cuerpo', ...(category ? { category } : {}) }),
    }),
  );

describe('send-push: internal calls', () => {
  it('a service-key call still sends a ride offer and saves it to the inbox', async () => {
    const res = await internalPush('ride_offer');
    expect(res.status).toBe(200);
    expect(db.inserts).toEqual([
      {
        table: 'notifications',
        rows: [{ user_id: TARGET, type: 'ride_offer', title: 'Hola', body: 'Cuerpo', data: { type: 'ride_offer' } }],
      },
    ]);
  });

  it('a service-key call still sends an uncategorized push, saved as system', async () => {
    const res = await internalPush();
    expect(res.status).toBe(200);
    expect(db.inserts).toEqual([
      { table: 'notifications', rows: [{ user_id: TARGET, type: 'system', title: 'Hola', body: 'Cuerpo', data: null }] },
    ]);
  });
});
