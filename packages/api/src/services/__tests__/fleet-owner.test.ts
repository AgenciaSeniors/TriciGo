import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DriverFleet, FleetMember } from '@tricigo/types';

// In-memory stand-in for corporate_accounts, driver_fleets and fleet_members.
// It follows postgrest-js 2.99.1 and the live schema on the points this suite
// depends on:
//  - awaiting a read resolves every row that passes the eq/in filters, sorted
//    by the ORDER BY calls;
//  - maybeSingle() over two or more rows resolves (does not throw) to error
//    PGRST116 with data null, and single() does the same over zero rows;
//  - driver_fleets is UNIQUE (corporate_account_id) and fleet_members is
//    UNIQUE (fleet_id, driver_phone). A statement is atomic: an insert that
//    hits a key, even one written earlier in the same statement, fails with
//    23505 and writes nothing;
//  - an upsert targets its onConflict columns, or the primary key when there
//    are none (as PostgREST does), and fails with 42P10 on columns without a
//    unique key. On a conflict it updates the existing row, or skips it with
//    ignoreDuplicates (also within the statement). A merge upsert that hits
//    the same key twice in one statement, which Postgres rejects, is not
//    modelled.
// RLS is not emulated: the service filters by created_by itself.
type Table = 'corporate_accounts' | 'driver_fleets' | 'fleet_members';
type Row = Record<string, unknown>;
type QueryError = { code: string; message: string; details: string | null; hint: string | null };
type Result = { data: unknown; error: QueryError | null };

// Unique keys besides the primary key (id), as in the live schema.
const UNIQUE_KEYS: Record<Table, string[][]> = {
  corporate_accounts: [],
  driver_fleets: [['corporate_account_id']],
  fleet_members: [['fleet_id', 'driver_phone']],
};

let db: Record<Table, Row[]> = { corporate_accounts: [], driver_fleets: [], fleet_members: [] };
let failures: Partial<Record<Table, QueryError>> = {};
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

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  const orderBy: Array<{ column: string; ascending: boolean }> = [];
  let write: (() => Result) | null = null;

  const run = (): Result => {
    const failure = failures[table as Table];
    if (failure) return { data: null, error: failure };
    if (write) return write();
    const rows = rowsOf(table).filter((row) => filters.every((keep) => keep(row)));
    rows.sort((a, b) => {
      for (const { column, ascending } of orderBy) {
        const x = String(a[column]);
        const y = String(b[column]);
        if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
      }
      return 0;
    });
    return { data: rows.map((row) => ({ ...row })), error: null };
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
    select: () => builder,
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
    insert: (rows: Row | Row[]) => {
      write = () => insertRows(table, rows);
      return builder;
    },
    upsert: (rows: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      write = () => upsertRows(table, rows, options ?? {});
      return builder;
    },
    single: () => Promise.resolve(one(false)),
    maybeSingle: () => Promise.resolve(one(true)),
    then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return builder;
}

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ from: (table: string) => query(table) }),
}));

// Import after the mock is set up.
import { fleetService } from '../fleet.service';

const OWNER = '00000000-0000-4000-8000-000000000011';
const OTHER_USER = '00000000-0000-4000-8000-000000000012';
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
  db = { corporate_accounts: [], driver_fleets: [], fleet_members: [] };
  failures = {};
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
      account: { id: ACCOUNT_A, name: 'TaxiHabana', status: 'pending', commission_percent: null },
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
});
