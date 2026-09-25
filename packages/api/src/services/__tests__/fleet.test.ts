import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FleetMember } from '@tricigo/types';

// Stand-in for the fleet_members query builder. It follows postgrest-js 2.99.1
// on the point this suite is about: awaiting the builder resolves to every row,
// while maybeSingle() over two or more rows resolves (does not throw) to error
// PGRST116 with data null. `rows` is what PostgREST returns for the query: the
// filters and ORDER BY are asserted on the calls, not re-implemented here.
type QueryError = { code: string; message: string; details: string | null; hint: string | null };

let rows: FleetMember[] = [];
let queryError: QueryError | null = null;
const calls = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), order: vi.fn() };

function fleetMembersQuery() {
  const builder = {
    select: (...args: unknown[]) => { calls.select(...args); return builder; },
    eq: (...args: unknown[]) => { calls.eq(...args); return builder; },
    in: (...args: unknown[]) => { calls.in(...args); return builder; },
    order: (...args: unknown[]) => { calls.order(...args); return builder; },
    maybeSingle: () => {
      if (queryError) return Promise.resolve({ data: null, error: queryError });
      if (rows.length > 1) {
        return Promise.resolve({
          data: null,
          error: {
            code: 'PGRST116',
            details: `Results contain ${rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
            hint: null,
            message: 'JSON object requested, multiple (or no) rows returned',
          },
        });
      }
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(queryError ? { data: null, error: queryError } : { data: rows, error: null })
        .then(resolve, reject),
  };
  return builder;
}

const mockFrom = vi.fn((_table: string) => fleetMembersQuery());

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ from: mockFrom }),
}));

// Import after the mock is set up.
import { fleetService } from '../fleet.service';

const DRIVER = '00000000-0000-4000-8000-000000000011';
const FLEET_A = '00000000-0000-4000-8000-0000000001a1';
const FLEET_B = '00000000-0000-4000-8000-0000000001b1';
const MEMBER_1 = '00000000-0000-4000-8000-000000000201';
const MEMBER_2 = '00000000-0000-4000-8000-000000000202';

function member(overrides: Partial<FleetMember>): FleetMember {
  return {
    id: MEMBER_1,
    fleet_id: FLEET_A,
    driver_id: DRIVER,
    driver_name: 'Yoel Pérez',
    driver_phone: '+5351234567',
    driver_email: null,
    driver_license_number: null,
    driver_id_number: null,
    status: 'active',
    license_doc_path: null,
    added_at: '2026-09-01T14:00:00.000000+00:00',
    reviewed_at: '2026-09-02T14:00:00.000000+00:00',
    reviewed_by: '00000000-0000-4000-8000-000000000061',
    rejected_reason: null,
    signed_up_at: '2026-09-03T14:00:00.000000+00:00',
    ...overrides,
  };
}

beforeEach(() => {
  rows = [];
  queryError = null;
  vi.clearAllMocks();
});

describe('fleetService.getMembershipsForDriver', () => {
  it('returns an empty list for a driver in no fleet', async () => {
    expect(await fleetService.getMembershipsForDriver(DRIVER)).toEqual([]);
  });

  it('returns the membership of a driver in one fleet', async () => {
    const a = member({ id: MEMBER_1, fleet_id: FLEET_A });
    rows = [a];
    expect(await fleetService.getMembershipsForDriver(DRIVER)).toEqual([a]);
  });

  it('returns both memberships of a driver in two fleets', async () => {
    const a = member({ id: MEMBER_1, fleet_id: FLEET_A, signed_up_at: '2026-09-20T14:00:00+00:00' });
    const b = member({ id: MEMBER_2, fleet_id: FLEET_B, signed_up_at: '2026-09-10T14:00:00+00:00' });
    rows = [a, b];
    expect(await fleetService.getMembershipsForDriver(DRIVER)).toEqual([a, b]);
  });

  it('lists a fleet once when it holds the number in two formats', async () => {
    // One signup links both rows: same fleet, same status, same signed_up_at.
    const plus = member({ id: MEMBER_1, driver_phone: '+5351234567' });
    const bare = member({ id: MEMBER_2, driver_phone: '51234567' });
    rows = [plus, bare];
    expect(await fleetService.getMembershipsForDriver(DRIVER)).toEqual([plus]);
  });

  it('shows a fleet through its active row when another row of it is only approved', async () => {
    const approved = member({ id: MEMBER_1, status: 'approved', signed_up_at: '2026-09-20T14:00:00+00:00' });
    const active = member({ id: MEMBER_2, status: 'active', signed_up_at: '2026-09-10T14:00:00+00:00' });
    rows = [approved, active];
    expect(await fleetService.getMembershipsForDriver(DRIVER)).toEqual([active]);
  });

  it('lists the fleets where the driver is active before the pending ones', async () => {
    const pendingB = member({ id: MEMBER_1, fleet_id: FLEET_B, status: 'approved', signed_up_at: '2026-09-20T14:00:00+00:00' });
    const activeA = member({ id: MEMBER_2, fleet_id: FLEET_A, status: 'active', signed_up_at: '2026-09-10T14:00:00+00:00' });
    rows = [pendingB, activeA];
    expect(await fleetService.getMembershipsForDriver(DRIVER)).toEqual([activeA, pendingB]);
  });

  it("asks for the driver's active or approved rows, latest signup first", async () => {
    await fleetService.getMembershipsForDriver(DRIVER);
    expect(mockFrom).toHaveBeenCalledWith('fleet_members');
    // The member card reads driver_name, driver_phone and status.
    expect(calls.select).toHaveBeenCalledWith('*');
    expect(calls.eq).toHaveBeenCalledWith('driver_id', DRIVER);
    expect(calls.in).toHaveBeenCalledWith('status', ['active', 'approved']);
    expect(calls.order.mock.calls).toEqual([
      ['signed_up_at', { ascending: false, nullsFirst: false }],
      ['added_at', { ascending: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('throws when the lookup fails instead of reporting no fleet', async () => {
    queryError = { code: '08006', message: 'connection failure', details: null, hint: null };
    await expect(fleetService.getMembershipsForDriver(DRIVER)).rejects.toThrow('connection failure');
  });
});
