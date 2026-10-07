import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// In-memory stand-in for the reads behind a company's balance and employee
// list, following the live schema and RLS (checked against production on
// 2026-10-07):
//  - a company's money is the corporate_cash wallet of its creator
//    (corporate_accounts.created_by); no wallet row exists under a company id.
//  - wallet_accounts and users are own-or-admin: a company admin cannot read
//    another user's wallet or user row directly.
//  - get_corporate_balance / get_corporate_employees (00624) answer 42501 to
//    anyone who is not an admin of the company; before 00624 they resolve with
//    PGRST202, like any RPC the database does not have.
//  - find_user_by_phone returns the one active account that confirmed the
//    number, or no row.
// Every call resolves { data, error } and nothing throws, as in postgrest-js.
type Row = Record<string, unknown>;
type QueryError = { code: string; message: string; details: string | null; hint: string | null };
type Result = { data: unknown; error: QueryError | null };

const CREATOR = '00000000-0000-4000-8000-000000000011';
const SECOND_ADMIN = '00000000-0000-4000-8000-000000000012';
const EMPLOYEE = '00000000-0000-4000-8000-000000000013';
const COMPANY = '00000000-0000-4000-8000-0000000000a1';

function queryError(code: string, message: string, details: string | null = null): QueryError {
  return { code, message, details, hint: null };
}
const missingFunction = (fn: string, args: Row) =>
  queryError('PGRST202', `Could not find the function public.${fn}(${Object.keys(args).sort().join(', ')}) in the schema cache`);
const notCompanyAdmin = queryError('42501', 'Solo un administrador de la empresa puede ver su saldo.', 'not_corporate_admin');

let signedIn: string;
let applied00624: boolean;
let rpcFailure: Partial<Record<string, QueryError>>;
let rpcCalls: Array<{ fn: string; args: Row }>;
let reads: Array<{ table: string; filters: Array<[string, unknown]> }>;
let inserts: Array<{ table: string; row: Row }>;
let db: { corporate_accounts: Row[]; corporate_employees: Row[]; wallet_accounts: Row[]; users: Row[]; corporate_rides: Row[] };

const admins = () => db.corporate_employees.filter((e) => e.role === 'admin' && e.is_active).map((e) => e.user_id);

function rpc(fn: string, args: Row): Promise<Result> {
  rpcCalls.push({ fn, args });
  const failure = rpcFailure[fn];
  if (failure) return Promise.resolve({ data: null, error: failure });
  if (fn === 'find_user_by_phone') {
    const user = db.users.find((u) => u.confirmed_phone === args.p_phone);
    return Promise.resolve({ data: user ? [{ id: user.id, full_name: user.full_name, phone: user.confirmed_phone }] : [], error: null });
  }
  if ((fn === 'get_corporate_balance' || fn === 'get_corporate_employees') && applied00624) {
    if (!admins().includes(signedIn)) return Promise.resolve({ data: null, error: notCompanyAdmin });
    if (fn === 'get_corporate_balance') {
      const account = db.corporate_accounts.find((a) => a.id === args.p_account_id);
      if (!account) return Promise.resolve({ data: [], error: null });
      const wallet = db.wallet_accounts.find((w) => w.user_id === account.created_by && w.account_type === 'corporate_cash');
      return Promise.resolve({ data: [{ available: wallet?.balance ?? 0, held: wallet?.held_balance ?? 0 }], error: null });
    }
    const rows = db.corporate_employees
      .filter((e) => e.corporate_account_id === args.p_account_id)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) // newest first, like the function
      .map((e) => {
        const user = db.users.find((u) => u.id === e.user_id);
        return { ...e, full_name: user?.full_name ?? null, phone: user?.phone ?? null };
      });
    return Promise.resolve({ data: rows, error: null });
  }
  return Promise.resolve({ data: null, error: missingFunction(fn, args) });
}

// RLS as prod: wallets and users are own-or-admin (no platform admin here);
// a company admin reads every employee row of the company, anyone else only their own.
function visible(table: string, row: Row): boolean {
  if (table === 'wallet_accounts') return row.user_id === signedIn;
  if (table === 'users') return row.id === signedIn;
  if (table === 'corporate_employees') return admins().includes(signedIn) || row.user_id === signedIn;
  return true;
}

function from(table: string) {
  const filters: Array<[string, unknown]> = [];
  let range: [number, number] | null = null;
  const rows = (): Row[] => {
    const source = db[table as keyof typeof db] as Row[];
    return source
      .filter((r) => visible(table, r))
      .filter((r) => filters.every(([col, value]) => r[col] === value))
      .map((r) => {
        if (table !== 'corporate_employees') return r;
        const user = db.users.find((u) => u.id === r.user_id);
        // The users(...) embed obeys users' RLS: a hidden user row embeds as null.
        return { ...r, users: user && visible('users', user) ? { full_name: user.full_name, phone: user.phone } : null };
      });
  };
  const record = () => reads.push({ table, filters: [...filters] });
  const builder = {
    select: () => builder,
    eq: (col: string, value: unknown) => {
      filters.push([col, value]);
      return builder;
    },
    order: () => builder,
    gte: () => builder,
    lte: () => builder,
    range: (a: number, b: number) => {
      range = [a, b];
      return builder;
    },
    maybeSingle: () => {
      record();
      const found = rows();
      if (found.length > 1) return Promise.resolve({ data: null, error: queryError('PGRST116', 'JSON object requested, multiple (or no) rows returned') });
      return Promise.resolve({ data: found[0] ?? null, error: null });
    },
    single: () => {
      record();
      const found = rows();
      if (found.length !== 1) return Promise.resolve({ data: null, error: queryError('PGRST116', 'JSON object requested, multiple (or no) rows returned') });
      return Promise.resolve({ data: found[0], error: null });
    },
    insert: (row: Row) => {
      inserts.push({ table, row });
      return {
        select: () => ({
          single: () => Promise.resolve({ data: { id: 'employee-new', is_active: true, ...row }, error: null }),
        }),
      };
    },
    then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) => {
      record();
      let found = rows();
      if (range) found = found.slice(range[0], range[1] + 1);
      return Promise.resolve({ data: found, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ from, rpc }),
}));

import { corporateService } from '../corporate.service';
import { walletService } from '../wallet.service';

// Parameter names of the latest migration that defines `fn` (PostgREST
// resolves a function by the exact set of argument names).
function declaredParams(fn: string): string[] {
  const dir = fileURLToPath(new URL('../../../../../supabase/migrations/', import.meta.url));
  const header = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\s*\\(([^;]*?)\\)\\s*RETURNS`, 'i');
  const latest = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(dir, file), 'utf8').match(header)?.[1])
    .filter((params): params is string => params !== undefined)
    .at(-1);
  return (latest ?? '')
    .split(',')
    .map((param) => param.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean)
    .sort();
}

beforeEach(() => {
  signedIn = SECOND_ADMIN;
  applied00624 = true;
  rpcFailure = {};
  rpcCalls = [];
  reads = [];
  inserts = [];
  db = {
    corporate_accounts: [{ id: COMPANY, name: 'Clínica Sol', created_by: CREATOR, status: 'approved' }],
    corporate_employees: [
      { id: 'e1', corporate_account_id: COMPANY, user_id: CREATOR, role: 'admin', is_active: true, added_by: CREATOR, created_at: '2026-10-01T10:00:00Z' },
      { id: 'e2', corporate_account_id: COMPANY, user_id: SECOND_ADMIN, role: 'admin', is_active: true, added_by: CREATOR, created_at: '2026-10-02T10:00:00Z' },
      { id: 'e3', corporate_account_id: COMPANY, user_id: EMPLOYEE, role: 'employee', is_active: true, added_by: CREATOR, created_at: '2026-10-03T10:00:00Z' },
      { id: 'e4', corporate_account_id: COMPANY, user_id: 'former', role: 'employee', is_active: false, added_by: CREATOR, created_at: '2026-10-04T10:00:00Z' },
    ],
    wallet_accounts: [{ id: 'w1', user_id: CREATOR, account_type: 'corporate_cash', balance: 5000, held_balance: 100 }],
    users: [
      { id: CREATOR, full_name: 'Ana', phone: '+5350000001', confirmed_phone: '+5350000001' },
      { id: SECOND_ADMIN, full_name: 'Beto', phone: '+5350000002', confirmed_phone: '+5350000002' },
      { id: EMPLOYEE, full_name: 'Cora', phone: '+5350000003', confirmed_phone: '+5350000003' },
      { id: 'former', full_name: 'Fede', phone: '+5350000006', confirmed_phone: '+5350000006' },
      { id: 'unconfirmed', full_name: 'Gil', phone: '+5350000007', confirmed_phone: null },
    ],
    corporate_rides: [
      { corporate_account_id: COMPANY, employee_user_id: EMPLOYEE, fare_trc: 300, created_at: '2026-10-05T10:00:00Z' },
      { corporate_account_id: COMPANY, employee_user_id: 'former', fare_trc: 200, created_at: '2026-10-04T12:00:00Z' },
    ],
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the company balance (00624)', () => {
  it('reads the wallet that funds the company, which a second admin cannot read directly', async () => {
    await expect(corporateService.getCorporateBalance(COMPANY)).resolves.toBe(5000);
    await expect(walletService.getCorporateBalance(COMPANY)).resolves.toEqual({ available: 5000, held: 100 });
    expect(rpcCalls.map((c) => c.fn)).toEqual(['get_corporate_balance', 'get_corporate_balance']);
  });

  it('sends the argument names the migration declares', async () => {
    await corporateService.getCorporateBalance(COMPANY);
    expect(Object.keys(rpcCalls[0]!.args).sort()).toEqual(declaredParams('get_corporate_balance'));
  });

  it('shows 0 for a company the server does not know', async () => {
    await expect(corporateService.getCorporateBalance('unknown')).resolves.toBe(0);
    await expect(walletService.getCorporateBalance('unknown')).resolves.toEqual({ available: 0, held: 0 });
  });

  it('before 00624, reads the creator\'s wallet instead of a wallet keyed by the company id', async () => {
    applied00624 = false;
    signedIn = CREATOR;
    await expect(corporateService.getCorporateBalance(COMPANY)).resolves.toBe(5000);
    await expect(walletService.getCorporateBalance(COMPANY)).resolves.toEqual({ available: 5000, held: 100 });
    const walletReads = reads.filter((r) => r.table === 'wallet_accounts');
    expect(walletReads.length).toBeGreaterThan(0);
    for (const r of walletReads) expect(r.filters).toContainEqual(['user_id', CREATOR]);
  });

  it('gives 0 to an employee who is not an admin, without failing the screen', async () => {
    signedIn = EMPLOYEE;
    await expect(corporateService.getCorporateBalance(COMPANY)).resolves.toBe(0);
  });

  it('the panel reader still surfaces an unexpected failure', async () => {
    rpcFailure.get_corporate_balance = queryError('', 'TypeError: Network request failed');
    await expect(walletService.getCorporateBalance(COMPANY)).rejects.toMatchObject({ message: 'TypeError: Network request failed' });
  });
});

describe('the company employees (00624)', () => {
  it('lists the active employees with their names and phones, which users RLS hides from a company admin', async () => {
    const employees = await corporateService.getEmployees(COMPANY);
    expect(employees.map((e) => [e.users.full_name, e.users.phone, e.role])).toEqual([
      ['Cora', '+5350000003', 'employee'],
      ['Beto', '+5350000002', 'admin'],
      ['Ana', '+5350000001', 'admin'],
    ]);
    expect(Object.keys(rpcCalls[0]!.args).sort()).toEqual(declaredParams('get_corporate_employees'));
  });

  it('pages the active employees', async () => {
    const page = await corporateService.getEmployees(COMPANY, 1, 2);
    expect(page.map((e) => e.users.full_name)).toEqual(['Ana']);
  });

  it('before 00624, falls back to the direct read', async () => {
    applied00624 = false;
    const employees = await corporateService.getEmployees(COMPANY);
    expect(employees).toHaveLength(3);
    expect(reads.some((r) => r.table === 'corporate_employees')).toBe(true);
  });

  it('an employee who is not an admin still gets what RLS lets them read', async () => {
    signedIn = EMPLOYEE;
    const employees = await corporateService.getEmployees(COMPANY);
    expect(employees.map((e) => e.user_id)).toEqual([EMPLOYEE]);
  });

  it('the monthly report names every employee, the former ones too', async () => {
    const report = await corporateService.getEmployeeReport(COMPANY, 2026, 10);
    expect(report.map((r) => [r.name, r.phone, r.total_spent_trc])).toEqual([
      ['Cora', '+5350000003', 300],
      ['Fede', '+5350000006', 200],
    ]);
  });
});

describe('adding an employee', () => {
  it('finds the person by the phone their account confirmed, and adds them', async () => {
    signedIn = CREATOR;
    await corporateService.addEmployee(COMPANY, '+5350000003', 'employee', CREATOR);
    expect(rpcCalls).toEqual([{ fn: 'find_user_by_phone', args: { p_phone: '+5350000003' } }]);
    expect(inserts).toEqual([
      { table: 'corporate_employees', row: { corporate_account_id: COMPANY, user_id: EMPLOYEE, role: 'employee', added_by: CREATOR } },
    ]);
    expect(reads.some((r) => r.table === 'users')).toBe(false);
  });

  it('a number no account confirmed is not found', async () => {
    signedIn = CREATOR;
    await expect(corporateService.addEmployee(COMPANY, '+5350000007', 'employee', CREATOR)).rejects.toThrow('USER_NOT_FOUND');
    expect(inserts).toEqual([]);
  });

  it('surfaces a failed lookup (for example the hourly limit) instead of saying not found', async () => {
    signedIn = CREATOR;
    rpcFailure.find_user_by_phone = queryError('P0001', 'Rate limit exceeded: max 30 phone lookups per hour');
    await expect(corporateService.addEmployee(COMPANY, '+5350000003', 'employee', CREATOR)).rejects.toMatchObject({ code: 'P0001' });
    expect(inserts).toEqual([]);
  });
});
