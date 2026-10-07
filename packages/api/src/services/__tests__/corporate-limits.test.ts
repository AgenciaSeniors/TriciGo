import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-in for an UPDATE of corporate_accounts through PostgREST.
// It follows prod on the points this suite depends on (checked 2026-10-07):
//  - RLS lets only a platform admin or an active admin of the company update
//    the row; anyone else matches no row and gets no error.
//  - tg_corporate_accounts_protect_admin_fields reverted monthly_budget_trc and
//    per_ride_cap_trc for every JWT that is not a platform admin until 00625;
//    from 00625 a company admin may set them.
//  - From 00625 both columns are CHECK >= 0 (23514).
// Every call resolves { data, error } and nothing throws, as in postgrest-js.
type Row = { id: string; monthly_budget_trc: number; per_ride_cap_trc: number; name: string };

const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
let row: Row;
let callerIsCompanyAdmin: boolean;
let server: 'before_00625' | '00625';
let selected: string[];
let updates: Array<Record<string, unknown>>;

function updateBuilder(values: Record<string, unknown>) {
  updates.push(values);
  let id: string | undefined;
  const apply = () => {
    if (!callerIsCompanyAdmin || id !== row.id) return { data: [], error: null };
    const next = { ...row, ...values } as Row;
    if (server === 'before_00625') {
      next.monthly_budget_trc = row.monthly_budget_trc;
      next.per_ride_cap_trc = row.per_ride_cap_trc;
    } else if (next.monthly_budget_trc < 0 || next.per_ride_cap_trc < 0) {
      return {
        data: null,
        error: { code: '23514', message: 'new row for relation "corporate_accounts" violates check constraint', details: null, hint: null },
      };
    }
    row = next;
    return { data: [row], error: null };
  };
  const builder = {
    eq(column: string, value: string) {
      if (column === 'id') id = value;
      return builder;
    },
    select(columns: string) {
      selected.push(columns);
      const result = apply();
      if (!result.data) return Promise.resolve(result);
      const cols = columns.split(',').map((c) => c.trim());
      const data = (result.data as Row[]).map((r) =>
        Object.fromEntries(cols.map((c) => [c, (r as unknown as Record<string, unknown>)[c]])),
      );
      return Promise.resolve({ data, error: null });
    },
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      const { error } = apply();
      return Promise.resolve({ data: null, error }).then(resolve, reject);
    },
  };
  return builder;
}

const mockSupabase = {
  from: vi.fn((table: string) => {
    if (table !== 'corporate_accounts') throw new Error(`unexpected table ${table}`);
    return { update: updateBuilder };
  }),
};

vi.mock('../../client', () => ({ getSupabaseClient: () => mockSupabase }));

import { corporateService } from '../corporate.service';
import { AppError, ValidationError } from '../../errors';

beforeEach(() => {
  row = { id: ACCOUNT, monthly_budget_trc: 0, per_ride_cap_trc: 0, name: 'Clínica Sol' };
  callerIsCompanyAdmin = true;
  server = '00625';
  selected = [];
  updates = [];
});

describe('corporateService.updateAccount — the company sets its budget and cap (00625)', () => {
  it('saves them and resolves', async () => {
    await expect(
      corporateService.updateAccount(ACCOUNT, { monthly_budget_trc: 20000, per_ride_cap_trc: 3000 }),
    ).resolves.toBeUndefined();
    expect(row.monthly_budget_trc).toBe(20000);
    expect(row.per_ride_cap_trc).toBe(3000);
  });

  it('accepts 0, which means no limit', async () => {
    row.monthly_budget_trc = 5000;
    await expect(corporateService.updateAccount(ACCOUNT, { monthly_budget_trc: 0 })).resolves.toBeUndefined();
    expect(row.monthly_budget_trc).toBe(0);
  });

  it('does not report success when the server kept the old values (before 00625)', async () => {
    server = 'before_00625';
    const err = await corporateService
      .updateAccount(ACCOUNT, { monthly_budget_trc: 20000, per_ride_cap_trc: 3000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('CORPORATE_LIMITS_NOT_SAVED');
    expect((err as AppError).message).toBe(
      'No se pudieron guardar el presupuesto y el tope. Vuelve a intentarlo más tarde.',
    );
  });

  it('does not report success to someone who may not change the company', async () => {
    callerIsCompanyAdmin = false;
    const err = await corporateService
      .updateAccount(ACCOUNT, { monthly_budget_trc: 20000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('CORPORATE_NOT_ADMIN');
    expect((err as AppError).message).toBe('Solo un administrador de la empresa puede cambiar sus límites.');
    expect(row.monthly_budget_trc).toBe(0);
  });

  it.each([
    ['a negative budget', { monthly_budget_trc: -1 }],
    ['a negative cap', { per_ride_cap_trc: -5 }],
    ['a budget with cents', { monthly_budget_trc: 1500.5 }],
    ['a cap that is not a number', { per_ride_cap_trc: Number.NaN }],
  ])('rejects %s before calling the server', async (_label, limits) => {
    const err = await corporateService.updateAccount(ACCOUNT, limits).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toBe(
      'El presupuesto y el tope por viaje deben ser montos enteros de 0 o más.',
    );
    expect(updates).toHaveLength(0);
  });

  it('surfaces a server error', async () => {
    // Only reachable if a client skipped the check above; the server still says no.
    server = '00625';
    row.monthly_budget_trc = 10;
    mockSupabase.from.mockImplementationOnce(() => ({
      update: (values: Record<string, unknown>) => updateBuilder({ ...values, monthly_budget_trc: -1 }),
    }));
    await expect(corporateService.updateAccount(ACCOUNT, { monthly_budget_trc: 3 })).rejects.toMatchObject({ code: '23514' });
  });

  it('an update that does not touch the limits works as before (fleet request resubmission)', async () => {
    callerIsCompanyAdmin = false;
    await expect(corporateService.updateAccount(ACCOUNT, { name: 'Otra' })).resolves.toBeUndefined();
    expect(selected).toHaveLength(0);
  });
});
