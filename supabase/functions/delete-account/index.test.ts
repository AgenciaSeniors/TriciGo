import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real delete-account handler. Replaced: supabase-js (esm.sh) with a fake
// whose RPC answers each test sets, which records whether GoTrue was asked to
// delete the user, and whose Storage keeps objects in memory and lists them the
// way the Storage API does (one level at a time, folders with id null, paged by
// limit/offset; checked against the live bucket on 2026-10-14).
const db = vi.hoisted(() => ({
  answers: {} as Record<string, { data: unknown; error: unknown }>,
  rpcs: [] as string[],
  deleted: [] as string[],
  calls: [] as string[],
  driverProfiles: {} as Record<string, string>,
  driverProfileError: null as unknown,
  objects: {} as Record<string, Set<string>>,
  failList: {} as Record<string, { message: string } | 'throw' | 'hang'>,
  failRemove: {} as Record<string, { message: string } | 'throw'>,
}));

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }),
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
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return q;
        },
        maybeSingle: async () => {
          db.calls.push(`select ${table}`);
          if (table !== 'driver_profiles') return { data: null, error: { message: `unexpected ${table}` } };
          if (db.driverProfileError) return { data: null, error: db.driverProfileError };
          const id = db.driverProfiles[String(filters.user_id)];
          return { data: id ? { id } : null, error: null };
        },
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
          if (fail === 'hang') return new Promise<never>(() => {});
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
          const fail = db.failRemove[bucket];
          if (fail === 'throw') throw new Error('socket hang up');
          if (fail) return { data: null, error: fail };
          // The Storage API takes 1 to 1000 names per call.
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
  db.answers = {};
  db.rpcs = [];
  db.deleted = [];
  db.calls = [];
  db.driverProfiles = {};
  db.driverProfileError = null;
  db.objects = {};
  db.failList = {};
  db.failRemove = {};
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const del = () =>
  handler(
    new Request('https://example.supabase.co/functions/v1/delete-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user.jwt.token' },
      body: '{}',
    }),
  );

const seed = (bucket: string, keys: string[]) => {
  db.objects[bucket] = new Set([...(db.objects[bucket] ?? []), ...keys]);
};
const objectsIn = (bucket: string) => [...(db.objects[bucket] ?? [])].sort();

// driver_profiles.id of u-1, and of somebody else.
const DP = '7a1c2f30-1111-4222-8333-444455556666';
const OTHER_DP = '9b2d3e41-5555-4666-8777-888899990000';

describe('delete-account', () => {
  it('deletes the auth user after the database step succeeds', async () => {
    db.answers.prepare_account_deletion = {
      data: { settled: { settled_cup: 0 }, anonymized: { rides_customer: 2 } },
      error: null,
    };
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      anonymized: { rides_customer: 2 },
      settled: { settled_cup: 0 },
    });
    expect(db.rpcs).toEqual(['prepare_account_deletion']);
    expect(db.deleted).toEqual(['u-1']);
  });

  it('refuses with the Spanish text and leaves the account alone', async () => {
    db.answers.prepare_account_deletion = {
      data: null,
      error: {
        code: 'P0001',
        message: 'Tienes un viaje en curso o programado. Termínalo o cancélalo antes de eliminar tu cuenta.',
        details: 'deletion_active_ride',
      },
    };
    const res = await del();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'deletion_active_ride',
      message: 'Tienes un viaje en curso o programado. Termínalo o cancélalo antes de eliminar tu cuenta.',
    });
    expect(db.deleted).toEqual([]);
  });

  it('does not ask GoTrue to delete when a reference could not be moved', async () => {
    db.answers.prepare_account_deletion = {
      data: null,
      error: {
        code: 'P0001',
        message: 'No pudimos eliminar tu cuenta. Escríbenos a soporte.',
        details: 'deletion_incomplete',
        hint: 'referrals_referee',
      },
    };
    const res = await del();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: 'deletion_incomplete',
      message: 'No pudimos eliminar tu cuenta. Escríbenos a soporte.',
    });
    // The failed column names stay in the logs.
    expect(JSON.stringify(body)).not.toContain('referrals');
    expect(db.deleted).toEqual([]);
  });

  it('keeps internal errors out of the response', async () => {
    db.answers.prepare_account_deletion = {
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    };
    const res = await del();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'deletion_failed' });
    expect(db.deleted).toEqual([]);
  });

  it('still works before 00657 is applied', async () => {
    db.answers.prepare_account_deletion = {
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function public.prepare_account_deletion' },
    };
    db.answers.settle_and_scrub_for_deletion = { data: {}, error: null };
    db.answers.anonymize_user_references = { data: {}, error: null };
    const res = await del();
    expect(res.status).toBe(200);
    expect(db.rpcs).toEqual([
      'prepare_account_deletion',
      'settle_and_scrub_for_deletion',
      'anonymize_user_references',
    ]);
    expect(db.deleted).toEqual(['u-1']);
  });
});

// The driver's documents live under driver-docs/{driver_profiles.id}/ and
// selfie-checks/{driver_profiles.id}/ (driver.service.uploadDocument and
// uploadSelfieCheck), never under the user id. Until 2026-10 the cleanup listed
// {user_id}/ and removed nothing: 135 files of 22 deleted drivers stayed behind.
describe('delete-account: the driver documents', () => {
  beforeEach(() => {
    db.answers.prepare_account_deletion = { data: { settled: {}, anonymized: {} }, error: null };
  });

  it("removes the driver's documents and selfie checks, and nobody else's files", async () => {
    db.driverProfiles = { 'u-1': DP };
    seed('driver-documents', [
      `driver-docs/${DP}/national_id/1760000000000-carnet.jpg`,
      `driver-docs/${DP}/national_id/1760000000001-carnet.jpg`,
      `driver-docs/${DP}/selfie/selfie_1760000000002.jpg`,
      `selfie-checks/${DP}/0c1d2e3f-0000-4000-8000-000000000001/selfie.jpg`,
      `driver-docs/${OTHER_DP}/national_id/1760000000003-carnet.jpg`,
      'fleet-docs/corp-1/member-1/1760000000004-license.pdf',
    ]);
    seed('avatars', ['u-1/avatar.jpg', 'u-2/avatar.jpg']);

    const res = await del();

    expect(res.status).toBe(200);
    expect(objectsIn('driver-documents')).toEqual([
      `driver-docs/${OTHER_DP}/national_id/1760000000003-carnet.jpg`,
      'fleet-docs/corp-1/member-1/1760000000004-license.pdf',
    ]);
    expect(objectsIn('avatars')).toEqual(['u-2/avatar.jpg']);
    expect(db.deleted).toEqual(['u-1']);
  });

  it('pages through a folder with more files than one listing returns', async () => {
    db.driverProfiles = { 'u-1': DP };
    // Since #1156 every re-upload is a new object, so a folder can pass 100.
    seed(
      'driver-documents',
      Array.from({ length: 250 }, (_, i) => `driver-docs/${DP}/vehicle_photo/${1760000000000 + i}-car.jpg`),
    );

    const res = await del();

    expect(res.status).toBe(200);
    expect(objectsIn('driver-documents')).toEqual([]);
  });

  it('reads the driver profile before the database step and clears the files before GoTrue', async () => {
    db.driverProfiles = { 'u-1': DP };
    seed('driver-documents', [`driver-docs/${DP}/national_id/1760000000000-carnet.jpg`]);

    await del();

    const at = (prefix: string) => db.calls.findIndex((c) => c.startsWith(prefix));
    expect(at('select driver_profiles')).toBeGreaterThanOrEqual(0);
    expect(at('select driver_profiles')).toBeLessThan(at('rpc prepare_account_deletion'));
    expect(at('storage driver-documents remove')).toBeGreaterThan(at('rpc prepare_account_deletion'));
    expect(at('storage driver-documents remove')).toBeLessThan(at('auth deleteUser'));
  });

  it('keeps the files when the database step refuses', async () => {
    db.driverProfiles = { 'u-1': DP };
    seed('driver-documents', [`driver-docs/${DP}/national_id/1760000000000-carnet.jpg`]);
    db.answers.prepare_account_deletion = {
      data: null,
      error: { code: 'P0001', message: 'Tienes una deuda de 300 CUP con TriciGo.', details: 'deletion_debt' },
    };

    const res = await del();

    expect(res.status).toBe(409);
    expect(objectsIn('driver-documents')).toEqual([`driver-docs/${DP}/national_id/1760000000000-carnet.jpg`]);
    expect(db.calls.filter((c) => c.startsWith('storage'))).toEqual([]);
    expect(db.deleted).toEqual([]);
  });

  it('does not touch the bucket for an account that never was a driver', async () => {
    seed('driver-documents', [`driver-docs/${OTHER_DP}/national_id/1760000000000-carnet.jpg`]);

    const res = await del();

    expect(res.status).toBe(200);
    expect(db.calls.filter((c) => c.startsWith('storage driver-documents'))).toEqual([]);
    expect(objectsIn('driver-documents')).toEqual([`driver-docs/${OTHER_DP}/national_id/1760000000000-carnet.jpg`]);
  });

  it('changes nothing when it cannot read the driver profile', async () => {
    db.driverProfileError = { message: 'connection reset by peer' };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await del();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'deletion_failed' });
    expect(db.rpcs).toEqual([]);
    expect(db.deleted).toEqual([]);
  });

  it.each([
    ['answers with an error', { message: 'storage unavailable' } as const, 'storage unavailable'],
    ['throws', 'throw' as const, 'socket hang up'],
  ])('still deletes the account when listing %s, and logs it', async (_case, failure, logged) => {
    db.driverProfiles = { 'u-1': DP };
    seed('driver-documents', [`driver-docs/${DP}/national_id/1760000000000-carnet.jpg`]);
    db.failList['driver-documents'] = failure;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await del();

    expect(res.status).toBe(200);
    expect(db.deleted).toEqual(['u-1']);
    const log = errors.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(log).toContain(DP);
    expect(log).toContain(logged);
  });

  it('still deletes the account when Storage stops answering, and logs it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    db.driverProfiles = { 'u-1': DP };
    seed('driver-documents', [`driver-docs/${DP}/national_id/1760000000000-carnet.jpg`]);
    db.failList['driver-documents'] = 'hang';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pending = del();
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(db.deleted).toEqual(['u-1']);
    const log = errors.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(log).toContain(DP);
    expect(log).toContain('time budget');
  });

  it('still deletes the account when removing fails, and logs it', async () => {
    db.driverProfiles = { 'u-1': DP };
    seed('driver-documents', [`driver-docs/${DP}/national_id/1760000000000-carnet.jpg`]);
    db.failRemove['driver-documents'] = { message: 'storage unavailable' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await del();

    expect(res.status).toBe(200);
    expect(db.deleted).toEqual(['u-1']);
    const log = errors.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(log).toContain(DP);
    expect(log).toContain('storage unavailable');
  });
});
