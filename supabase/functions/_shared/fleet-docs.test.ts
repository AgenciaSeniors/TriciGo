import { describe, expect, it, vi } from 'vitest';
import {
  authorizeFleetDocUpload,
  storageUpsert,
  type FleetDocLookups,
  type FleetDocMember,
} from './fleet-docs';

const CORP = '00000000-0000-4000-8000-0000000000c1';
const OTHER_CORP = '00000000-0000-4000-8000-0000000000c2';
const MEMBER = '00000000-0000-4000-8000-000000000201';

// Every status a member can reach after the admin looks at it (00246 CHECK).
const REVIEWED = ['approved', 'rejected', 'pending_signup', 'active', 'inactive'];

// storage-upload answers these from the database with the service-role client.
// Here they are plain values, so each rule can be exercised on its own.
function lookups(opts: {
  member?: FleetDocMember | null;
  isAdmin?: boolean;
  managesAccount?: boolean;
}) {
  const member =
    opts.member === undefined ? { corporateAccountId: CORP, status: 'pending_review' } : opts.member;
  return {
    member: vi.fn(async (_memberId: string) => member),
    isAdmin: vi.fn(async () => opts.isAdmin ?? false),
    managesAccount: vi.fn(async (_corporateAccountId: string) => opts.managesAccount ?? false),
  } satisfies FleetDocLookups;
}

describe('authorizeFleetDocUpload', () => {
  it('lets the account manager add a document while the member awaits review', async () => {
    const l = lookups({ managesAccount: true });
    expect(await authorizeFleetDocUpload(CORP, MEMBER, l)).toBe('allowed');
    expect(l.member).toHaveBeenCalledWith(MEMBER);
    expect(l.managesAccount).toHaveBeenCalledWith(CORP);
  });

  it.each(REVIEWED)('refuses the account manager once the member is %s', async (status) => {
    const l = lookups({ member: { corporateAccountId: CORP, status }, managesAccount: true });
    expect(await authorizeFleetDocUpload(CORP, MEMBER, l)).toBe('member_reviewed');
  });

  it.each(['pending_review', ...REVIEWED])('lets a platform admin write when the member is %s', async (status) => {
    const l = lookups({ member: { corporateAccountId: CORP, status }, isAdmin: true });
    expect(await authorizeFleetDocUpload(CORP, MEMBER, l)).toBe('allowed');
  });

  it('forbids a caller who does not manage the account without saying whether the member was reviewed', async () => {
    const l = lookups({ member: { corporateAccountId: CORP, status: 'approved' } });
    expect(await authorizeFleetDocUpload(CORP, MEMBER, l)).toBe('forbidden');
  });

  it("forbids a path naming another account than the member's, even to an admin", async () => {
    const l = lookups({ member: { corporateAccountId: CORP, status: 'pending_review' }, isAdmin: true });
    expect(await authorizeFleetDocUpload(OTHER_CORP, MEMBER, l)).toBe('forbidden');
  });

  it('forbids a member whose fleet has no account', async () => {
    const l = lookups({ member: { corporateAccountId: null, status: 'pending_review' }, isAdmin: true });
    expect(await authorizeFleetDocUpload(CORP, MEMBER, l)).toBe('forbidden');
  });

  it('forbids a member that does not exist', async () => {
    const l = lookups({ member: null, isAdmin: true });
    expect(await authorizeFleetDocUpload(CORP, MEMBER, l)).toBe('forbidden');
  });

  it('forbids a path without both ids and looks nothing up', async () => {
    const l = lookups({ isAdmin: true, managesAccount: true });
    expect(await authorizeFleetDocUpload('', MEMBER, l)).toBe('forbidden');
    expect(await authorizeFleetDocUpload(CORP, '', l)).toBe('forbidden');
    expect(l.member).not.toHaveBeenCalled();
  });

  it('fails closed when a lookup fails', async () => {
    const l = lookups({ managesAccount: true });
    l.member.mockRejectedValueOnce(new Error('connection failure'));
    await expect(authorizeFleetDocUpload(CORP, MEMBER, l)).rejects.toThrow('connection failure');
  });
});

describe('storageUpsert', () => {
  const FLEET_DOC = ['fleet-docs', CORP, MEMBER, '1790000000000-licencia.jpg'];

  it('never replaces a file under fleet-docs/, even when the caller asks to', () => {
    expect(storageUpsert('driver-documents', FLEET_DOC, true)).toBe(false);
    expect(storageUpsert('driver-documents', FLEET_DOC, false)).toBe(false);
  });

  it("keeps the caller's flag anywhere else", () => {
    // driver-docs/ still overwrites on purpose: installed driver apps re-upload
    // under the gallery file name and rely on it. Closing it needs its own rollout.
    const driverDoc = ['driver-docs', '00000000-0000-4000-8000-000000000301', 'drivers_license', 'IMG_1234.jpg'];
    expect(storageUpsert('driver-documents', driverDoc, true)).toBe(true);
    expect(storageUpsert('driver-documents', driverDoc, false)).toBe(false);
    expect(storageUpsert('avatars', ['00000000-0000-4000-8000-000000000401', 'avatar.jpg'], true)).toBe(true);
  });
});
