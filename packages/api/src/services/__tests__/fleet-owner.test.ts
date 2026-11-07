import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DriverFleet, FleetMember } from '@tricigo/types';

// In-memory stand-in for corporate_accounts, driver_fleets, fleet_members and
// admin_actions. It follows postgrest-js 2.99.1 and the live schema on the
// points this suite depends on:
//  - awaiting a read resolves every row that passes the eq/in filters, sorted
//    by the ORDER BY calls and cut by limit();
//  - a select() with a column list returns only those columns, a NULL one as
//    null, so a column the service forgets to select comes back missing;
//  - maybeSingle() over two or more rows resolves (does not throw) to error
//    PGRST116 with data null, and single() does the same over zero rows;
//  - driver_fleets is UNIQUE (corporate_account_id) and fleet_members is
//    UNIQUE (fleet_id, driver_phone). A statement is atomic: an insert or
//    update that hits a key, even one written earlier in the same statement,
//    fails with 23505 and writes nothing;
//  - an upsert targets its onConflict columns, or the primary key when there
//    are none (as PostgREST does), and fails with 42P10 on columns without a
//    unique key. On a conflict it updates the existing row, or skips it with
//    ignoreDuplicates (also within the statement). A merge upsert that hits
//    the same key twice in one statement, which Postgres rejects, is not
//    modelled;
//  - an update or a delete without select() resolves data null, whatever it
//    changed; with select() it resolves the rows it touched, none when RLS
//    hid them (RLS answers OK with 0 rows, it does not fail);
//  - an upsert naming a column the table does not have (missingColumns, a
//    migration not applied yet) fails with PGRST204 and writes nothing, even
//    when the value is null: PostgREST checks the keys, not the values.
// RLS and triggers are not emulated: the service filters by created_by
// itself, and the protect triggers of 00418/00434 let an admin write every
// column (only an admin approves an account).
type Table = 'corporate_accounts' | 'driver_fleets' | 'fleet_members' | 'admin_actions' | 'fleet_invite_sends';
type Row = Record<string, unknown>;
type QueryError = { code: string; message: string; details: string | null; hint: string | null };
type Result = { data: unknown; error: QueryError | null };

// Unique keys besides the primary key (id), as in the live schema.
const UNIQUE_KEYS: Record<Table, string[][]> = {
  corporate_accounts: [],
  driver_fleets: [['corporate_account_id']],
  fleet_members: [['fleet_id', 'driver_phone']],
  admin_actions: [],
  fleet_invite_sends: [],
};

let db: Record<Table, Row[]> = {
  corporate_accounts: [],
  driver_fleets: [],
  fleet_members: [],
  admin_actions: [],
  fleet_invite_sends: [],
};
let failures: Partial<Record<Table, QueryError>> = {};
let missingColumns: Partial<Record<Table, string[]>> = {};
// Fails only the writes on a table, so a test can read and then lose a race.
let writeFailures: Partial<Record<Table, QueryError>> = {};
// Runs right before each write, so a test can change a row after the read.
let beforeWrite: (() => void) | null = null;
let generatedIds = 0;

function rowsOf(table: string): Row[] {
  const rows = db[table as Table];
  if (!rows) throw new Error(`The test double has no table ${table}`);
  return rows;
}

function seed(table: Table, ...rows: object[]): void {
  db[table].push(...(rows as Row[]));
}

function queryError(code: string, message: string, details: string | null = null): QueryError {
  return { code, message, details, hint: null };
}

function keysOf(table: string): string[][] {
  return [['id'], ...(UNIQUE_KEYS[table as Table] ?? [])];
}

function sameKey(row: Row, other: Row, columns: string[]): boolean {
  return columns.every((column) => row[column] !== undefined && row[column] === other[column]);
}

function clashingKey(table: string, row: Row, rows: Row[]): string[] | undefined {
  return keysOf(table).find((columns) => rows.some((other) => sameKey(row, other, columns)));
}

function duplicateKey(table: string, columns: string[]): QueryError {
  return queryError('23505', `duplicate key value violates unique constraint "${table}_${columns.join('_')}_key"`);
}

function insertRows(table: string, input: Row | Row[]): Result {
  const staged = rowsOf(table).map((row) => ({ ...row }));
  const inserted: Row[] = [];
  for (const row of Array.isArray(input) ? input : [input]) {
    const clash = clashingKey(table, row, staged);
    if (clash) return { data: null, error: duplicateKey(table, clash) };
    const created = { id: `generated-${++generatedIds}`, ...row };
    staged.push(created);
    inserted.push(created);
  }
  db[table as Table] = staged;
  return { data: inserted, error: null };
}

function upsertRows(
  table: string,
  input: Row | Row[],
  options: { onConflict?: string; ignoreDuplicates?: boolean },
): Result {
  const missing = missingColumns[table as Table] ?? [];
  for (const row of Array.isArray(input) ? input : [input]) {
    const column = Object.keys(row).find((key) => missing.includes(key));
    if (column) {
      return {
        data: null,
        error: queryError('PGRST204', `Could not find the '${column}' column of '${table}' in the schema cache`),
      };
    }
  }
  const target = options.onConflict ? options.onConflict.split(',').map((column) => column.trim()) : ['id'];
  if (!keysOf(table).some((columns) => columns.join() === target.join())) {
    return {
      data: null,
      error: queryError('42P10', 'there is no unique or exclusion constraint matching the ON CONFLICT specification'),
    };
  }
  const staged = rowsOf(table).map((row) => ({ ...row }));
  const written: Row[] = [];
  for (const row of Array.isArray(input) ? input : [input]) {
    const existing = staged.find((other) => sameKey(row, other, target));
    if (existing) {
      if (!options.ignoreDuplicates) written.push(Object.assign(existing, row));
      continue;
    }
    const clash = clashingKey(table, row, staged);
    if (clash) return { data: null, error: duplicateKey(table, clash) };
    const created = { id: `generated-${++generatedIds}`, ...row };
    staged.push(created);
    written.push(created);
  }
  db[table as Table] = staged;
  return { data: written, error: null };
}

function updateRows(table: string, values: Row, matches: (row: Row) => boolean): Result {
  const staged = rowsOf(table).map((row) => ({ ...row }));
  const updated = staged.filter(matches);
  for (const row of updated) Object.assign(row, values);
  for (const row of updated) {
    const clash = clashingKey(table, row, staged.filter((other) => other !== row));
    if (clash) return { data: null, error: duplicateKey(table, clash) };
  }
  db[table as Table] = staged;
  return { data: updated, error: null };
}

function deleteRows(table: string, matches: (row: Row) => boolean): Result {
  const rows = rowsOf(table);
  db[table as Table] = rows.filter((row) => !matches(row));
  return { data: rows.filter(matches), error: null };
}

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  const orderBy: Array<{ column: string; ascending: boolean }> = [];
  let limitTo: number | null = null;
  let write: (() => Result) | null = null;
  let writeKind: 'insert' | 'update' | 'upsert' | 'delete' | null = null;
  let selected = false;
  let columns: string[] | null = null; // null: select('*'), or no select() at all

  const project = (row: Row): Row =>
    columns ? Object.fromEntries(columns.map((column) => [column, row[column] ?? null])) : { ...row };

  const run = (): Result => {
    const failure = failures[table as Table];
    if (failure) return { data: null, error: failure };
    if (write) {
      beforeWrite?.();
      const writeFailure = writeFailures[table as Table];
      if (writeFailure) return { data: null, error: writeFailure };
      const written = write();
      // An update or a delete without select() resolves data null: no rows to project.
      if (written.error || written.data === null) return written;
      if ((writeKind === 'update' || writeKind === 'delete') && !selected) return { data: null, error: null };
      return { data: (written.data as Row[]).map(project), error: null };
    }
    const rows = rowsOf(table).filter((row) => filters.every((keep) => keep(row)));
    rows.sort((a, b) => {
      for (const { column, ascending } of orderBy) {
        const x = String(a[column]);
        const y = String(b[column]);
        if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
      }
      return 0;
    });
    const kept = limitTo === null ? rows : rows.slice(0, limitTo);
    return { data: kept.map(project), error: null };
  };

  const one = (allowNone: boolean): Result => {
    const result = run();
    if (result.error) return result;
    const rows = result.data as Row[];
    if (rows.length === 1) return { data: rows[0], error: null };
    if (rows.length === 0 && allowNone) return { data: null, error: null };
    return {
      data: null,
      error: queryError(
        'PGRST116',
        'JSON object requested, multiple (or no) rows returned',
        `Results contain ${rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
      ),
    };
  };

  const builder = {
    select: (list = '*') => {
      selected = true;
      columns = list.trim() === '*' ? null : list.split(',').map((column) => column.trim());
      return builder;
    },
    eq: (column: string, value: unknown) => {
      filters.push((row) => row[column] === value);
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      orderBy.push({ column, ascending: options?.ascending ?? true });
      return builder;
    },
    limit: (count: number) => {
      limitTo = count;
      return builder;
    },
    insert: (rows: Row | Row[]) => {
      writeKind = 'insert';
      write = () => insertRows(table, rows);
      return builder;
    },
    update: (values: Row) => {
      writeKind = 'update';
      write = () => updateRows(table, values, (row) => filters.every((keep) => keep(row)));
      return builder;
    },
    upsert: (rows: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      writeKind = 'upsert';
      write = () => upsertRows(table, rows, options ?? {});
      return builder;
    },
    delete: () => {
      writeKind = 'delete';
      write = () => deleteRows(table, (row) => filters.every((keep) => keep(row)));
      return builder;
    },
    single: () => Promise.resolve(one(false)),
    maybeSingle: () => Promise.resolve(one(true)),
    then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return builder;
}

// rpc, the session and Storage signing, for the owner and driver actions that
// do not go through a table.
let rpcCalls: Array<{ fn: string; args: unknown }> = [];
let rpcResults: Record<string, { data: unknown; error: QueryError | null }> = {};
let sessionUserId: string | null = null;
let signedUrlCalls: Array<{ bucket: string; path: string; seconds: number }> = [];
let signedUrlResult: { data: { signedUrl: string } | null; error: { message: string } | null } = {
  data: { signedUrl: 'https://signed.example/doc' },
  error: null,
};
const { uploadFileFromUri } = vi.hoisted(() => ({ uploadFileFromUri: vi.fn() }));

vi.mock('../_storage-upload', () => ({ uploadFileFromUri }));

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => query(table),
    // A function the database does not have answers PGRST202, like PostgREST.
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(
        rpcResults[fn] ?? { data: null, error: queryError('PGRST202', `Could not find the function public.${fn}`) },
      );
    },
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: sessionUserId ? { user: { id: sessionUserId } } : null }, error: null }),
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (path: string, seconds: number) => {
          signedUrlCalls.push({ bucket, path, seconds });
          return Promise.resolve(signedUrlResult);
        },
      }),
    },
  }),
}));

// Import after the mock is set up.
import { fleetService } from '../fleet.service';
import { corporateService } from '../corporate.service';

const OWNER = '00000000-0000-4000-8000-000000000011';
const OTHER_USER = '00000000-0000-4000-8000-000000000012';
const ADMIN = '00000000-0000-4000-8000-000000000061';
const ACCOUNT_A = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT_B = '00000000-0000-4000-8000-0000000000b1';
const ACCOUNT_C = '00000000-0000-4000-8000-0000000000c1';
const ACCOUNT_D = '00000000-0000-4000-8000-0000000000d1';
const FLEET_A = '00000000-0000-4000-8000-0000000001a1';
const FLEET_B = '00000000-0000-4000-8000-0000000001b1';
const FLEET_C = '00000000-0000-4000-8000-0000000001c1';
const FLEET_D = '00000000-0000-4000-8000-0000000001d1';

// A request sent from the app: since 00434 the INSERT trigger forces a
// non-admin's account to pending with is_fleet_owner = false, and since 00418
// the UPDATE trigger keeps it that way. Only an admin sets the flag.
function account(overrides: Row): Row {
  return {
    id: ACCOUNT_A,
    name: 'TaxiHabana',
    contact_phone: '+5351234567',
    status: 'pending',
    commission_percent: null,
    suspended_reason: null,
    is_fleet_owner: false,
    created_by: OWNER,
    created_at: '2026-09-20T14:00:00+00:00',
    ...overrides,
  };
}

function fleet(overrides: Partial<DriverFleet>): DriverFleet {
  return {
    id: FLEET_A,
    corporate_account_id: ACCOUNT_A,
    name: 'TaxiHabana',
    city: 'La Habana',
    vehicle_count_estimate: 12,
    vehicle_types: ['triciclo_basico'],
    operating_zones: ['Vedado'],
    estimated_rides_per_day_per_vehicle: 8,
    operating_hours_start: '06:00:00',
    operating_hours_end: '22:00:00',
    notes: null,
    created_at: '2026-09-20T14:00:01+00:00',
    updated_at: '2026-09-20T14:00:01+00:00',
    ...overrides,
  };
}

function member(overrides: Partial<FleetMember>): FleetMember {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    fleet_id: FLEET_A,
    driver_id: null,
    driver_name: 'Yoel Pérez',
    driver_phone: '+5351234567',
    driver_email: null,
    driver_license_number: null,
    driver_id_number: null,
    status: 'pending_review',
    license_doc_path: null,
    added_at: '2026-09-20T14:00:02+00:00',
    reviewed_at: null,
    reviewed_by: null,
    rejected_reason: null,
    signed_up_at: null,
    ...overrides,
  };
}

const CONNECTION_LOST = queryError('08006', 'connection failure');

beforeEach(() => {
  db = { corporate_accounts: [], driver_fleets: [], fleet_members: [], admin_actions: [], fleet_invite_sends: [] };
  rpcCalls = [];
  rpcResults = {};
  sessionUserId = null;
  signedUrlCalls = [];
  signedUrlResult = { data: { signedUrl: 'https://signed.example/doc' }, error: null };
  uploadFileFromUri.mockReset();
  failures = {};
  missingColumns = {};
  writeFailures = {};
  beforeWrite = null;
  generatedIds = 0;
});

describe('fleetService.getFleetByOwner', () => {
  it('returns null for a user who created no corporate account', async () => {
    expect(await fleetService.getFleetByOwner(OWNER)).toBeNull();
  });

  it('finds the fleet of a request sent from the app, which is never flagged is_fleet_owner', async () => {
    const m = member({});
    seed('corporate_accounts', account({}));
    seed('driver_fleets', fleet({}));
    seed('fleet_members', m);

    expect(await fleetService.getFleetByOwner(OWNER)).toEqual({
      fleet: fleet({}),
      members: [m],
      account: { id: ACCOUNT_A, name: 'TaxiHabana', status: 'pending', commission_percent: null, suspended_reason: null },
    });
  });

  it("returns the admin's reason with a rejected fleet", async () => {
    // corporateService.rejectAccount stores the reason in suspended_reason.
    seed('corporate_accounts', account({ status: 'rejected', suspended_reason: 'Faltan las licencias de los conductores' }));
    seed('driver_fleets', fleet({}));

    expect((await fleetService.getFleetByOwner(OWNER))?.account).toEqual({
      id: ACCOUNT_A,
      name: 'TaxiHabana',
      status: 'rejected',
      commission_percent: null,
      suspended_reason: 'Faltan las licencias de los conductores',
    });
  });

  it('returns null when none of the user accounts has a fleet', async () => {
    // A corporate client request (client app) is an account with no fleet.
    seed('corporate_accounts', account({}));

    expect(await fleetService.getFleetByOwner(OWNER)).toBeNull();
  });

  it('skips an account of the user that has no fleet', async () => {
    // The newer account has no fleet: a client request, or a fleet request
    // whose fleet step failed.
    seed(
      'corporate_accounts',
      account({ id: ACCOUNT_A, created_at: '2026-09-21T14:00:00+00:00' }),
      account({ id: ACCOUNT_B, created_at: '2026-09-20T14:00:00+00:00' }),
    );
    seed('driver_fleets', fleet({ id: FLEET_B, corporate_account_id: ACCOUNT_B }));

    expect((await fleetService.getFleetByOwner(OWNER))?.fleet.id).toBe(FLEET_B);
  });

  it('shows the approved fleet when two accounts of the user are flagged fleet owners', async () => {
    // Two flagged rows are what made maybeSingle() resolve PGRST116 and the
    // owner see the request form instead of the fleet.
    seed(
      'corporate_accounts',
      account({ id: ACCOUNT_A, status: 'approved', is_fleet_owner: true, created_at: '2026-09-01T14:00:00+00:00' }),
      account({ id: ACCOUNT_B, status: 'pending', is_fleet_owner: true, created_at: '2026-09-20T14:00:00+00:00' }),
    );
    seed(
      'driver_fleets',
      fleet({ id: FLEET_A, corporate_account_id: ACCOUNT_A }),
      fleet({ id: FLEET_B, corporate_account_id: ACCOUNT_B }),
    );

    const owned = await fleetService.getFleetByOwner(OWNER);
    expect(owned?.fleet.id).toBe(FLEET_A);
    expect(owned?.account.status).toBe('approved');
  });

  it('ranks approved, then pending, then suspended, then rejected, whatever their age', async () => {
    seed(
      'corporate_accounts',
      account({ id: ACCOUNT_A, status: 'rejected', created_at: '2026-09-24T14:00:00+00:00' }),
      account({ id: ACCOUNT_B, status: 'suspended', created_at: '2026-09-23T14:00:00+00:00' }),
      account({ id: ACCOUNT_C, status: 'pending', created_at: '2026-09-22T14:00:00+00:00' }),
      account({ id: ACCOUNT_D, status: 'approved', created_at: '2026-09-21T14:00:00+00:00' }),
    );
    seed(
      'driver_fleets',
      fleet({ id: FLEET_A, corporate_account_id: ACCOUNT_A }),
      fleet({ id: FLEET_B, corporate_account_id: ACCOUNT_B }),
      fleet({ id: FLEET_C, corporate_account_id: ACCOUNT_C }),
      fleet({ id: FLEET_D, corporate_account_id: ACCOUNT_D }),
    );

    const pickedAfterRemoving = async (accountId: string | null) => {
      if (accountId) db.corporate_accounts = db.corporate_accounts.filter((row) => row.id !== accountId);
      return (await fleetService.getFleetByOwner(OWNER))?.account.status;
    };
    expect(await pickedAfterRemoving(null)).toBe('approved');
    expect(await pickedAfterRemoving(ACCOUNT_D)).toBe('pending');
    expect(await pickedAfterRemoving(ACCOUNT_C)).toBe('suspended');
    expect(await pickedAfterRemoving(ACCOUNT_B)).toBe('rejected');
  });

  it('picks the newest of two fleets with the same status', async () => {
    seed(
      'corporate_accounts',
      account({ id: ACCOUNT_A, created_at: '2026-09-20T14:00:00+00:00' }),
      account({ id: ACCOUNT_B, created_at: '2026-09-21T09:30:00+00:00' }),
    );
    seed(
      'driver_fleets',
      fleet({ id: FLEET_A, corporate_account_id: ACCOUNT_A }),
      fleet({ id: FLEET_B, corporate_account_id: ACCOUNT_B }),
    );

    expect((await fleetService.getFleetByOwner(OWNER))?.fleet.id).toBe(FLEET_B);
  });

  it('breaks a full tie on the account id, so every load shows the same fleet', async () => {
    const sameInstant = '2026-09-20T14:00:00+00:00';
    seed(
      'corporate_accounts',
      account({ id: ACCOUNT_B, created_at: sameInstant }),
      account({ id: ACCOUNT_A, created_at: sameInstant }),
    );
    seed(
      'driver_fleets',
      fleet({ id: FLEET_B, corporate_account_id: ACCOUNT_B }),
      fleet({ id: FLEET_A, corporate_account_id: ACCOUNT_A }),
    );

    expect((await fleetService.getFleetByOwner(OWNER))?.fleet.id).toBe(FLEET_A);
  });

  it("does not return another user's fleet", async () => {
    seed('corporate_accounts', account({ created_by: OTHER_USER }));
    seed('driver_fleets', fleet({}));

    expect(await fleetService.getFleetByOwner(OWNER)).toBeNull();
  });

  it('lists the members in the order they were added', async () => {
    const first = member({ id: '00000000-0000-4000-8000-000000000201', added_at: '2026-09-20T14:00:02+00:00' });
    const second = member({ id: '00000000-0000-4000-8000-000000000202', added_at: '2026-09-20T14:05:00+00:00' });
    seed('corporate_accounts', account({}));
    seed('driver_fleets', fleet({}));
    seed('fleet_members', second, first);

    expect((await fleetService.getFleetByOwner(OWNER))?.members).toEqual([first, second]);
  });

  describe('when a lookup fails', () => {
    beforeEach(() => {
      seed('corporate_accounts', account({ status: 'approved', is_fleet_owner: true }));
      seed('driver_fleets', fleet({}));
      seed('fleet_members', member({}));
    });

    it('throws instead of reporting no fleet when the accounts cannot be read', async () => {
      failures.corporate_accounts = CONNECTION_LOST;
      await expect(fleetService.getFleetByOwner(OWNER)).rejects.toThrow('connection failure');
    });

    it('throws instead of reporting no fleet when the fleets cannot be read', async () => {
      failures.driver_fleets = CONNECTION_LOST;
      await expect(fleetService.getFleetByOwner(OWNER)).rejects.toThrow('connection failure');
    });

    it('throws instead of showing an empty driver list when the members cannot be read', async () => {
      failures.fleet_members = CONNECTION_LOST;
      await expect(fleetService.getFleetByOwner(OWNER)).rejects.toThrow('connection failure');
    });
  });
});

describe('fleetService.submitFleetRequest', () => {
  const request = {
    corporate_account_id: ACCOUNT_A,
    name: 'TaxiHabana',
    vehicle_count_estimate: 12,
    vehicle_types: ['triciclo_basico'],
    operating_zones: ['Vedado'],
    members: [{ driver_name: 'Yoel Pérez', driver_phone: '+5351234567' }],
  };

  beforeEach(() => {
    seed('corporate_accounts', account({}));
  });

  it('creates the fleet on the account and its drivers pending review', async () => {
    const { fleet_id } = await fleetService.submitFleetRequest(request);

    expect(db.driver_fleets).toEqual([
      expect.objectContaining({ id: fleet_id, corporate_account_id: ACCOUNT_A, name: 'TaxiHabana', vehicle_count_estimate: 12 }),
    ]);
    expect(db.fleet_members).toEqual([
      expect.objectContaining({ fleet_id, driver_name: 'Yoel Pérez', driver_phone: '+5351234567', status: 'pending_review' }),
    ]);
  });

  it('reuses the fleet a failed attempt left on the account instead of failing on its unique key', async () => {
    // A previous attempt created the fleet, then failed to save the drivers.
    seed('driver_fleets', fleet({ id: FLEET_A, name: 'Taxi Habana (borrador)', vehicle_count_estimate: 5 }));

    const { fleet_id } = await fleetService.submitFleetRequest(request);

    expect(fleet_id).toBe(FLEET_A);
    expect(db.driver_fleets).toEqual([
      expect.objectContaining({ id: FLEET_A, corporate_account_id: ACCOUNT_A, name: 'TaxiHabana', vehicle_count_estimate: 12 }),
    ]);
    expect(db.fleet_members).toEqual([expect.objectContaining({ fleet_id: FLEET_A, driver_phone: '+5351234567' })]);
  });

  it('adds only the drivers a previous attempt did not save, keeping the saved ones as they are', async () => {
    // The previous attempt saved the fleet and Yoel, then lost the response.
    const yoel = member({ driver_name: 'Yoel Pérez', driver_phone: '+5351234567' });
    seed('driver_fleets', fleet({}));
    seed('fleet_members', yoel);

    await fleetService.submitFleetRequest({
      ...request,
      members: [
        { driver_name: 'Yoel Pérez Díaz', driver_phone: '+5351234567' },
        { driver_name: 'Ana Díaz', driver_phone: '+5358765432' },
      ],
    });

    expect(db.fleet_members).toEqual([
      yoel,
      expect.objectContaining({ fleet_id: FLEET_A, driver_name: 'Ana Díaz', driver_phone: '+5358765432' }),
    ]);
  });

  it('saves a driver listed twice in one request once', async () => {
    await fleetService.submitFleetRequest({
      ...request,
      members: [
        { driver_name: 'Yoel Pérez', driver_phone: '+5351234567' },
        { driver_name: 'Yoel Pérez', driver_phone: '+5351234567' },
      ],
    });

    expect(db.fleet_members).toEqual([expect.objectContaining({ driver_phone: '+5351234567' })]);
  });

  it('throws when the drivers cannot be saved, so the form can retry on the same account', async () => {
    failures.fleet_members = CONNECTION_LOST;
    await expect(fleetService.submitFleetRequest(request)).rejects.toThrow('connection failure');
  });

  it('saves the city the owner typed on the fleet', async () => {
    await fleetService.submitFleetRequest({ ...request, city: 'La Habana' });

    expect(db.driver_fleets).toEqual([expect.objectContaining({ corporate_account_id: ACCOUNT_A, city: 'La Habana' })]);
  });

  it('replaces the city a failed attempt saved with the one of the retry', async () => {
    seed('driver_fleets', fleet({ id: FLEET_A, city: 'Matanzas' }));

    await fleetService.submitFleetRequest({ ...request, city: 'La Habana' });

    expect(db.driver_fleets).toEqual([expect.objectContaining({ id: FLEET_A, city: 'La Habana' })]);
  });

  it('stores no city when the request has none (an app built before the field was sent)', async () => {
    await fleetService.submitFleetRequest(request);

    expect(db.driver_fleets).toEqual([expect.objectContaining({ city: null })]);
  });

  describe('while 00602 is not applied (driver_fleets has no city column)', () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      missingColumns.driver_fleets = ['city'];
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it('saves the fleet and its drivers without the city instead of failing the request', async () => {
      const { fleet_id } = await fleetService.submitFleetRequest({ ...request, city: 'La Habana' });

      expect(db.driver_fleets).toEqual([expect.objectContaining({ id: fleet_id, name: 'TaxiHabana' })]);
      expect(db.driver_fleets[0]).not.toHaveProperty('city');
      expect(db.fleet_members).toEqual([expect.objectContaining({ fleet_id, driver_phone: '+5351234567' })]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('00602'));
    });

    it('still fails when the missing column is another one', async () => {
      missingColumns.driver_fleets = ['operating_zones'];

      await expect(fleetService.submitFleetRequest({ ...request, city: 'La Habana' })).rejects.toThrow(
        "Could not find the 'operating_zones' column",
      );
      expect(db.driver_fleets).toEqual([]);
    });
  });
});

describe('fleetService.addMember', () => {
  const newDriver = { driver_name: 'Ana Díaz', driver_phone: '52345678' };

  beforeEach(() => {
    seed('corporate_accounts', account({ status: 'approved' }));
    seed('driver_fleets', fleet({}));
  });

  it('adds the driver to the fleet pending review, with the number in full', async () => {
    await fleetService.addMember(FLEET_A, {
      ...newDriver,
      driver_email: 'ana@example.com',
      driver_license_number: 'L-123',
      driver_id_number: '90010112345',
    });

    expect(db.fleet_members).toHaveLength(1);
    expect(db.fleet_members[0]).toMatchObject({
      fleet_id: FLEET_A,
      driver_name: 'Ana Díaz',
      driver_phone: '+5352345678',
      driver_email: 'ana@example.com',
      driver_license_number: 'L-123',
      driver_id_number: '90010112345',
      status: 'pending_review',
    });
  });

  it('stores null for the optional fields left out', async () => {
    await fleetService.addMember(FLEET_A, newDriver);

    expect(db.fleet_members[0]).toMatchObject({
      driver_email: null,
      driver_license_number: null,
      driver_id_number: null,
    });
  });

  it.each(['pending_review', 'approved', 'pending_signup', 'active'] as const)(
    'refuses a number already in the fleet as %s, leaving that driver as they are',
    async (status) => {
      const current = member({ driver_phone: '+5352345678', status });
      seed('fleet_members', current);

      await expect(fleetService.addMember(FLEET_A, newDriver)).rejects.toMatchObject({
        code: 'FLEET_MEMBER_EXISTS',
      });

      expect(db.fleet_members).toEqual([current]);
    },
  );

  it('recognizes the number when the request form saved it without the country code', async () => {
    // The request form keeps the number as typed, so 5234 5678 and +5352345678
    // are two rows for the unique key but one person.
    seed('fleet_members', member({ driver_phone: '5234 5678', status: 'active' }));

    await expect(
      fleetService.addMember(FLEET_A, { ...newDriver, driver_phone: '+53 5234 5678' }),
    ).rejects.toMatchObject({ code: 'FLEET_MEMBER_EXISTS' });

    expect(db.fleet_members).toHaveLength(1);
  });

  it.each(['rejected', 'inactive'] as const)(
    'invites again a driver whose invitation is %s, as a new one to review',
    async (status) => {
      seed(
        'fleet_members',
        member({
          id: 'old-invitation',
          driver_name: 'Ana Dias',
          driver_phone: '52345678',
          status,
          rejected_reason: 'Nombre mal escrito',
        }),
      );

      await fleetService.addMember(FLEET_A, newDriver);

      expect(db.fleet_members).toHaveLength(1);
      const [invited] = db.fleet_members;
      expect(invited).toMatchObject({
        driver_name: 'Ana Díaz',
        driver_phone: '+5352345678',
        status: 'pending_review',
      });
      expect(invited?.id).not.toBe('old-invitation');
      expect(invited?.rejected_reason).toBeUndefined();
    },
  );

  it('keeps the rejected invitation when it cannot be replaced', async () => {
    seed('fleet_members', member({ driver_phone: '52345678', status: 'rejected' }));
    writeFailures.fleet_members = CONNECTION_LOST;

    await expect(fleetService.addMember(FLEET_A, newDriver)).rejects.toThrow('connection failure');

    expect(db.fleet_members).toHaveLength(1);
    expect(db.fleet_members[0]).toMatchObject({ driver_phone: '52345678', status: 'rejected' });
  });

  it('keeps a driver an admin approved while the owner was inviting them again', async () => {
    seed('fleet_members', member({ driver_phone: '+5352345678', status: 'rejected' }));
    beforeWrite = () => {
      for (const row of db.fleet_members) row.status = 'approved';
    };

    await expect(fleetService.addMember(FLEET_A, newDriver)).rejects.toMatchObject({
      code: 'FLEET_MEMBER_EXISTS',
    });

    expect(db.fleet_members).toHaveLength(1);
    expect(db.fleet_members[0]).toMatchObject({ status: 'approved' });
  });

  it('leaves alone the drivers with another number', async () => {
    const other = member({ driver_phone: '+5351111111', status: 'rejected' });
    seed('fleet_members', other);

    await fleetService.addMember(FLEET_A, newDriver);

    expect(db.fleet_members).toHaveLength(2);
    expect(db.fleet_members).toContainEqual(other);
  });

  it('adds a driver who is in the fleet of another company', async () => {
    seed('driver_fleets', fleet({ id: FLEET_B, corporate_account_id: ACCOUNT_B }));
    const elsewhere = member({ fleet_id: FLEET_B, driver_phone: '+5352345678', status: 'active' });
    seed('fleet_members', elsewhere);

    await fleetService.addMember(FLEET_A, newDriver);

    expect(db.fleet_members).toHaveLength(2);
    expect(db.fleet_members).toContainEqual(elsewhere);
  });

  it('says the driver is already there when someone else saved the number first', async () => {
    writeFailures.fleet_members = queryError('23505', 'duplicate key value violates unique constraint');

    await expect(fleetService.addMember(FLEET_A, newDriver)).rejects.toMatchObject({
      code: 'FLEET_MEMBER_EXISTS',
    });
  });

  it('writes nothing when it cannot read who is in the fleet', async () => {
    seed('fleet_members', member({ driver_phone: '52345678', status: 'rejected' }));
    failures.fleet_members = CONNECTION_LOST;

    await expect(fleetService.addMember(FLEET_A, newDriver)).rejects.toThrow('connection failure');

    expect(db.fleet_members).toHaveLength(1);
  });

  it('throws when the driver cannot be saved', async () => {
    writeFailures.fleet_members = CONNECTION_LOST;

    await expect(fleetService.addMember(FLEET_A, newDriver)).rejects.toThrow('connection failure');
  });
});

describe('fleetService.getPendingMemberCounts', () => {
  const companyA = { id: ACCOUNT_A, status: 'approved' } as const;
  const companyB = { id: ACCOUNT_B, status: 'pending' } as const;

  beforeEach(() => {
    seed(
      'driver_fleets',
      fleet({ id: FLEET_A, corporate_account_id: ACCOUNT_A }),
      fleet({ id: FLEET_B, corporate_account_id: ACCOUNT_B }),
    );
  });

  it('counts the drivers waiting for review in each company', async () => {
    seed(
      'fleet_members',
      member({ id: 'a1', fleet_id: FLEET_A, driver_phone: '+5351111111' }),
      member({ id: 'a2', fleet_id: FLEET_A, driver_phone: '+5351111112' }),
      member({ id: 'b1', fleet_id: FLEET_B, driver_phone: '+5351111113' }),
    );

    const counts = await fleetService.getPendingMemberCounts([companyA, companyB]);

    expect(counts).toEqual(new Map([[ACCOUNT_A, 2], [ACCOUNT_B, 1]]));
  });

  it.each(['rejected', 'suspended'] as const)(
    'leaves out a %s company, whose pending drivers are no work for the team',
    async (status) => {
      seed('fleet_members', member({ fleet_id: FLEET_A, driver_phone: '+5351111111' }));

      expect(await fleetService.getPendingMemberCounts([{ id: ACCOUNT_A, status }])).toEqual(new Map());
    },
  );

  it('leaves out the drivers already reviewed', async () => {
    seed(
      'fleet_members',
      member({ id: 'a1', driver_phone: '+5351111111', status: 'approved' }),
      member({ id: 'a2', driver_phone: '+5351111112', status: 'rejected' }),
      member({ id: 'a3', driver_phone: '+5351111113', status: 'active' }),
    );

    expect(await fleetService.getPendingMemberCounts([companyA])).toEqual(new Map());
  });

  it('counts only the companies it was asked about', async () => {
    seed('fleet_members', member({ fleet_id: FLEET_B, driver_phone: '+5351111113' }));

    expect(await fleetService.getPendingMemberCounts([companyA])).toEqual(new Map());
  });

  it('answers an empty list without reading anything', async () => {
    failures.driver_fleets = CONNECTION_LOST;
    failures.fleet_members = CONNECTION_LOST;

    expect(await fleetService.getPendingMemberCounts([])).toEqual(new Map());
  });

  it.each(['driver_fleets', 'fleet_members'] as const)(
    'throws instead of reporting nothing to review when %s cannot be read',
    async (table) => {
      failures[table] = CONNECTION_LOST;

      await expect(fleetService.getPendingMemberCounts([companyA])).rejects.toThrow('connection failure');
    },
  );
});

describe('fleetService.getAccountIdsWithFleet', () => {
  it('returns the accounts that have a fleet row, a request sent from the app included', async () => {
    seed(
      'corporate_accounts',
      account({ id: ACCOUNT_A }),
      account({ id: ACCOUNT_B, name: 'Transportes Vedado' }),
    );
    seed('driver_fleets', fleet({ corporate_account_id: ACCOUNT_A }));

    expect(await fleetService.getAccountIdsWithFleet([ACCOUNT_A, ACCOUNT_B])).toEqual(new Set([ACCOUNT_A]));
  });

  it('answers an empty list without reading the fleets', async () => {
    failures.driver_fleets = CONNECTION_LOST;
    expect(await fleetService.getAccountIdsWithFleet([])).toEqual(new Set());
  });

  it('throws instead of reporting no fleet when the fleets cannot be read', async () => {
    seed('driver_fleets', fleet({}));
    failures.driver_fleets = CONNECTION_LOST;
    await expect(fleetService.getAccountIdsWithFleet([ACCOUNT_A])).rejects.toThrow('connection failure');
  });
});

describe('corporateService.approveAccount', () => {
  it('flags a fleet request sent from the app as fleet owner when it approves it', async () => {
    seed('corporate_accounts', account({}));
    seed('driver_fleets', fleet({}));

    await corporateService.approveAccount(ACCOUNT_A, ADMIN);

    expect(db.corporate_accounts).toEqual([
      expect.objectContaining({ id: ACCOUNT_A, status: 'approved', is_fleet_owner: true, approved_at: expect.any(String) }),
    ]);
    expect(db.admin_actions).toEqual([
      expect.objectContaining({ admin_id: ADMIN, action: 'approve_corporate', target_id: ACCOUNT_A }),
    ]);
  });

  it('approves a corporate client request without flagging it', async () => {
    seed('corporate_accounts', account({}));

    await corporateService.approveAccount(ACCOUNT_A, ADMIN);

    expect(db.corporate_accounts).toEqual([
      expect.objectContaining({ id: ACCOUNT_A, status: 'approved', is_fleet_owner: false }),
    ]);
  });

  it('keeps the flag of an account an admin flagged before it had a fleet row', async () => {
    seed('corporate_accounts', account({ is_fleet_owner: true }));

    await corporateService.approveAccount(ACCOUNT_A, ADMIN);

    expect(db.corporate_accounts).toEqual([
      expect.objectContaining({ id: ACCOUNT_A, status: 'approved', is_fleet_owner: true }),
    ]);
  });

  it('flags only the account it approves', async () => {
    seed('corporate_accounts', account({ id: ACCOUNT_A }), account({ id: ACCOUNT_B }));
    seed(
      'driver_fleets',
      fleet({ id: FLEET_A, corporate_account_id: ACCOUNT_A }),
      fleet({ id: FLEET_B, corporate_account_id: ACCOUNT_B }),
    );

    await corporateService.approveAccount(ACCOUNT_A, ADMIN);

    expect(db.corporate_accounts).toEqual([
      expect.objectContaining({ id: ACCOUNT_A, status: 'approved', is_fleet_owner: true }),
      expect.objectContaining({ id: ACCOUNT_B, status: 'pending', is_fleet_owner: false }),
    ]);
  });

  it('approves nothing when it cannot tell whether the account has a fleet', async () => {
    seed('corporate_accounts', account({}));
    seed('driver_fleets', fleet({}));
    failures.driver_fleets = CONNECTION_LOST;

    await expect(corporateService.approveAccount(ACCOUNT_A, ADMIN)).rejects.toThrow('connection failure');
    expect(db.corporate_accounts).toEqual([
      expect.objectContaining({ id: ACCOUNT_A, status: 'pending', is_fleet_owner: false }),
    ]);
    expect(db.admin_actions).toEqual([]);
  });
});

describe('corporateService.getRequestStatus', () => {
  // A corporate client request (client app or web) is an account with no fleet.
  const clientRequest = (overrides: Row) =>
    account({ id: ACCOUNT_B, name: 'Hotel Vedado', status: 'rejected', ...overrides });

  it('returns null when the only request is a fleet request sent from the app', async () => {
    seed('corporate_accounts', account({}));
    seed('driver_fleets', fleet({}));

    expect(await corporateService.getRequestStatus(OWNER)).toBeNull();
  });

  it('returns the corporate client request, skipping a newer fleet request', async () => {
    seed(
      'corporate_accounts',
      account({ id: ACCOUNT_A, created_at: '2026-09-21T14:00:00+00:00' }),
      clientRequest({ created_at: '2026-09-20T14:00:00+00:00' }),
    );
    seed('driver_fleets', fleet({ corporate_account_id: ACCOUNT_A }));

    expect((await corporateService.getRequestStatus(OWNER))?.id).toBe(ACCOUNT_B);
  });

  it('skips an account an admin flagged as fleet owner', async () => {
    seed('corporate_accounts', account({ status: 'approved', is_fleet_owner: true }));

    expect(await corporateService.getRequestStatus(OWNER)).toBeNull();
  });

  it('returns the newest of two corporate client requests', async () => {
    seed(
      'corporate_accounts',
      clientRequest({ id: ACCOUNT_B, created_at: '2026-09-20T14:00:00+00:00' }),
      clientRequest({ id: ACCOUNT_C, status: 'pending', created_at: '2026-09-22T14:00:00+00:00' }),
    );

    expect((await corporateService.getRequestStatus(OWNER))?.id).toBe(ACCOUNT_C);
  });

  it('breaks a tie on the account id, so every load shows the same request', async () => {
    const sameInstant = '2026-09-20T14:00:00+00:00';
    seed(
      'corporate_accounts',
      clientRequest({ id: ACCOUNT_C, created_at: sameInstant }),
      clientRequest({ id: ACCOUNT_B, created_at: sameInstant }),
    );

    expect((await corporateService.getRequestStatus(OWNER))?.id).toBe(ACCOUNT_B);
  });

  it('returns null instead of a fleet request when the fleets cannot be read', async () => {
    seed('corporate_accounts', account({}));
    seed('driver_fleets', fleet({}));
    failures.driver_fleets = CONNECTION_LOST;

    expect(await corporateService.getRequestStatus(OWNER)).toBeNull();
  });

  it('returns null when the accounts cannot be read', async () => {
    seed('corporate_accounts', clientRequest({}));
    failures.corporate_accounts = CONNECTION_LOST;

    expect(await corporateService.getRequestStatus(OWNER)).toBeNull();
  });
});

describe('fleetService.addMember (id)', () => {
  it('returns the id of the invitation it created', async () => {
    seed('driver_fleets', fleet({}));

    const created = await fleetService.addMember(FLEET_A, { driver_name: 'Ana Gil', driver_phone: '+5352345678' });

    expect(created).toEqual({ id: 'generated-1' });
    expect(db.fleet_members[0]).toMatchObject({ id: 'generated-1', driver_name: 'Ana Gil' });
  });
});

describe('fleetService.removeMember', () => {
  it('deletes the invitation', async () => {
    seed('fleet_members', member({ id: 'm1' }));

    await fleetService.removeMember('m1');

    expect(db.fleet_members).toEqual([]);
  });

  it('throws FLEET_MEMBER_NOT_REMOVED when RLS hid the row and nothing was deleted', async () => {
    await expect(fleetService.removeMember('m-gone')).rejects.toMatchObject({ code: 'FLEET_MEMBER_NOT_REMOVED' });
  });

  it('throws when the delete fails', async () => {
    seed('fleet_members', member({ id: 'm1' }));
    writeFailures.fleet_members = CONNECTION_LOST;

    await expect(fleetService.removeMember('m1')).rejects.toThrow('connection failure');
  });
});

describe('fleetService.reinviteMember', () => {
  it('invites the same person again, replacing the rejected row, and returns the new id', async () => {
    const rejected = member({
      id: 'm1',
      status: 'rejected',
      driver_phone: '+5351234567',
      driver_email: 'yoel@example.com',
      driver_license_number: 'L-1',
      driver_id_number: '90010112345',
    });
    seed('driver_fleets', fleet({}));
    seed('fleet_members', rejected);

    const created = await fleetService.reinviteMember(rejected);

    expect(created).toEqual({ id: 'generated-1' });
    expect(db.fleet_members).toHaveLength(1);
    expect(db.fleet_members[0]).toMatchObject({
      fleet_id: FLEET_A,
      driver_name: 'Yoel Pérez',
      driver_email: 'yoel@example.com',
      driver_license_number: 'L-1',
      driver_id_number: '90010112345',
      status: 'pending_review',
    });
  });

  it('refuses a number that still holds a place in the fleet', async () => {
    const pending = member({ id: 'm1', status: 'pending_review' });
    seed('fleet_members', pending);

    await expect(fleetService.reinviteMember(pending)).rejects.toMatchObject({ code: 'FLEET_MEMBER_EXISTS' });
  });
});

describe('fleetService.updateFleet', () => {
  const target = { id: FLEET_A, corporate_account_id: ACCOUNT_A };

  beforeEach(() => {
    seed('corporate_accounts', account({ name: 'Razón social' }));
    seed('driver_fleets', fleet({ name: 'TaxiHabana' }));
  });

  it('writes the details to driver_fleets', async () => {
    await fleetService.updateFleet(target, { city: 'Santiago', vehicle_count_estimate: 20, notes: 'Turnos de noche' });

    expect(db.driver_fleets[0]).toMatchObject({ city: 'Santiago', vehicle_count_estimate: 20, notes: 'Turnos de noche' });
  });

  it('never writes the id or the corporate account of the fleet', async () => {
    await fleetService.updateFleet(target, {
      city: 'Santiago',
      id: 'other',
      corporate_account_id: ACCOUNT_B,
    } as never);

    expect(db.driver_fleets[0]).toMatchObject({ id: FLEET_A, corporate_account_id: ACCOUNT_A });
  });

  it('renames the corporate account too when the name changed', async () => {
    await fleetService.updateFleet(target, { name: 'Taxis del Vedado' });

    expect(db.driver_fleets[0]).toMatchObject({ name: 'Taxis del Vedado' });
    expect(db.corporate_accounts[0]).toMatchObject({ name: 'Taxis del Vedado' });
  });

  it('leaves the account alone when the name is the same or not in the patch', async () => {
    await fleetService.updateFleet(target, { name: 'TaxiHabana', city: 'Santiago' });
    await fleetService.updateFleet(target, { notes: 'x' });

    expect(db.corporate_accounts[0]).toMatchObject({ name: 'Razón social' });
  });

  it('throws FLEET_NOT_UPDATED when RLS hid the fleet and 0 rows changed', async () => {
    await expect(
      fleetService.updateFleet({ id: 'fleet-of-someone-else', corporate_account_id: ACCOUNT_B }, { city: 'Santiago' }),
    ).rejects.toMatchObject({ code: 'FLEET_NOT_UPDATED' });
  });

  it('throws FLEET_NOT_UPDATED when the account rename changed 0 rows', async () => {
    db.corporate_accounts = [];

    await expect(fleetService.updateFleet(target, { name: 'Taxis del Vedado' })).rejects.toMatchObject({
      code: 'FLEET_NOT_UPDATED',
    });
  });

  it('throws when the fleet write fails', async () => {
    writeFailures.driver_fleets = CONNECTION_LOST;

    await expect(fleetService.updateFleet(target, { city: 'Santiago' })).rejects.toThrow('connection failure');
  });

  it('throws when the current fleet cannot be read', async () => {
    failures.driver_fleets = CONNECTION_LOST;

    await expect(fleetService.updateFleet(target, { name: 'Otro' })).rejects.toThrow('connection failure');
  });
});

describe('fleetService.uploadMemberLicenseFromUri', () => {
  const params = {
    fleet_member_id: 'm1',
    corporate_account_id: ACCOUNT_A,
    uri: 'file:///cache/licencia.jpg',
    file_name: 'licencia.jpg',
    mime_type: 'image/jpeg',
  };

  beforeEach(() => {
    seed('fleet_members', member({ id: 'm1' }));
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  });
  afterEach(() => vi.restoreAllMocks());

  const PATH = `fleet-docs/${ACCOUNT_A}/m1/1700000000000-licencia.jpg`;

  it('uploads once, under a name of its own and without upsert, and saves the path', async () => {
    uploadFileFromUri.mockResolvedValue(undefined);

    expect(await fleetService.uploadMemberLicenseFromUri(params)).toEqual({ storage_path: PATH });

    expect(uploadFileFromUri).toHaveBeenCalledWith('driver-documents', PATH, params.uri, {
      fileName: 'licencia.jpg',
      mimeType: 'image/jpeg',
      upsert: false,
    });
    expect(db.fleet_members[0]).toMatchObject({ license_doc_path: PATH });
  });

  it('counts the 409 of a retry whose first attempt landed as success', async () => {
    // storage-upload answers { error: 'upload_failed', reason } with the 409 of Storage.
    uploadFileFromUri.mockRejectedValue(new Error('upload_failed: The resource already exists'));

    expect(await fleetService.uploadMemberLicenseFromUri(params)).toEqual({ storage_path: PATH });
    expect(db.fleet_members[0]).toMatchObject({ license_doc_path: PATH });
  });

  it('turns member_reviewed (also a 409) into FLEET_MEMBER_REVIEWED and saves nothing', async () => {
    uploadFileFromUri.mockRejectedValue(new Error('member_reviewed'));

    await expect(fleetService.uploadMemberLicenseFromUri(params)).rejects.toMatchObject({
      code: 'FLEET_MEMBER_REVIEWED',
    });
    expect(db.fleet_members[0]).toMatchObject({ license_doc_path: null });
  });

  it('rethrows any other upload failure', async () => {
    uploadFileFromUri.mockRejectedValue(new Error('forbidden'));

    await expect(fleetService.uploadMemberLicenseFromUri(params)).rejects.toThrow('forbidden');
    expect(db.fleet_members[0]).toMatchObject({ license_doc_path: null });
  });

  it('throws when saving the path changed 0 rows, so it is not taken for a success', async () => {
    uploadFileFromUri.mockResolvedValue(undefined);
    db.fleet_members = [];

    await expect(fleetService.uploadMemberLicenseFromUri(params)).rejects.toMatchObject({
      code: 'FLEET_LICENSE_NOT_SAVED',
    });
  });

  it('throws when saving the path fails', async () => {
    uploadFileFromUri.mockResolvedValue(undefined);
    writeFailures.fleet_members = CONNECTION_LOST;

    await expect(fleetService.uploadMemberLicenseFromUri(params)).rejects.toThrow('connection failure');
  });
});

describe('fleetService.getMemberLicenseUrl', () => {
  it('signs the path for 5 minutes in the driver-documents bucket', async () => {
    expect(await fleetService.getMemberLicenseUrl('fleet-docs/a/b/c.jpg')).toBe('https://signed.example/doc');
    expect(signedUrlCalls).toEqual([{ bucket: 'driver-documents', path: 'fleet-docs/a/b/c.jpg', seconds: 300 }]);
  });

  it('throws when Storage cannot sign it', async () => {
    signedUrlResult = { data: null, error: { message: 'Object not found' } };

    await expect(fleetService.getMemberLicenseUrl('fleet-docs/a/b/c.jpg')).rejects.toThrow('Object not found');
  });
});

describe('fleetService.getInviteSends', () => {
  const send = (overrides: Row): Row => ({
    id: 1,
    fleet_id: FLEET_A,
    phone: '+5351234567',
    member_id: 'm1',
    channel: 'sms',
    source: 'review',
    sent_at: '2026-11-01T10:00:00+00:00',
    ...overrides,
  });

  it('lists the sends of the fleet, newest first', async () => {
    seed(
      'fleet_invite_sends',
      send({ id: 1, sent_at: '2026-11-01T10:00:00+00:00' }),
      send({ id: 2, sent_at: '2026-11-02T10:00:00+00:00', source: 'resend' }),
      send({ id: 3, fleet_id: FLEET_B }),
    );

    expect((await fleetService.getInviteSends(FLEET_A)).map((s) => s.id)).toEqual([2, 1]);
  });

  it.each([['PGRST205'], ['42P01']])('returns [] while the table does not exist (%s)', async (code) => {
    failures.fleet_invite_sends = queryError(code, 'relation does not exist');

    expect(await fleetService.getInviteSends(FLEET_A)).toEqual([]);
  });

  it('throws on any other error, so a failed read is not taken for "nothing sent"', async () => {
    failures.fleet_invite_sends = CONNECTION_LOST;

    await expect(fleetService.getInviteSends(FLEET_A)).rejects.toThrow('connection failure');
  });
});

describe('fleetService.resendInvite', () => {
  it('calls resend_fleet_invite and resolves on success', async () => {
    rpcResults.resend_fleet_invite = { data: { success: true }, error: null };

    await expect(fleetService.resendInvite('m1')).resolves.toBeUndefined();
    expect(rpcCalls).toEqual([{ fn: 'resend_fleet_invite', args: { p_member_id: 'm1' } }]);
  });

  it('turns too_soon into FLEET_INVITE_TOO_SOON and keeps retry_at', async () => {
    rpcResults.resend_fleet_invite = {
      data: { error: 'too_soon', retry_at: '2026-11-07T10:00:00+00:00' },
      error: null,
    };

    await expect(fleetService.resendInvite('m1')).rejects.toMatchObject({
      code: 'FLEET_INVITE_TOO_SOON',
      details: { retry_at: '2026-11-07T10:00:00+00:00' },
    });
  });

  it('turns limit_reached into FLEET_INVITE_LIMIT', async () => {
    rpcResults.resend_fleet_invite = { data: { error: 'limit_reached' }, error: null };

    await expect(fleetService.resendInvite('m1')).rejects.toMatchObject({ code: 'FLEET_INVITE_LIMIT' });
  });

  it.each([['forbidden'], ['not_found'], ['not_invitable'], ['send_failed']])(
    'turns %s into FLEET_INVITE_FAILED',
    async (reason) => {
      rpcResults.resend_fleet_invite = { data: { error: reason }, error: null };

      await expect(fleetService.resendInvite('m1')).rejects.toMatchObject({
        code: 'FLEET_INVITE_FAILED',
        details: { reason },
      });
    },
  );

  it('turns a failed call (or a missing function) into FLEET_INVITE_FAILED', async () => {
    rpcResults.resend_fleet_invite = { data: null, error: CONNECTION_LOST };

    await expect(fleetService.resendInvite('m1')).rejects.toMatchObject({ code: 'FLEET_INVITE_FAILED' });
  });
});

describe('fleetService.leaveFleet', () => {
  it('calls leave_fleet and resolves on success', async () => {
    rpcResults.leave_fleet = { data: { success: true }, error: null };

    await expect(fleetService.leaveFleet('m1')).resolves.toBeUndefined();
    expect(rpcCalls).toEqual([{ fn: 'leave_fleet', args: { p_member_id: 'm1' } }]);
  });

  it.each([['forbidden'], ['not_found'], ['not_active']])('turns %s into FLEET_LEAVE_FAILED', async (reason) => {
    rpcResults.leave_fleet = { data: { error: reason }, error: null };

    await expect(fleetService.leaveFleet('m1')).rejects.toMatchObject({
      code: 'FLEET_LEAVE_FAILED',
      details: { reason },
    });
  });

  it('turns a failed call into FLEET_LEAVE_FAILED', async () => {
    rpcResults.leave_fleet = { data: null, error: CONNECTION_LOST };

    await expect(fleetService.leaveFleet('m1')).rejects.toMatchObject({ code: 'FLEET_LEAVE_FAILED' });
  });
});

describe('fleetService.getMyMemberships', () => {
  const row = {
    member_id: 'm1',
    fleet_id: FLEET_A,
    fleet_name: 'TaxiHabana',
    owner_label: 'Juan P.',
    status: 'active',
    driver_name: 'Yoel Pérez',
    driver_phone: '+5351234567',
    signed_up_at: '2026-10-01T10:00:00+00:00',
  };

  it('returns what get_my_fleet_memberships answers', async () => {
    rpcResults.get_my_fleet_memberships = { data: [row], error: null };

    expect(await fleetService.getMyMemberships()).toEqual([row]);
  });

  it('answers an empty list as an empty list', async () => {
    rpcResults.get_my_fleet_memberships = { data: null, error: null };

    expect(await fleetService.getMyMemberships()).toEqual([]);
  });

  it('falls back to the table read of the session user while the function is missing (PGRST202)', async () => {
    sessionUserId = OTHER_USER;
    seed(
      'fleet_members',
      member({
        id: 'm1',
        driver_id: OTHER_USER,
        status: 'active',
        signed_up_at: '2026-10-01T10:00:00+00:00',
      }),
    );

    expect(await fleetService.getMyMemberships()).toEqual([
      {
        member_id: 'm1',
        fleet_id: FLEET_A,
        fleet_name: null,
        owner_label: null,
        status: 'active',
        driver_name: 'Yoel Pérez',
        driver_phone: '+5351234567',
        signed_up_at: '2026-10-01T10:00:00+00:00',
      },
    ]);
  });

  it('throws AUTH_ERROR on the fallback when there is no session', async () => {
    await expect(fleetService.getMyMemberships()).rejects.toMatchObject({ code: 'AUTH_ERROR' });
  });

  it('throws any other error, so a failed read is not taken for "no fleet"', async () => {
    rpcResults.get_my_fleet_memberships = { data: null, error: CONNECTION_LOST };

    await expect(fleetService.getMyMemberships()).rejects.toThrow('connection failure');
  });
});
