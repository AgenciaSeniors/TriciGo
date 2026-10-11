import { describe, expect, it } from 'vitest';
import { failedAnonymizations, prepareAccountDeletion, type RpcClient, type RpcError } from './account-deletion';

type Answer = { data: unknown; error: RpcError | null };

function client(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const admin: RpcClient = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push(`${fn}(${String(args.p_user_id)})`);
      return answers[fn] ?? { data: null, error: { message: `unexpected ${fn}` } };
    },
  };
  return { admin, calls };
}

const USER = '11111111-1111-1111-1111-111111111111';

describe('prepareAccountDeletion', () => {
  it('runs the single atomic RPC and returns its result', async () => {
    const { admin, calls } = client({
      prepare_account_deletion: {
        data: { settled: { settled_cup: 500 }, anonymized: { rides_customer: 3 } },
        error: null,
      },
    });
    const out = await prepareAccountDeletion(admin, USER);
    expect(out).toEqual({
      ok: true,
      settled: { settled_cup: 500 },
      anonymized: { rides_customer: 3 },
      legacy: false,
    });
    expect(calls).toEqual([`prepare_account_deletion(${USER})`]);
  });

  it.each([
    ['deletion_active_ride', 409],
    ['deletion_open_case', 409],
    ['deletion_debt', 409],
    ['deletion_payment_pending', 409],
    ['deletion_system_account', 403],
  ])('passes the Spanish message of %s through', async (detail, status) => {
    const { admin, calls } = client({
      prepare_account_deletion: {
        data: null,
        error: { code: 'P0001', message: 'Texto para la persona.', details: detail },
      },
    });
    const out = await prepareAccountDeletion(admin, USER);
    expect(out).toMatchObject({ ok: false, status, error: detail, message: 'Texto para la persona.' });
    // A refusal never reaches the old two-step path.
    expect(calls).toEqual([`prepare_account_deletion(${USER})`]);
  });

  it('reports an incomplete anonymization as a 500 with the failed columns in the log only', async () => {
    const { admin } = client({
      prepare_account_deletion: {
        data: null,
        error: {
          code: 'P0001',
          message: 'No pudimos eliminar tu cuenta. Escríbenos a soporte.',
          details: 'deletion_incomplete',
          hint: 'referrals_referee',
        },
      },
    });
    const out = await prepareAccountDeletion(admin, USER);
    expect(out).toEqual({
      ok: false,
      status: 500,
      error: 'deletion_incomplete',
      message: 'No pudimos eliminar tu cuenta. Escríbenos a soporte.',
      log: 'deletion_incomplete: referrals_referee',
    });
  });

  it('hides any other database error behind deletion_failed', async () => {
    const { admin } = client({
      prepare_account_deletion: {
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      },
    });
    const out = await prepareAccountDeletion(admin, USER);
    expect(out).toMatchObject({ ok: false, status: 500, error: 'deletion_failed', message: null });
    if (!out.ok) expect(out.log).toContain('57014');
  });

  it('does not trust a deletion_* DETAIL it does not know', async () => {
    const { admin } = client({
      prepare_account_deletion: {
        data: null,
        error: { code: 'P0001', message: 'algo interno', details: 'deletion_something_new' },
      },
    });
    const out = await prepareAccountDeletion(admin, USER);
    expect(out).toMatchObject({ ok: false, status: 500, error: 'deletion_failed', message: null });
  });

  describe('before 00657 is applied (function missing)', () => {
    const missing: Answer = {
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function public.prepare_account_deletion(p_user_id) in the schema cache' },
    };

    it('falls back to settle, then anonymize', async () => {
      const { admin, calls } = client({
        prepare_account_deletion: missing,
        settle_and_scrub_for_deletion: { data: { settled_cup: 0 }, error: null },
        anonymize_user_references: { data: { rides_customer: 1 }, error: null },
      });
      const out = await prepareAccountDeletion(admin, USER);
      expect(out).toEqual({
        ok: true,
        settled: { settled_cup: 0 },
        anonymized: { rides_customer: 1 },
        legacy: true,
      });
      expect(calls).toEqual([
        `prepare_account_deletion(${USER})`,
        `settle_and_scrub_for_deletion(${USER})`,
        `anonymize_user_references(${USER})`,
      ]);
    });

    it('also recognises the message without the code', async () => {
      const { admin, calls } = client({
        prepare_account_deletion: { data: null, error: { message: 'Could not find the function x' } },
        settle_and_scrub_for_deletion: { data: {}, error: null },
        anonymize_user_references: { data: {}, error: null },
      });
      expect((await prepareAccountDeletion(admin, USER)).ok).toBe(true);
      expect(calls).toHaveLength(3);
    });

    it('stops before anonymizing when the settlement fails', async () => {
      const { admin, calls } = client({
        prepare_account_deletion: missing,
        settle_and_scrub_for_deletion: { data: null, error: { message: 'boom' } },
      });
      const out = await prepareAccountDeletion(admin, USER);
      expect(out).toMatchObject({ ok: false, status: 500, error: 'deletion_failed' });
      expect(calls).not.toContain(`anonymize_user_references(${USER})`);
    });

    it('stops before the auth delete when a reference stayed behind', async () => {
      const { admin } = client({
        prepare_account_deletion: missing,
        settle_and_scrub_for_deletion: { data: {}, error: null },
        anonymize_user_references: {
          data: { rides_customer: 2, referrals_referee: { error: 'duplicate key value' } },
          error: null,
        },
      });
      const out = await prepareAccountDeletion(admin, USER);
      expect(out).toMatchObject({ ok: false, status: 500, error: 'deletion_incomplete' });
      if (!out.ok) expect(out.log).toBe('anonymize_incomplete: referrals_referee');
    });
  });
});

describe('failedAnonymizations', () => {
  it('lists only the entries that report an error, sorted', () => {
    expect(
      failedAnonymizations({
        z_col: { error: 'x' },
        rides_customer: 4,
        a_col: { error: 'y', sqlstate: '23505' },
        nested_ok: { moved: 2 },
      }),
    ).toEqual(['a_col', 'z_col']);
  });

  it('accepts anything that is not an object', () => {
    expect(failedAnonymizations(null)).toEqual([]);
    expect(failedAnonymizations('x')).toEqual([]);
    expect(failedAnonymizations([{ error: 'x' }])).toEqual([]);
  });
});
