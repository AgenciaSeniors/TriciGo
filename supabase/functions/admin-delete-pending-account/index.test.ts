import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real admin-delete-pending-account handler. Replaced: supabase-js (esm.sh)
// with a fake that answers the handler's table reads, records the RPCs and the
// GoTrue delete, and keeps Storage in memory, listed the way the Storage API lists
// (one level at a time, folders with id null, paged by limit/offset).
const db = vi.hoisted(() => ({
  answers: {} as Record<string, { data: unknown; error: unknown }>,
  rpcs: [] as string[],
  deleted: [] as string[],
  calls: [] as string[],
  driverProfiles: {} as Record<string, { id: string; status: string }>,
  objects: {} as Record<string, Set<string>>,
  failList: {} as Record<string, { message: string } | 'throw'>,
}));

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const TARGET = '00000000-0000-4000-8000-0000000000b2';

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }),
      admin: {
        deleteUser: async (id: string) => {
          db.calls.push('auth deleteUser');
          db.deleted.push(id);
          // auth.users → users → driver_profiles is ON DELETE CASCADE.
          delete db.driverProfiles[id];
          return { error: null };
        },
      },
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const many = () => {
        if (table === 'wallet_accounts') return { data: [], error: null };
        if (table === 'rides') return { data: null, count: 0, error: null };
        if (table === 'admin_actions') return { data: null, error: null };
        return { data: null, error: { message: `unexpected ${table}` } };
      };
      const q = {
        select: () => q,
        insert: () => q,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return q;
        },
        neq: () => q,
        maybeSingle: async () => {
          db.calls.push(`select ${table}`);
          if (table === 'users' && filters.id === ADMIN) return { data: { role: 'admin' }, error: null };
          if (table === 'users' && filters.id === TARGET) {
            return {
              data: {
                id: TARGET,
                full_name: 'Conductor Pendiente',
                phone: '+5355550199',
                email: null,
                role: 'driver',
                is_active: true,
                total_rides: 0,
                created_at: '2026-10-01T00:00:00Z',
              },
              error: null,
            };
          }
          if (table === 'driver_profiles') {
            return { data: db.driverProfiles[String(filters.user_id)] ?? null, error: null };
          }
          return { data: null, error: { message: `unexpected ${table}` } };
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(many()).then(resolve, reject),
      };
      return q;
    },
    rpc: async (fn: string) => {
      db.calls.push(`rpc ${fn}`);
      db.rpcs.push(fn);
      return db.answers[fn] ?? { data: null, error: { message: `unexpected ${fn}` } };
    },
    storage: {
      from: (bucket: string) => ({
        list: async (path: string, options?: { limit?: number; offset?: number }) => {
          db.calls.push(`storage ${bucket} list ${path}`);
          const fail = db.failList[bucket];
          if (fail === 'throw') throw new Error('socket hang up');
          if (fail) return { data: null, error: fail };
          const prefix = path.endsWith('/') ? path : `${path}/`;
          const entries = new Map<string, boolean>();
          for (const key of db.objects[bucket] ?? []) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const name = rest.split('/')[0];
            if (!entries.has(name)) entries.set(name, !rest.includes('/'));
          }
          const page = [...entries.keys()]
            .sort()
            .map((name) => ({ name, id: entries.get(name) ? `obj-${name}` : null }));
          const offset = options?.offset ?? 0;
          return { data: page.slice(offset, offset + (options?.limit ?? 100)), error: null };
        },
        remove: async (paths: string[]) => {
          db.calls.push(`storage ${bucket} remove ${paths.length}`);
          if (paths.length < 1 || paths.length > 1000) {
            return { data: null, error: { message: 'prefixes must have 1 to 1000 items' } };
          }
          const removed = paths.filter((p) => db.objects[bucket]?.delete(p));
          return { data: removed.map((name) => ({ name })), error: null };
        },
      }),
    },
  }),
}));

const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_test',
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
  db.answers = { prepare_account_deletion: { data: { settled: {}, anonymized: {} }, error: null } };
  db.rpcs = [];
  db.deleted = [];
  db.calls = [];
  db.driverProfiles = {};
  db.objects = {};
  db.failList = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

const call = (body: Record<string, unknown>) =>
  handler(
    new Request('https://example.supabase.co/functions/v1/admin-delete-pending-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin.jwt.token' },
      body: JSON.stringify(body),
    }),
  );

const seed = (bucket: string, keys: string[]) => {
  db.objects[bucket] = new Set([...(db.objects[bucket] ?? []), ...keys]);
};
const objectsIn = (bucket: string) => [...(db.objects[bucket] ?? [])].sort();

// driver_profiles.id of the pending driver, and of somebody else.
const DP = '7a1c2f30-1111-4222-8333-444455556666';
const OTHER_DP = '9b2d3e41-5555-4666-8777-888899990000';

describe('admin-delete-pending-account: the driver documents', () => {
  beforeEach(() => {
    db.driverProfiles = { [TARGET]: { id: DP, status: 'pending_verification' } };
    seed('driver-documents', [
      `driver-docs/${DP}/national_id/1760000000000-carnet.jpg`,
      `driver-docs/${DP}/drivers_license/1760000000001-licencia.jpg`,
      `selfie-checks/${DP}/0c1d2e3f-0000-4000-8000-000000000001/selfie.jpg`,
      `driver-docs/${OTHER_DP}/national_id/1760000000002-carnet.jpg`,
    ]);
  });

  it("removes the pending driver's documents and selfie checks, and nobody else's files", async () => {
    const res = await call({ user_id: TARGET, confirm: true });

    expect(res.status).toBe(200);
    expect(objectsIn('driver-documents')).toEqual([`driver-docs/${OTHER_DP}/national_id/1760000000002-carnet.jpg`]);
    expect(db.deleted).toEqual([TARGET]);
    const at = (prefix: string) => db.calls.findIndex((c) => c.startsWith(prefix));
    expect(at('storage driver-documents remove')).toBeGreaterThan(at('rpc prepare_account_deletion'));
    expect(at('storage driver-documents remove')).toBeLessThan(at('auth deleteUser'));
  });

  it('keeps the files on a dry run', async () => {
    const res = await call({ user_id: TARGET });

    expect(res.status).toBe(200);
    expect((await res.json()).deletable).toBe(true);
    expect(objectsIn('driver-documents')).toHaveLength(4);
    expect(db.rpcs).toEqual([]);
    expect(db.deleted).toEqual([]);
  });

  it('keeps the files when the database step refuses', async () => {
    db.answers.prepare_account_deletion = {
      data: null,
      error: {
        code: 'P0001',
        message: 'Tienes un pago en proceso. Espera unos minutos e inténtalo de nuevo.',
        details: 'deletion_payment_pending',
      },
    };

    const res = await call({ user_id: TARGET, confirm: true });

    expect(res.status).toBe(409);
    expect(objectsIn('driver-documents')).toHaveLength(4);
    expect(db.calls.filter((c) => c.startsWith('storage'))).toEqual([]);
    expect(db.deleted).toEqual([]);
  });

  it('still deletes the account when Storage fails, and logs it', async () => {
    db.failList['driver-documents'] = { message: 'storage unavailable' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await call({ user_id: TARGET, confirm: true });

    expect(res.status).toBe(200);
    expect(db.deleted).toEqual([TARGET]);
    const log = errors.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(log).toContain(DP);
    expect(log).toContain('storage unavailable');
  });
});
