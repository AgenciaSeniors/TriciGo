import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real delete-account handler. Replaced: supabase-js (esm.sh) with a fake
// whose RPC answers each test sets, and which records whether GoTrue was asked to
// delete the user.
const db = vi.hoisted(() => ({
  answers: {} as Record<string, { data: unknown; error: unknown }>,
  rpcs: [] as string[],
  deleted: [] as string[],
}));
vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }),
      admin: {
        deleteUser: async (id: string) => {
          db.deleted.push(id);
          return { error: null };
        },
      },
    },
    rpc: async (fn: string) => {
      db.rpcs.push(fn);
      return db.answers[fn] ?? { data: null, error: { message: `unexpected ${fn}` } };
    },
    storage: {
      from: () => ({
        remove: async () => ({ data: [], error: null }),
        list: async () => ({ data: [], error: null }),
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
});

const del = () =>
  handler(
    new Request('https://example.supabase.co/functions/v1/delete-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user.jwt.token' },
      body: '{}',
    }),
  );

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
