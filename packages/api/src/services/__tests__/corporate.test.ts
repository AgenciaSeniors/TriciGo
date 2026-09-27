import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// In-memory stand-in for what registerAccount touches. It follows the live
// schema and postgrest-js 2.99.1 on the points this suite depends on
// (checked against production on 2026-09-27):
//  - wallet_accounts.user_id is a foreign key to users(id), unique per
//    (user_id, account_type). ensure_wallet_account is idempotent, and a
//    direct call from a signed-in non-admin may only create the caller's own
//    wallet: any other p_user_id fails with 42501 (00591) before the foreign
//    key is even reached. That is why a wallet keyed by the corporate account
//    id could never be created.
//  - corporate_accounts' INSERT policy requires created_by = auth.uid(), and
//    corporate_employees' bootstrap policy lets that creator add themselves as
//    the first admin of the account.
//  - an RPC the database does not have resolves with PGRST202.
//  - a request that never reaches the server resolves, it does not throw, with
//    code '' and message 'TypeError: Network request failed'.
// Every call resolves { data, error } and nothing throws, as in postgrest-js.
type Row = Record<string, unknown>;
type QueryError = { code: string; message: string; details: string | null; hint: string | null };
type Result = { data: unknown; error: QueryError | null };
type Failure = 'corporate_accounts' | 'corporate_employees' | 'ensure_wallet_account' | 'register_corporate_account';

const OWNER = '00000000-0000-4000-8000-000000000011';
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';

function queryError(code: string, message: string, details: string | null = null): QueryError {
  return { code, message, details, hint: null };
}

const CONNECTION_LOST = queryError('', 'TypeError: Network request failed');
const RLS_DENIED = (table: string) =>
  queryError('42501', `new row violates row-level security policy for table "${table}"`);

let signedIn: string;
let users: Set<string>;
let db: { corporate_accounts: Row[]; corporate_employees: Row[]; wallet_accounts: Row[] };
let failures: Partial<Record<Failure, QueryError>>;
let registerRpcApplied: boolean;
let rpcCalls: Array<{ fn: string; args: Row }>;
let tablesWritten: string[];

// The row register_corporate_account returns when it exists (00601).
const serverAccount = {
  id: ACCOUNT,
  name: 'Clínica Sol',
  contact_phone: '+5351234567',
  contact_email: null,
  tax_id: null,
  status: 'pending',
  is_fleet_owner: false,
  created_by: OWNER,
  created_at: '2026-09-27T14:00:00+00:00',
};

function ensureWallet(args: Row): Result {
  const userId = args.p_user_id as string;
  const type = args.p_type as string;
  if (userId !== signedIn) {
    return {
      data: null,
      error: queryError(
        '42501',
        'forbidden: ensure_wallet_account may only create your own customer_cash, tricicoin or corporate_cash account',
      ),
    };
  }
  if (!users.has(userId)) {
    return { data: null, error: queryError('23503', 'insert or update on table "wallet_accounts" violates foreign key constraint "wallet_accounts_user_id_fkey"') };
  }
  let wallet = db.wallet_accounts.find((w) => w.user_id === userId && w.account_type === type);
  if (!wallet) {
    wallet = { id: `wallet-${db.wallet_accounts.length + 1}`, user_id: userId, account_type: type, balance: 0 };
    db.wallet_accounts.push(wallet);
  }
  return { data: wallet.id, error: null };
}

function rpc(fn: string, args: Row): Promise<Result> {
  rpcCalls.push({ fn, args });
  const failure = failures[fn as Failure];
  if (failure) return Promise.resolve({ data: null, error: failure });
  if (fn === 'ensure_wallet_account') return Promise.resolve(ensureWallet(args));
  if (fn === 'register_corporate_account' && registerRpcApplied) {
    return Promise.resolve({ data: { ...serverAccount }, error: null });
  }
  const names = Object.keys(args).sort().join(', ');
  return Promise.resolve({
    data: null,
    error: queryError(
      'PGRST202',
      `Could not find the function public.${fn}(${names}) in the schema cache`,
      `Searched for the function public.${fn} with parameters ${names} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`,
    ),
  });
}

function insertRow(table: string, row: Row): Result {
  if (table === 'corporate_accounts') {
    if (row.created_by !== signedIn) return { data: null, error: RLS_DENIED(table) };
    const created = { id: ACCOUNT, status: 'pending', is_fleet_owner: false, created_at: serverAccount.created_at, ...row };
    db.corporate_accounts.push(created);
    return { data: [created], error: null };
  }
  if (table === 'corporate_employees') {
    const account = db.corporate_accounts.find((a) => a.id === row.corporate_account_id);
    const bootstrap =
      account?.created_by === signedIn &&
      row.user_id === signedIn &&
      row.role === 'admin' &&
      !db.corporate_employees.some((e) => e.corporate_account_id === row.corporate_account_id);
    if (!bootstrap) return { data: null, error: RLS_DENIED(table) };
    const created = { id: `employee-${db.corporate_employees.length + 1}`, is_active: true, ...row };
    db.corporate_employees.push(created);
    return { data: [created], error: null };
  }
  throw new Error(`The test double has no table ${table}`);
}

function from(table: string) {
  let write: (() => Result) | null = null;
  let returning = false;
  const run = (): Result => {
    const failure = failures[table as Failure];
    if (failure) return { data: null, error: failure };
    if (!write) throw new Error(`registerAccount does not read ${table}`);
    const result = write();
    // Without .select() PostgREST answers a write with no body.
    return returning || result.error ? result : { data: null, error: null };
  };
  const builder = {
    insert: (row: Row) => {
      tablesWritten.push(table);
      write = () => insertRow(table, row);
      return builder;
    },
    select: () => {
      returning = true;
      return builder;
    },
    single: () => {
      const result = run();
      if (result.error) return Promise.resolve(result);
      const rows = result.data as Row[];
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return builder;
}

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ from, rpc }),
}));

// Import after the mock is set up.
import { corporateService } from '../corporate.service';

const request = { name: 'Clínica Sol', contact_phone: '+5351234567', created_by: OWNER };

// Parameter names of the latest migration that defines `fn`. PostgREST
// resolves a function by the exact set of argument names, so a key the
// migration does not declare makes the RPC look missing (PGRST202), and
// registerAccount would quietly take the non-atomic path forever.
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
  signedIn = OWNER;
  users = new Set([OWNER]);
  db = { corporate_accounts: [], corporate_employees: [], wallet_accounts: [] };
  failures = {};
  registerRpcApplied = true;
  rpcCalls = [];
  tablesWritten = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('corporateService.registerAccount with register_corporate_account (00601)', () => {
  it('creates the account, its admin row and the wallet in one server call', async () => {
    const account = await corporateService.registerAccount(request);

    expect(account).toEqual(serverAccount);
    expect(rpcCalls).toEqual([
      {
        fn: 'register_corporate_account',
        args: {
          p_created_by: OWNER,
          p_name: 'Clínica Sol',
          p_contact_phone: '+5351234567',
          p_contact_email: null,
          p_tax_id: null,
        },
      },
    ]);
    expect(tablesWritten).toEqual([]);
  });

  it('sends the argument names the migration declares', async () => {
    const declared = declaredParams('register_corporate_account');
    expect(declared).not.toHaveLength(0);

    await corporateService.registerAccount(request);

    const call = rpcCalls.find((c) => c.fn === 'register_corporate_account');
    expect(Object.keys(call?.args ?? {}).sort()).toEqual(declared);
  });

  it('surfaces a failed call without redoing the steps from the client', async () => {
    // The response may be lost after the server committed. Running the
    // client-side steps then would create a second account.
    failures.register_corporate_account = CONNECTION_LOST;

    await expect(corporateService.registerAccount(request)).rejects.toBe(CONNECTION_LOST);

    expect(rpcCalls.map((c) => c.fn)).toEqual(['register_corporate_account']);
    expect(tablesWritten).toEqual([]);
  });
});

describe('corporateService.registerAccount before 00601 is applied', () => {
  beforeEach(() => {
    registerRpcApplied = false;
  });

  it('keys the corporate wallet by the account creator, as every server path does', async () => {
    const account = await corporateService.registerAccount(request);

    expect(account).toMatchObject({ id: ACCOUNT, created_by: OWNER, status: 'pending' });
    expect(db.corporate_employees).toEqual([
      expect.objectContaining({ corporate_account_id: ACCOUNT, user_id: OWNER, role: 'admin', added_by: OWNER }),
    ]);
    expect(db.wallet_accounts).toEqual([
      expect.objectContaining({ user_id: OWNER, account_type: 'corporate_cash' }),
    ]);
  });

  it('surfaces a failed admin row instead of returning the account', async () => {
    failures.corporate_employees = CONNECTION_LOST;

    await expect(corporateService.registerAccount(request)).rejects.toBe(CONNECTION_LOST);
  });

  it('creates the wallet first, so a failed wallet step leaves no account behind', async () => {
    failures.ensure_wallet_account = CONNECTION_LOST;

    await expect(corporateService.registerAccount(request)).rejects.toBe(CONNECTION_LOST);

    expect(db.corporate_accounts).toEqual([]);
  });
});
