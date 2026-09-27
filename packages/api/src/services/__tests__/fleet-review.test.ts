import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FleetMember } from '@tricigo/types';

// In-memory fleet_members that follows PostgREST and postgrest-js 2.99.1 on
// the points the admin review depends on:
//  - eq(col, v) sends `col=eq.<v as text>`: it matches the column's value as
//    text and never a NULL column (eq(col, null) compares against "null");
//  - is(col, null) matches a NULL column;
//  - an update applies to every row that passes all the filters at once, as
//    one statement does; without select() it resolves data null, with it the
//    updated rows, [] when the filters matched none.
// RLS and the protect trigger are not emulated: an admin passes both. The
// admin's session is what auth.getSession() resolves.
// supabase/tests/fleet-review/run.sh runs the same updates against the live
// policies and trigger, concurrent owner edits included.
type Row = Record<string, unknown>;
type QueryError = { code: string; message: string; details: string | null; hint: string | null };
type Result = { data: unknown; error: QueryError | null };

let members: Row[] = [];
let failure: QueryError | null = null;
let session: { access_token: string } | null = null;

function query(table: string) {
  if (table !== 'fleet_members') throw new Error(`The test double has no table ${table}`);
  const filters: Array<(row: Row) => boolean> = [];
  let patch: Row | null = null;
  let returning = false;

  const run = (): Result => {
    if (failure) return { data: null, error: failure };
    if (!patch) throw new Error('The test double only models updates');
    const matched = members.filter((row) => filters.every((keep) => keep(row)));
    for (const row of matched) Object.assign(row, patch);
    return { data: returning ? matched.map((row) => ({ ...row })) : null, error: null };
  };

  const builder = {
    update: (values: Row) => {
      patch = values;
      return builder;
    },
    select: () => {
      returning = true;
      return builder;
    },
    eq: (column: string, value: unknown) => {
      filters.push((row) => row[column] !== null && row[column] !== undefined && String(row[column]) === String(value));
      return builder;
    },
    is: (column: string, value: unknown) => {
      if (value !== null) throw new Error('The test double only models is(column, null)');
      filters.push((row) => row[column] === null);
      return builder;
    },
    then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return builder;
}

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => query(table),
    auth: { getSession: () => Promise.resolve({ data: { session }, error: null }) },
  }),
}));

// Import after the mock is set up.
import { fleetService } from '../fleet.service';
import { AppError, AuthError } from '../../errors';

const ADMIN = '00000000-0000-4000-8000-000000000061';
const OTHER_ADMIN = '00000000-0000-4000-8000-000000000062';
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const MEMBER = '00000000-0000-4000-8000-000000000201';
const FLEET = '00000000-0000-4000-8000-0000000001a1';
const OTHER_FLEET = '00000000-0000-4000-8000-0000000001b1';
const LICENSE_DOC = `fleet-docs/${ACCOUNT}/${MEMBER}/licencia.jpg`;
const CONNECTION_LOST: QueryError = { code: '08006', message: 'connection failure', details: null, hint: null };

// Every optional column the owner can fill in.
const FILLED: Partial<FleetMember> = {
  driver_email: 'yoel@correo.cu',
  driver_license_number: 'B1234567',
  driver_id_number: '85010112345',
  license_doc_path: LICENSE_DOC,
};

// [what the owner did, the invitation as the admin saw it, the owner's edit afterwards].
// One row per reviewed column; the optional ones both ways, empty to filled and back.
const OWNER_EDITS: Array<[string, Partial<FleetMember>, Partial<FleetMember>]> = [
  ['changed the phone', {}, { driver_phone: '+5359999999' }],
  ['changed the name', {}, { driver_name: 'Yoel Pérez Díaz' }],
  ['moved it to another fleet', {}, { fleet_id: OTHER_FLEET }],
  ['added an email', {}, { driver_email: 'yoel@correo.cu' }],
  ['changed the email', FILLED, { driver_email: 'otro@correo.cu' }],
  ['removed the email', FILLED, { driver_email: null }],
  ['added a license number', {}, { driver_license_number: 'B1234567' }],
  ['removed the license number', FILLED, { driver_license_number: null }],
  ['added an identity card number', {}, { driver_id_number: '85010112345' }],
  ['removed the identity card number', FILLED, { driver_id_number: null }],
  ['uploaded a license document', {}, { license_doc_path: LICENSE_DOC }],
  ['saved the license document under another name', FILLED, { license_doc_path: `fleet-docs/${ACCOUNT}/${MEMBER}/otra.jpg` }],
  ['removed the license document', FILLED, { license_doc_path: null }],
];

// An invitation as the owner sends it: only the name and the phone filled.
function invitation(overrides: Partial<FleetMember> = {}): FleetMember {
  return {
    id: MEMBER,
    fleet_id: FLEET,
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

// FleetReview loads the row: this is what the admin sees and acts on.
function load(overrides: Partial<FleetMember> = {}): FleetMember {
  const row = invitation(overrides);
  members = [{ ...row }];
  return row;
}

// Someone writes to the invitation after the admin loaded it.
function change(patch: Partial<FleetMember>): void {
  const row = members[0];
  if (!row) throw new Error('No invitation to change');
  Object.assign(row, patch);
}

beforeEach(() => {
  members = [];
  failure = null;
  session = { access_token: 'admin-jwt' };
});

// The review must fail as a changed invitation and leave the row exactly as it was.
async function expectChanged(review: Promise<void>): Promise<void> {
  const before = members.map((row) => ({ ...row }));
  const error = await review.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code: 'FLEET_MEMBER_CHANGED', statusCode: 409 });
  expect(members).toEqual(before);
}

describe('fleetService.approveMember', () => {
  it('approves the invitation the admin saw', async () => {
    const shown = load();

    await fleetService.approveMember(shown, ADMIN);

    expect(members).toEqual([
      { ...shown, status: 'approved', reviewed_by: ADMIN, reviewed_at: expect.any(String) },
    ]);
  });

  it('approves an invitation with every optional column filled and unchanged', async () => {
    const shown = load(FILLED);

    await fleetService.approveMember(shown, ADMIN);

    expect(members).toEqual([
      { ...shown, status: 'approved', reviewed_by: ADMIN, reviewed_at: expect.any(String) },
    ]);
  });

  it.each(OWNER_EDITS)('does not approve the invitation after the owner %s', async (_what, seen, edit) => {
    const shown = load(seen);
    change(edit);

    await expectChanged(fleetService.approveMember(shown, ADMIN));
  });

  it('does not approve an invitation another admin reviewed meanwhile', async () => {
    const shown = load();
    change({
      status: 'rejected',
      reviewed_by: OTHER_ADMIN,
      reviewed_at: '2026-09-27T12:00:00+00:00',
      rejected_reason: 'Licencia vencida',
    });

    await expectChanged(fleetService.approveMember(shown, ADMIN));
  });

  it('does not approve an invitation the owner removed', async () => {
    const shown = load();
    members = [];

    await expectChanged(fleetService.approveMember(shown, ADMIN));
  });

  it('reports a failed update as a failure, not as a changed invitation', async () => {
    const shown = load();
    failure = CONNECTION_LOST;

    const error = await fleetService.approveMember(shown, ADMIN).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
    expect((error as Error).message).toContain('connection failure');
  });

  // Without a session the request goes out as anon, RLS hides the row and the
  // update matches nothing: that must not read as a changed invitation.
  it('writes nothing without a session and says so, instead of reporting a changed invitation', async () => {
    const shown = load();
    session = null;

    const error = await fleetService.approveMember(shown, ADMIN).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect(members).toEqual([shown]);
  });
});

describe('fleetService.rejectMember', () => {
  it('rejects the invitation the admin saw, with the reason for the owner', async () => {
    const shown = load();

    await fleetService.rejectMember(shown, ADMIN, 'Licencia vencida');

    expect(members).toEqual([
      {
        ...shown,
        status: 'rejected',
        reviewed_by: ADMIN,
        reviewed_at: expect.any(String),
        rejected_reason: 'Licencia vencida',
      },
    ]);
  });

  it('does not reject the invitation after the owner changed the phone', async () => {
    const shown = load();
    change({ driver_phone: '+5359999999' });

    await expectChanged(fleetService.rejectMember(shown, ADMIN, 'Licencia vencida'));
  });

  it('does not reject an invitation another admin approved meanwhile', async () => {
    const shown = load();
    change({ status: 'approved', reviewed_by: OTHER_ADMIN, reviewed_at: '2026-09-27T12:00:00+00:00' });

    await expectChanged(fleetService.rejectMember(shown, ADMIN, 'Licencia vencida'));
  });

  it('reports a failed update as a failure, not as a changed invitation', async () => {
    const shown = load();
    failure = CONNECTION_LOST;

    const error = await fleetService.rejectMember(shown, ADMIN, 'Licencia vencida').then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
    expect((error as Error).message).toContain('connection failure');
  });

  it('writes nothing without a session and says so, instead of reporting a changed invitation', async () => {
    const shown = load();
    session = null;

    const error = await fleetService.rejectMember(shown, ADMIN, 'Licencia vencida').then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect(members).toEqual([shown]);
  });
});
